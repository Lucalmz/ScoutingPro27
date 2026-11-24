package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.routes.ai.AiUrlGuard;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.ai.GeminiLiveRelaySession;
import com.bear27570.app.util.ai.OpenAiRealtimeRelaySession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

public class AiVoiceRoutesTest {

    @TempDir
    Path tempDir;

    private Jdbi jdbi;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private Javalin mockUpstream;
    private String prevDataDir;

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();
        AESUtil.initMasterKey();

        String url = "jdbc:h2:mem:voice_test_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> {
            config.http.maxRequestSize = 15_000_000L;
            config.jetty.modifyWebSocketServletFactory(factory -> {
                factory.setMaxTextMessageSize(2 * 1024 * 1024);
                factory.setMaxBinaryMessageSize(2 * 1024 * 1024);
                factory.setIdleTimeout(Duration.ofMinutes(5));
            });
            apiRoutes.register(config.routes);
        }).start(0);
    }

    @AfterEach
    void tearDown() throws Exception {
        try {
            if (mockUpstream != null) {
                mockUpstream.stop();
            }
            if (apiRoutes != null) {
                apiRoutes.shutdown();
            }
            if (app != null) {
                app.stop();
            }
            JdbiConfig.closeDataSources();
        } finally {
            AESUtil.resetForTest();
            JwtUtil.resetForTest();
            if (prevDataDir == null) {
                System.clearProperty("scouting.data.dir");
            } else {
                System.setProperty("scouting.data.dir", prevDataDir);
            }
        }
    }

    @Test
    void testUrlResolversAndWebSocketSsrfGuard() {
        assertThat(AiUrlGuard.isSafeWebSocketUrl("wss://generativelanguage.googleapis.com/ws/test")).isTrue();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("ws://localhost:8080/ws/test")).isTrue();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("ws://127.0.0.1:9000/ws/test")).isTrue();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("ws://192.168.1.50/ws/test")).isFalse();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("ws://10.0.0.5/ws/test")).isFalse();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("ws://169.254.169.254/latest")).isFalse();
        assertThat(AiUrlGuard.isSafeWebSocketUrl("https://api.openai.com")).isFalse();

        assertThat(GeminiLiveRelaySession.resolveWebSocketUrl(null))
                .isEqualTo("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
        assertThat(GeminiLiveRelaySession.resolveWebSocketUrl("https://proxy.example.com/v1alpha/"))
                .isEqualTo("wss://proxy.example.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent");

        assertThat(OpenAiRealtimeRelaySession.resolveWebSocketUrl(null, "gpt-realtime"))
                .isEqualTo("wss://api.openai.com/v1/realtime?model=gpt-realtime");
        assertThat(OpenAiRealtimeRelaySession.resolveWebSocketUrl("http://localhost:9000/v1", "gpt-realtime-mini"))
                .isEqualTo("ws://localhost:9000/v1/realtime?model=gpt-realtime-mini");
    }

    @Test
    void testWsVoiceRejectsUnauthorizedAndSsrf() throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        String wsUrl = "ws://localhost:" + app.port() + "/ws/ai/voice";

        BlockingQueue<String> unauthMsgs = new LinkedBlockingQueue<>();
        WebSocket unauthWs = http.newWebSocketBuilder()
                .buildAsync(URI.create(wsUrl), new QueueListener(unauthMsgs))
                .get(5, TimeUnit.SECONDS);

        unauthWs.sendText("{\"type\":\"start\",\"token\":\"bad.jwt.token\",\"provider\":\"GEMINI\"}", true).join();
        String unauthErr = unauthMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(unauthErr).isNotNull();
        JsonObject unauthJson = JsonParser.parseString(unauthErr).getAsJsonObject();
        assertThat(unauthJson.get("type").getAsString()).isEqualTo("error");
        assertThat(unauthJson.get("code").getAsString()).isEqualTo("UNAUTHORIZED");
        unauthWs.abort();

        // Register user & save profile with unsafe private IP via direct DB update? Wait: profile save blocks SSRF,
        // so test transcribe SSRF and missing profile on WS as well.
        String[] auth = registerUser("voice_sec_user", "secret123");
        String userId = auth[0];
        String token = auth[1];

        BlockingQueue<String> missingMsgs = new LinkedBlockingQueue<>();
        WebSocket missingWs = http.newWebSocketBuilder()
                .buildAsync(URI.create(wsUrl), new QueueListener(missingMsgs))
                .get(5, TimeUnit.SECONDS);
        missingWs.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"nonexistent\"}", true).join();
        String missingErr = missingMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(missingErr).isNotNull();
        assertThat(JsonParser.parseString(missingErr).getAsJsonObject().get("code").getAsString())
                .isEqualTo("PROFILE_NOT_FOUND");
        missingWs.abort();

        // Insert a private-IP profile directly in DB to ensure WS relay enforces SSRF defense-in-depth
        jdbi.useHandle(h -> h.execute(
                "INSERT INTO ai_provider_profiles (id, user_id, name, preset_id, protocol, api_key_encrypted, base_url, model_name, is_active) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                "prof-ssrf", userId, "Unsafe", "custom", "GEMINI", AESUtil.encrypt("AIzaDummyKey123456"), "http://192.168.1.99/v1beta", "gemini-3.8-live", false
        ));

        BlockingQueue<String> ssrfMsgs = new LinkedBlockingQueue<>();
        WebSocket ssrfWs = http.newWebSocketBuilder()
                .buildAsync(URI.create(wsUrl), new QueueListener(ssrfMsgs))
                .get(5, TimeUnit.SECONDS);
        ssrfWs.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"prof-ssrf\"}", true).join();
        String ssrfErr = ssrfMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(ssrfErr).isNotNull();
        assertThat(JsonParser.parseString(ssrfErr).getAsJsonObject().get("code").getAsString())
                .isEqualTo("FORBIDDEN_URL");
        ssrfWs.abort();
    }

    @Test
    void testGeminiLiveFullDuplexRelayWithBinaryFramesAndLargeContext() throws Exception {
        AtomicReference<String> capturedApiKeyHeader = new AtomicReference<>();
        List<JsonObject> upstreamReceived = new CopyOnWriteArrayList<>();

        mockUpstream = Javalin.create(cfg -> {
            cfg.jetty.modifyWebSocketServletFactory(f -> f.setMaxTextMessageSize(2 * 1024 * 1024));
            cfg.routes.ws("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", ws -> {
                ws.onConnect(ctx -> capturedApiKeyHeader.set(ctx.header("x-goog-api-key")));
                ws.onMessage(ctx -> {
                    JsonObject obj = JsonParser.parseString(ctx.message()).getAsJsonObject();
                    upstreamReceived.add(obj);
                    if (obj.has("setup")) {
                        // Send setupComplete as a BINARY UTF-8 frame (mirrors real Google Gemini Live behavior)
                        ctx.send(ByteBuffer.wrap("{\"setupComplete\":{}}".getBytes(StandardCharsets.UTF_8)));
                    } else if (obj.has("realtimeInput")) {
                        JsonObject rt = obj.getAsJsonObject("realtimeInput");
                        if (rt.has("audio")) {
                            String pcmOut = Base64.getEncoder().encodeToString(new byte[]{1, 2, 3, 4});
                            String serverReply = "{"
                                    + "\"serverContent\":{"
                                    + "\"inputTranscription\":{\"text\":\"Compare Team 27570\"},"
                                    + "\"outputTranscription\":{\"text\":\"Team 27570 averages 148 points.\"},"
                                    + "\"modelTurn\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"audio/pcm;rate=24000\",\"data\":\"" + pcmOut + "\"}}]},"
                                    + "\"turnComplete\":true"
                                    + "}"
                                    + "}";
                            ctx.send(ByteBuffer.wrap(serverReply.getBytes(StandardCharsets.UTF_8)));
                        } else if (rt.has("text")) {
                            String interruptedReply = "{\"serverContent\":{\"interrupted\":true}}";
                            ctx.send(ByteBuffer.wrap(interruptedReply.getBytes(StandardCharsets.UTF_8)));
                        }
                    }
                });
            });
        }).start(0);

        String[] auth = registerUser("gemini_live_user", "secret123");
        String userId = auth[0];
        String token = auth[1];

        String profileId = createProfile(userId, token, "Gemini Live Profile", "GEMINI",
                "AIzaSyTestLiveKey1234567890", "http://localhost:" + mockUpstream.port() + "/v1beta", "gemini-flash-latest");

        HttpClient http = HttpClient.newHttpClient();
        BlockingQueue<String> clientMsgs = new LinkedBlockingQueue<>();
        WebSocket clientWs = http.newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + app.port() + "/ws/ai/voice"), new QueueListener(clientMsgs))
                .get(5, TimeUnit.SECONDS);

        // Include >70KB systemPrompt to also verify Jetty 2MB WS frame limit works end-to-end
        String largePrompt = "You are BIOBUZZ Tactical Copilot. " + "ContextLine ".repeat(6500);
        JsonObject startPayload = new JsonObject();
        startPayload.addProperty("type", "start");
        startPayload.addProperty("token", token);
        startPayload.addProperty("profileId", profileId);
        startPayload.addProperty("model", "gemini-3.8-live");
        startPayload.addProperty("voice", "Kore");
        startPayload.addProperty("systemPrompt", largePrompt);
        JsonArray history = new JsonArray();
        JsonObject h1 = new JsonObject();
        h1.addProperty("role", "user");
        h1.addProperty("content", "Prior scouting question");
        history.add(h1);
        startPayload.add("history", history);

        clientWs.sendText(startPayload.toString(), true).join();

        String readyRaw = clientMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(readyRaw).isNotNull();
        JsonObject ready = JsonParser.parseString(readyRaw).getAsJsonObject();
        assertThat(ready.get("type").getAsString()).isEqualTo("ready");
        assertThat(ready.get("engine").getAsString()).isEqualTo("gemini-live");
        assertThat(ready.get("model").getAsString()).isEqualTo("gemini-3.8-live");
        assertThat(ready.get("inputSampleRate").getAsInt()).isEqualTo(16000);
        assertThat(capturedApiKeyHeader.get()).isEqualTo("AIzaSyTestLiveKey1234567890");

        // Verify setup + seeded history sent to Gemini upstream
        assertThat(upstreamReceived).isNotEmpty();
        JsonObject setup = upstreamReceived.get(0).getAsJsonObject("setup");
        assertThat(setup.get("model").getAsString()).isEqualTo("models/gemini-3.8-live");
        assertThat(setup.getAsJsonObject("generationConfig").has("thinkingConfig")).isFalse();
        assertThat(setup.has("inputAudioTranscription")).isTrue();
        assertThat(setup.has("outputAudioTranscription")).isTrue();
        assertThat(setup.has("contextWindowCompression")).isTrue();

        // Stream audio chunk
        String pcmIn = Base64.getEncoder().encodeToString(new byte[]{10, 20, 30, 40});
        clientWs.sendText("{\"type\":\"audio\",\"data\":\"" + pcmIn + "\"}", true).join();

        boolean sawAudio = false;
        boolean sawUserTranscript = false;
        boolean sawAssistantTranscript = false;
        boolean sawTurnComplete = false;
        for (int i = 0; i < 6; i++) {
            String m = clientMsgs.poll(5, TimeUnit.SECONDS);
            assertThat(m).isNotNull();
            JsonObject evt = JsonParser.parseString(m).getAsJsonObject();
            String type = evt.get("type").getAsString();
            switch (type) {
                case "audio" -> {
                    sawAudio = true;
                    assertThat(evt.get("sampleRate").getAsInt()).isEqualTo(24000);
                }
                case "transcript" -> {
                    if ("user".equals(evt.get("role").getAsString())) {
                        sawUserTranscript = true;
                        assertThat(evt.get("text").getAsString()).contains("27570");
                    } else if ("assistant".equals(evt.get("role").getAsString())) {
                        sawAssistantTranscript = true;
                        assertThat(evt.get("text").getAsString()).contains("148");
                    }
                }
                case "turn_complete" -> sawTurnComplete = true;
            }
            if (sawAudio && sawUserTranscript && sawAssistantTranscript && sawTurnComplete) {
                break;
            }
        }
        assertThat(sawAudio).isTrue();
        assertThat(sawUserTranscript).isTrue();
        assertThat(sawAssistantTranscript).isTrue();
        assertThat(sawTurnComplete).isTrue();

        // Verify mid-call text & interrupted signal
        clientWs.sendText("{\"type\":\"text\",\"text\":\"Stop and focus on #12345\"}", true).join();
        String interruptedRaw = clientMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(interruptedRaw).isNotNull();
        assertThat(JsonParser.parseString(interruptedRaw).getAsJsonObject().get("type").getAsString())
                .isEqualTo("interrupted");

        clientWs.sendText("{\"type\":\"stop\"}", true).join();
        clientWs.abort();
    }

    @Test
    void testOpenAiRealtimeGaRelayRoundtrip() throws Exception {
        AtomicReference<String> authHeader = new AtomicReference<>();
        AtomicReference<String> betaHeader = new AtomicReference<>();
        List<JsonObject> upstreamReceived = new CopyOnWriteArrayList<>();
        CountDownLatch sessionUpdateArrived = new CountDownLatch(1);

        mockUpstream = Javalin.create(cfg -> cfg.routes.ws("/v1/realtime", ws -> {
            ws.onConnect(ctx -> {
                authHeader.set(ctx.header("Authorization"));
                betaHeader.set(ctx.header("OpenAI-Beta"));
                ctx.send("{\"type\":\"session.created\",\"session\":{\"id\":\"sess_1\"}}");
            });
            ws.onMessage(ctx -> {
                JsonObject obj = JsonParser.parseString(ctx.message()).getAsJsonObject();
                upstreamReceived.add(obj);
                String t = obj.get("type").getAsString();
                if ("session.update".equals(t)) {
                    sessionUpdateArrived.countDown();
                } else if ("input_audio_buffer.append".equals(t)) {
                    String pcmOut = Base64.getEncoder().encodeToString(new byte[]{5, 6, 7, 8});
                    ctx.send("{\"type\":\"response.output_audio.delta\",\"delta\":\"" + pcmOut + "\"}");
                    ctx.send("{\"type\":\"response.output_audio_transcript.delta\",\"delta\":\"Pick Team 27570.\"}");
                    ctx.send("{\"type\":\"response.done\"}");
                } else if ("response.cancel".equals(t)) {
                    ctx.send("{\"type\":\"input_audio_buffer.speech_started\"}");
                }
            });
        })).start(0);

        String[] auth = registerUser("openai_rt_user", "secret123");
        String userId = auth[0];
        String token = auth[1];

        String profileId = createProfile(userId, token, "OpenAI Realtime", "OPENAI",
                "sk-proj-test-realtime-12345", "http://localhost:" + mockUpstream.port() + "/v1", "gpt-4o");

        HttpClient http = HttpClient.newHttpClient();
        BlockingQueue<String> clientMsgs = new LinkedBlockingQueue<>();
        WebSocket clientWs = http.newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + app.port() + "/ws/ai/voice"), new QueueListener(clientMsgs))
                .get(5, TimeUnit.SECONDS);

        clientWs.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"" + profileId + "\",\"model\":\"gpt-realtime\",\"voice\":\"coral\",\"systemPrompt\":\"Be concise\"}", true).join();

        String readyRaw = clientMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(readyRaw).isNotNull();
        JsonObject ready = JsonParser.parseString(readyRaw).getAsJsonObject();
        assertThat(ready.get("type").getAsString()).isEqualTo("ready");
        assertThat(ready.get("engine").getAsString()).isEqualTo("openai-realtime");
        assertThat(ready.get("inputSampleRate").getAsInt()).isEqualTo(24000);
        assertThat(authHeader.get()).isEqualTo("Bearer sk-proj-test-realtime-12345");
        // GA models must NOT send OpenAI-Beta header
        assertThat(betaHeader.get()).isNull();

        // Confirm GA session.update schema
        assertThat(sessionUpdateArrived.await(5, TimeUnit.SECONDS)).isTrue();
        JsonObject sessionUpdate = upstreamReceived.stream()
                .filter(o -> "session.update".equals(o.get("type").getAsString()))
                .findFirst()
                .orElseThrow();
        JsonObject sessionObj = sessionUpdate.getAsJsonObject("session");
        assertThat(sessionObj.get("type").getAsString()).isEqualTo("realtime");
        assertThat(sessionObj.has("audio")).isTrue();
        assertThat(sessionObj.getAsJsonObject("audio").getAsJsonObject("output").get("voice").getAsString()).isEqualTo("coral");

        String pcmIn = Base64.getEncoder().encodeToString(new byte[]{1, 2, 3, 4});
        clientWs.sendText("{\"type\":\"audio\",\"data\":\"" + pcmIn + "\"}", true).join();

        boolean sawAudio = false;
        boolean sawTranscript = false;
        boolean sawDone = false;
        for (int i = 0; i < 4; i++) {
            String m = clientMsgs.poll(5, TimeUnit.SECONDS);
            assertThat(m).isNotNull();
            JsonObject evt = JsonParser.parseString(m).getAsJsonObject();
            switch (evt.get("type").getAsString()) {
                case "audio" -> sawAudio = true;
                case "transcript" -> {
                    sawTranscript = true;
                    assertThat(evt.get("text").getAsString()).contains("27570");
                }
                case "turn_complete" -> sawDone = true;
            }
            if (sawAudio && sawTranscript && sawDone) break;
        }
        assertThat(sawAudio).isTrue();
        assertThat(sawTranscript).isTrue();
        assertThat(sawDone).isTrue();

        clientWs.sendText("{\"type\":\"interrupt\"}", true).join();
        String intMsg = clientMsgs.poll(5, TimeUnit.SECONDS);
        assertThat(JsonParser.parseString(intMsg).getAsJsonObject().get("type").getAsString()).isEqualTo("interrupted");

        clientWs.abort();
    }

    @Test
    void testAudioTranscribeEndpointForOpenAiGeminiAndAnthropic() throws Exception {
        AtomicReference<String> openAiMultipartBody = new AtomicReference<>();
        AtomicReference<String> geminiRequestBody = new AtomicReference<>();

        mockUpstream = Javalin.create(cfg -> {
            cfg.routes.post("/v1/audio/transcriptions", ctx -> {
                openAiMultipartBody.set(new String(ctx.bodyAsBytes(), StandardCharsets.UTF_8));
                ctx.status(200).result("{\"text\":\"Check team 27570 endgame\"}").contentType("application/json");
            });
            cfg.routes.post("/v1beta/models/gemini-flash-latest:generateContent", ctx -> {
                geminiRequestBody.set(ctx.body());
                ctx.status(200)
                        .result("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini heard team 12345\"}]}}]}")
                        .contentType("application/json");
            });
        }).start(0);

        String[] auth = registerUser("stt_user", "secret123");
        String userId = auth[0];
        String token = auth[1];

        String openaiProfId = createProfile(userId, token, "OpenAI STT", "OPENAI",
                "sk-stt-12345", "http://localhost:" + mockUpstream.port() + "/v1", "gpt-4o");
        String geminiProfId = createProfile(userId, token, "Gemini STT", "GEMINI",
                "AIzaSttKey12345", "http://localhost:" + mockUpstream.port() + "/v1beta", "gemini-3.8-live");
        String anthropicProfId = createProfile(userId, token, "Claude", "ANTHROPIC",
                "sk-ant-12345", "https://api.anthropic.com", "claude-sonnet-4-20250514");

        HttpClient http = HttpClient.newHttpClient();
        String baseUrl = "http://localhost:" + app.port();
        String dummyAudio = Base64.getEncoder().encodeToString("RIFFfakewavbytes".getBytes(StandardCharsets.UTF_8));

        // 1. Unauthenticated -> 401
        HttpResponse<String> unauthRes = http.send(
                HttpRequest.newBuilder(URI.create(baseUrl + "/api/ai/audio/transcribe"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"provider\":\"OPENAI\",\"audioBase64\":\"" + dummyAudio + "\"}"))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(unauthRes.statusCode()).isEqualTo(401);

        // 2. OpenAI multipart transcription
        HttpResponse<String> oaRes = postJson(http, baseUrl + "/api/ai/audio/transcribe", token,
                "{\"profileId\":\"" + openaiProfId + "\",\"audioBase64\":\"" + dummyAudio + "\",\"mimeType\":\"audio/wav\",\"language\":\"en\"}");
        assertThat(oaRes.statusCode()).isEqualTo(200);
        assertThat(JsonParser.parseString(oaRes.body()).getAsJsonObject().get("text").getAsString())
                .isEqualTo("Check team 27570 endgame");
        assertThat(openAiMultipartBody.get()).contains("name=\"file\"; filename=\"recording.wav\"");
        assertThat(openAiMultipartBody.get()).contains("whisper-1");

        // 3. Gemini inline_data transcription (auto-falls back from gemini-3.8-live to gemini-flash-latest)
        HttpResponse<String> gemRes = postJson(http, baseUrl + "/api/ai/audio/transcribe", token,
                "{\"profileId\":\"" + geminiProfId + "\",\"audioBase64\":\"" + dummyAudio + "\",\"mimeType\":\"audio/wav\",\"language\":\"zh\"}");
        assertThat(gemRes.statusCode()).isEqualTo(200);
        assertThat(JsonParser.parseString(gemRes.body()).getAsJsonObject().get("text").getAsString())
                .isEqualTo("Gemini heard team 12345");
        assertThat(geminiRequestBody.get()).contains("inline_data");
        assertThat(geminiRequestBody.get()).contains("audio/wav");

        // 4. Anthropic rejected with 400
        HttpResponse<String> antRes = postJson(http, baseUrl + "/api/ai/audio/transcribe", token,
                "{\"profileId\":\"" + anthropicProfId + "\",\"audioBase64\":\"" + dummyAudio + "\"}");
        assertThat(antRes.statusCode()).isEqualTo(400);
        assertThat(antRes.body()).contains("Anthropic protocol does not support audio transcription");
    }

    private String[] registerUser(String username, String password) throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + app.port() + "/api/user/register"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}"))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(res.statusCode()).isEqualTo(200);
        JsonObject obj = JsonParser.parseString(res.body()).getAsJsonObject();
        return new String[]{obj.get("id").getAsString(), obj.get("token").getAsString()};
    }

    private String createProfile(String userId, String token, String name, String protocol, String apiKey, String baseUrl, String modelName) throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        JsonObject body = new JsonObject();
        body.addProperty("name", name);
        body.addProperty("protocol", protocol);
        body.addProperty("apiKey", apiKey);
        body.addProperty("baseUrl", baseUrl);
        body.addProperty("modelName", modelName);
        body.addProperty("isActive", true);

        HttpResponse<String> res = postJson(http, "http://localhost:" + app.port() + "/api/users/" + userId + "/ai-profiles", token, body.toString());
        assertThat(res.statusCode()).isEqualTo(200);
        return JsonParser.parseString(res.body()).getAsJsonObject().get("id").getAsString();
    }

    private static HttpResponse<String> postJson(HttpClient http, String url, String token, String json) throws Exception {
        return http.send(
                HttpRequest.newBuilder(URI.create(url))
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + token)
                        .POST(HttpRequest.BodyPublishers.ofString(json))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
    }

    private static final class QueueListener implements WebSocket.Listener {
        private final BlockingQueue<String> queue;
        private final StringBuilder buf = new StringBuilder();

        QueueListener(BlockingQueue<String> queue) {
            this.queue = queue;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buf.append(data);
            if (last) {
                queue.offer(buf.toString());
                buf.setLength(0);
            }
            webSocket.request(1);
            return null;
        }
    }
}
