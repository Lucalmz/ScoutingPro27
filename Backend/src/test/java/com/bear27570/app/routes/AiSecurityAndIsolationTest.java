package com.bear27570.app.routes;

import com.bear27570.app.dao.AiProviderProfileDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.routes.ai.AiUrlGuard;
import com.bear27570.app.routes.ai.AiVoiceRoutes;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.ai.AiProxyResolver;
import com.bear27570.app.util.ai.AiVoiceRelaySession;
import com.bear27570.app.util.ai.OpenAiProtocolAdapter;
import com.bear27570.app.util.ai.OpenAiRealtimeRelaySession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class AiSecurityAndIsolationTest {

    @TempDir
    Path tempDir;

    private Jdbi jdbi;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();
        AESUtil.initMasterKey();

        String url = "jdbc:h2:mem:ai_sec_test_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() throws Exception {
        try {
            if (apiRoutes != null) {
                apiRoutes.shutdown();
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
    void testThreadAndProfileIdorProtection() {
        JavalinTest.test(app, (server, client) -> {
            // Register User A and User B
            JsonObject regA = JsonParser.parseString(client.post("/api/user/register",
                    "{\"username\":\"user_a\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
            String tokenA = regA.get("token").getAsString();
            String userIdA = regA.get("id").getAsString();

            JsonObject regB = JsonParser.parseString(client.post("/api/user/register",
                    "{\"username\":\"user_b\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
            String tokenB = regB.get("token").getAsString();
            String userIdB = regB.get("id").getAsString();

            // User A creates Event E1 & E2; User B joins E1
            JsonObject evt1 = JsonParser.parseString(client.post("/api/events", "{\"name\":\"Event 1\"}",
                    b -> b.header("Authorization", "Bearer " + tokenA)).body().string()).getAsJsonObject();
            String eventId1 = evt1.get("id").getAsString();
            String inviteCode1 = evt1.get("inviteCode").getAsString();

            assertThat(client.post("/api/events/join", "{\"inviteCode\":\"" + inviteCode1 + "\"}",
                    b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(200);

            JsonObject evt2 = JsonParser.parseString(client.post("/api/events", "{\"name\":\"Event 2\"}",
                    b -> b.header("Authorization", "Bearer " + tokenA)).body().string()).getAsJsonObject();
            String eventId2 = evt2.get("id").getAsString();

            // User A creates thread "thr-shared-id" in Event 1
            var createThrRes = client.post("/api/events/" + eventId1 + "/ai-threads",
                    "{\"id\":\"thr-shared-id\",\"title\":\"Secret Strategy\",\"messages\":[{\"id\":\"m1\",\"role\":\"user\",\"content\":\"Secret\"}]}",
                    b -> b.header("Authorization", "Bearer " + tokenA));
            assertThat(createThrRes.code()).isEqualTo(200);

            // User B (same event member) cannot hijack via POST, PUT, GET, or DELETE
            assertThat(client.post("/api/events/" + eventId1 + "/ai-threads",
                    "{\"id\":\"thr-shared-id\",\"title\":\"Hijacked\"}",
                    b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
            assertThat(client.put("/api/events/" + eventId1 + "/ai-threads/thr-shared-id",
                    "{\"title\":\"Hijacked\"}",
                    b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
            assertThat(client.get("/api/events/" + eventId1 + "/ai-threads/thr-shared-id",
                    b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
            assertThat(client.delete("/api/events/" + eventId1 + "/ai-threads/thr-shared-id", null,
                    b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);

            // User A cannot overwrite thread across events (E2 trying to reuse E1's thread id)
            assertThat(client.post("/api/events/" + eventId2 + "/ai-threads",
                    "{\"id\":\"thr-shared-id\",\"title\":\"Cross Event\"}",
                    b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(409);
            assertThat(client.put("/api/events/" + eventId2 + "/ai-threads/thr-shared-id",
                    "{\"title\":\"Cross Event\"}",
                    b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(409);

            // Original thread in E1 remains intact
            var getRes = client.get("/api/events/" + eventId1 + "/ai-threads/thr-shared-id",
                    b -> b.header("Authorization", "Bearer " + tokenA));
            assertThat(getRes.code()).isEqualTo(200);
            assertThat(getRes.body().string()).contains("Secret Strategy");

            // Profile IDOR: User A creates profile "prof-shared-id"
            var createProfRes = client.post("/api/users/" + userIdA + "/ai-profiles",
                    "{\"id\":\"prof-shared-id\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-user-a-key\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + tokenA));
            assertThat(createProfRes.code()).isEqualTo(200);

            // User B tries to overwrite "prof-shared-id" under their own user path -> 403
            var hijackProfRes = client.post("/api/users/" + userIdB + "/ai-profiles",
                    "{\"id\":\"prof-shared-id\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-evil\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + tokenB));
            assertThat(hijackProfRes.code()).isEqualTo(403);
        });
    }

    @Test
    void testSsrfAndProxyGuardBlocksPrivateAndMetadataRanges() {
        // Blocked URLs
        assertThat(AiUrlGuard.isSafeUrl("http://127.0.0.2:8080/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://0.0.0.0:8080/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://10.0.0.1/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://172.16.0.1/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://192.168.1.1/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://169.254.169.254/latest/meta-data/")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://100.64.0.1/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://100.100.100.200/latest/meta-data/")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[fc00::1]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[fd12:3456::1]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[fe80::1]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[::ffff:127.0.0.1]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[::ffff:169.254.169.254]/v1")).isFalse();
        // Regression #18.2: IPv4-compatible IPv6 ::/96 must also be blocked
        assertThat(AiUrlGuard.isSafeUrl("http://[::169.254.169.254]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[0:0:0:0:0:0:7f00:0002]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("http://[0:0:0:0:0:0:0a00:0001]/v1")).isFalse();
        assertThat(AiUrlGuard.isSafeUrl("https://user:pass@api.openai.com/v1")).isFalse();

        // Allowed URLs
        assertThat(AiUrlGuard.isSafeUrl("http://localhost:11434/v1")).isTrue();
        assertThat(AiUrlGuard.isSafeUrl("http://127.0.0.1:11434/v1")).isTrue();
        assertThat(AiUrlGuard.isSafeUrl("http://[::1]:11434/v1")).isTrue();
        assertThat(AiUrlGuard.isSafeUrl("https://api.openai.com/v1")).isTrue();

        // Proxy host checks
        assertThat(AiUrlGuard.isSafeProxyHost("127.0.0.1")).isTrue();
        assertThat(AiUrlGuard.isSafeProxyHost("localhost")).isTrue();
        assertThat(AiUrlGuard.isSafeProxyHost("192.168.1.50")).isFalse();
        assertThat(AiUrlGuard.isSafeProxyHost("169.254.169.254")).isFalse();
        assertThat(AiUrlGuard.isSafeProxyHost("10.0.0.2")).isFalse();
        assertThat(AiUrlGuard.isSafeProxyHost("fc00::1")).isFalse();

        assertThatThrownBy(() -> AiProxyResolver.resolveEffectiveProxy("192.168.1.1", 8080, "https://api.openai.com"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Forbidden proxyHost");
        assertThatThrownBy(() -> AiProxyResolver.resolveEffectiveProxy("127.0.0.1", 70000, "https://api.openai.com"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid proxy port");

        // Route-level SSRF enforcement on non-streaming /api/ai/chat and legacy /ai-settings
        JavalinTest.test(app, (server, client) -> {
            JsonObject reg = JsonParser.parseString(client.post("/api/user/register",
                    "{\"username\":\"ssrf_user\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
            String token = reg.get("token").getAsString();
            String userId = reg.get("id").getAsString();

            assertThat(client.post("/api/users/" + userId + "/ai-settings",
                    "{\"provider\":\"OPENAI\",\"apiKeyEncrypted\":\"sk-test\",\"baseUrl\":\"http://169.254.169.254\"}",
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);

            assertThat(client.post("/api/users/" + userId + "/ai-settings",
                    "{\"provider\":\"OPENAI\",\"apiKeyEncrypted\":\"sk-test\",\"proxyHost\":\"192.168.1.1\",\"proxyPort\":8080}",
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);

            // Insert a legacy/bypassed profile directly in DB and verify /api/ai/chat (non-streaming) blocks it
            AiProviderProfile unsafeProfile = new AiProviderProfile();
            unsafeProfile.setId("prof-unsafe-ssrf");
            unsafeProfile.setUserId(userId);
            unsafeProfile.setName("Unsafe");
            unsafeProfile.setProtocol("OPENAI");
            unsafeProfile.setApiKeyEncrypted(AESUtil.encrypt("sk-test"));
            unsafeProfile.setBaseUrl("http://169.254.169.254/latest");
            jdbi.useExtension(AiProviderProfileDao.class, dao -> dao.insert(unsafeProfile));

            var chatRes = client.post("/api/ai/chat",
                    "{\"profileId\":\"prof-unsafe-ssrf\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(chatRes.code()).isEqualTo(400);
            assertThat(chatRes.body().string()).contains("SSRF protection blocked access");
        });
    }

    @Test
    void testJsonFieldValidationColumnLengthsAndHeaderSanitization() {
        JavalinTest.test(app, (server, client) -> {
            JsonObject reg = JsonParser.parseString(client.post("/api/user/register",
                    "{\"username\":\"val_user\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
            String token = reg.get("token").getAsString();
            String userId = reg.get("id").getAsString();

            String eventId = JsonParser.parseString(client.post("/api/events", "{\"name\":\"Validation Event\"}",
                    b -> b.header("Authorization", "Bearer " + token)).body().string()).getAsJsonObject().get("id").getAsString();

            // Invalid types & bounds return 400 (never 500)
            var badProfileIdType = client.post("/api/ai/chat",
                    "{\"profileId\":[],\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badProfileIdType.code()).isEqualTo(400);

            var badTemp = client.post("/api/ai/chat",
                    "{\"provider\":\"OPENAI\",\"temperature\":3.5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badTemp.code()).isEqualTo(400);

            var badThinkingType = client.post("/api/ai/chat",
                    "{\"provider\":\"OPENAI\",\"enableThinking\":\"yes\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badThinkingType.code()).isEqualTo(400);

            var badPinned = client.post("/api/events/" + eventId + "/ai-threads",
                    "{\"pinned\":\"not-a-boolean\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badPinned.code()).isEqualTo(400);

            // Profile CR/LF in apiKey or anthropicVersion rejected with 400
            assertThat(client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-abc\\r\\nX-Evil: 1\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);

            assertThat(client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"protocol\":\"ANTHROPIC\",\"apiKey\":\"sk-ant\",\"anthropicVersion\":\"2023-06-01\\nEvil: 1\"}",
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);

            // Overlong profile ID > 128 rejected with 400
            String longId = "p".repeat(129);
            assertThat(client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"id\":\"" + longId + "\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-test\"}",
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);

            // Overlong name (>120) is safely truncated without H2 500
            String longName = "N".repeat(200);
            var okTruncRes = client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"name\":\"" + longName + "\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-test\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(okTruncRes.code()).isEqualTo(200);
            JsonObject savedProf = JsonParser.parseString(okTruncRes.body().string()).getAsJsonObject();
            assertThat(savedProf.get("name").getAsString()).hasSize(120);
        });
    }

    @Test
    void testOpenAiProtocolAdapterMultiVendorThinkingAndQueryStrip() {
        assertThat(OpenAiProtocolAdapter.resolveChatEndpoint("https://api.example.com/v1?foo=bar#frag"))
                .isEqualTo("https://api.example.com/v1/chat/completions");

        JsonArray msgs = new JsonArray();
        JsonObject sfPayload = OpenAiProtocolAdapter.buildStreamPayload(
                "deepseek-ai/DeepSeek-R1", msgs, 0.4, 2048, true, true,
                "https://api.siliconflow.cn/v1", Boolean.TRUE, null);
        assertThat(sfPayload.get("enable_thinking").getAsBoolean()).isTrue();

        JsonObject zhipuPayload = OpenAiProtocolAdapter.buildStreamPayload(
                "glm-4.5", msgs, 0.4, 2048, true, true,
                "https://open.bigmodel.cn/api/paas/v4", Boolean.TRUE, null);
        assertThat(zhipuPayload.getAsJsonObject("thinking").get("type").getAsString()).isEqualTo("enabled");

        JsonObject orPayload = OpenAiProtocolAdapter.buildStreamPayload(
                "anthropic/claude-3.7-sonnet", msgs, 0.4, 2048, true, true,
                "https://openrouter.ai/api/v1", Boolean.TRUE, "high");
        assertThat(orPayload.getAsJsonObject("reasoning").get("effort").getAsString()).isEqualTo("high");
    }

    @Test
    void testRealtimeVoiceVadVsPttAndDuplicateStartAndMimeBase64() throws Exception {
        List<String> upstreamReceived = new CopyOnWriteArrayList<>();
        Javalin mockUpstream = Javalin.create(cfg -> cfg.routes.ws("/v1/realtime", ws -> {
            ws.onConnect(ctx -> ctx.send("{\"type\":\"session.created\",\"session\":{\"id\":\"sess_1\"}}"));
            ws.onMessage(ctx -> upstreamReceived.add(ctx.message()));
        })).start(0);

        Javalin voiceApp = Javalin.create(cfg -> {
            cfg.http.maxRequestSize = 20_000_000L;
            apiRoutes.register(cfg.routes);
        }).start(0);

        try {
            HttpClient http = HttpClient.newHttpClient();
            String regBody = http.send(HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + voiceApp.port() + "/api/user/register"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"voice_sec\",\"password\":\"pass12345\"}"))
                    .build(), HttpResponse.BodyHandlers.ofString()).body();
            JsonObject reg = JsonParser.parseString(regBody).getAsJsonObject();
            String token = reg.get("token").getAsString();
            String userId = reg.get("id").getAsString();

            String profRes = http.send(HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + voiceApp.port() + "/api/users/" + userId + "/ai-profiles"))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"protocol\":\"OPENAI\",\"baseUrl\":\"http://127.0.0.1:" + mockUpstream.port() + "/v1\",\"modelName\":\"gpt-realtime\"}"))
                    .build(), HttpResponse.BodyHandlers.ofString()).body();
            String profileId = JsonParser.parseString(profRes).getAsJsonObject().get("id").getAsString();

            // 1. Test VAD mode: audio_end must NOT send commit/response.create, and duplicate start returns ALREADY_STARTED
            BlockingQueue<String> clientFrames = new LinkedBlockingQueue<>();
            WebSocket ws = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + voiceApp.port() + "/ws/ai/voice"), new WebSocket.Listener() {
                        @Override public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            clientFrames.add(data.toString());
                            webSocket.request(1);
                            return null;
                        }
                    }).get(5, TimeUnit.SECONDS);

            ws.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"" + profileId + "\",\"inputMode\":\"vad\"}", true).join();
            String readyFrame = clientFrames.poll(5, TimeUnit.SECONDS);
            assertThat(readyFrame).isNotNull();
            assertThat(JsonParser.parseString(readyFrame).getAsJsonObject().get("type").getAsString()).isEqualTo("ready");

            // Duplicate start -> ALREADY_STARTED error, session stays open
            ws.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"" + profileId + "\"}", true).join();
            String dupFrame = clientFrames.poll(5, TimeUnit.SECONDS);
            assertThat(JsonParser.parseString(dupFrame).getAsJsonObject().get("code").getAsString()).isEqualTo("ALREADY_STARTED");

            // Send audio_end in vad mode -> no commit/response.create
            ws.sendText("{\"type\":\"audio_end\",\"commit\":true}", true).join();
            Thread.sleep(150);
            assertThat(upstreamReceived.stream().noneMatch(m -> m.contains("input_audio_buffer.commit"))).isTrue();

            // Switch to PTT mode via mode frame -> sends session.update with turn_detection: null
            upstreamReceived.clear();
            ws.sendText("{\"type\":\"mode\",\"inputMode\":\"ptt\"}", true).join();
            Thread.sleep(150);
            assertThat(upstreamReceived.stream().anyMatch(m -> m.contains("\"turn_detection\":null"))).isTrue();

            // Send audio_end in ptt mode -> MUST send commit + response.create
            upstreamReceived.clear();
            ws.sendText("{\"type\":\"audio_end\",\"commit\":true}", true).join();
            Thread.sleep(150);
            assertThat(upstreamReceived.stream().anyMatch(m -> m.contains("input_audio_buffer.commit"))).isTrue();
            assertThat(upstreamReceived.stream().anyMatch(m -> m.contains("response.create"))).isTrue();

            ws.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();

            // 1b. Test invalid WS type field {"type": []} returns BAD_MESSAGE and invalid start {"systemPrompt": []} closes cleanly
            BlockingQueue<String> badFrames = new LinkedBlockingQueue<>();
            CountDownLatch badClosed = new CountDownLatch(1);
            WebSocket badWs = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + voiceApp.port() + "/ws/ai/voice"), new WebSocket.Listener() {
                        @Override public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            badFrames.add(data.toString());
                            webSocket.request(1);
                            return null;
                        }

                        @Override public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                            badClosed.countDown();
                            return null;
                        }
                    }).get(5, TimeUnit.SECONDS);

            badWs.sendText("{\"type\":[]}", true).join();
            String badTypeFrame = badFrames.poll(5, TimeUnit.SECONDS);
            assertThat(badTypeFrame).isNotNull();
            assertThat(JsonParser.parseString(badTypeFrame).getAsJsonObject().get("code").getAsString()).isEqualTo("BAD_MESSAGE");

            badWs.sendText("{\"type\":\"start\",\"token\":\"" + token + "\",\"profileId\":\"" + profileId + "\",\"systemPrompt\":[]}", true).join();
            String badStartFrame = badFrames.poll(5, TimeUnit.SECONDS);
            assertThat(badStartFrame).isNotNull();
            assertThat(JsonParser.parseString(badStartFrame).getAsJsonObject().get("code").getAsString()).isEqualTo("BAD_MESSAGE");
            assertThat(badClosed.await(5, TimeUnit.SECONDS)).isTrue();

            // 2. Test STT Base64 with newlines (MimeDecoder) doesn't fail Base64 decode
            String b64WithNewlines = Base64.getMimeEncoder(16, "\n".getBytes()).encodeToString("fake-wav-bytes-for-test".getBytes());
            HttpResponse<String> sttRes = http.send(HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + voiceApp.port() + "/api/ai/audio/transcribe"))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"profileId\":\"" + profileId + "\",\"audioBase64\":" + new com.google.gson.Gson().toJson(b64WithNewlines) + "}"))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertThat(sttRes.body()).doesNotContain("Invalid audioBase64 encoding");
        } finally {
            voiceApp.stop();
            mockUpstream.stop();
        }
    }

    @Test
    void testCorruptedApiKeyRejectedBaseUrlTrustNormalizationAndThreadPreviewStripping() {
        assertThat(AiUrlGuard.isTrustedSavedUrl("https://api.openai.com/v1/", "https://api.openai.com/v1", "OPENAI")).isTrue();
        assertThat(AiUrlGuard.isTrustedSavedUrl("https://api.openai.com/v1", "", "OPENAI")).isTrue();
        assertThat(AiUrlGuard.isTrustedSavedUrl("https://generativelanguage.googleapis.com/v1beta/", null, "GEMINI")).isTrue();
        assertThat(AiUrlGuard.isTrustedSavedUrl("https://api.anthropic.com/", "", "ANTHROPIC")).isTrue();
        assertThat(AiUrlGuard.isTrustedSavedUrl("https://evil.example.com/v1", "", "OPENAI")).isFalse();

        JavalinTest.test(app, (server, client) -> {
            JsonObject reg = JsonParser.parseString(client.post("/api/user/register",
                    "{\"username\":\"corrupt_key_user\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
            String token = reg.get("token").getAsString();
            String userId = reg.get("id").getAsString();

            var profRes = client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"name\":\"Cloud OpenAI\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-valid-secret-key\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(profRes.code()).isEqualTo(200);
            String profileId = JsonParser.parseString(profRes.body().string()).getAsJsonObject().get("id").getAsString();

            // Corrupt the stored ciphertext in both ai_provider_profiles and legacy ai_settings
            jdbi.useHandle(h -> {
                h.createUpdate("UPDATE ai_provider_profiles SET api_key_encrypted = 'corrupted-not-decryptable' WHERE id = :id")
                        .bind("id", profileId).execute();
                h.createUpdate("INSERT INTO ai_settings (user_id, provider, api_key_encrypted, base_url) VALUES (:uid, 'OPENAI', 'corrupted-legacy', 'https://api.openai.com/v1')")
                        .bind("uid", userId).execute();
            });

            // GET surfaces ERR_KEY_LOST and hasApiKey=false
            var getProf = client.get("/api/users/" + userId + "/ai-profiles",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(getProf.code()).isEqualTo(200);
            assertThat(getProf.body().string()).contains("ERR_KEY_LOST");

            // Saving without entering a new key MUST fail 400 (never silently preserve corrupted ciphertext)
            var saveBlank = client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"id\":\"" + profileId + "\",\"protocol\":\"OPENAI\",\"apiKeyEncrypted\":\"\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(saveBlank.code()).isEqualTo(400);
            assertThat(saveBlank.body().string()).contains("could not be decrypted");

            var legacySaveBlank = client.post("/api/users/" + userId + "/ai-settings",
                    "{\"provider\":\"OPENAI\",\"apiKeyEncrypted\":\"\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(legacySaveBlank.code()).isEqualTo(400);
            assertThat(legacySaveBlank.body().string()).contains("could not be decrypted");

            // Saving with a valid new key recovers cleanly
            var saveRecovered = client.post("/api/users/" + userId + "/ai-profiles",
                    "{\"id\":\"" + profileId + "\",\"protocol\":\"OPENAI\",\"apiKey\":\"sk-recovered-key-9999\",\"baseUrl\":\"https://api.openai.com/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(saveRecovered.code()).isEqualTo(200);
            assertThat(saveRecovered.body().string()).contains("\"hasApiKey\":true");

            // Thread summary preview strips sp27-action JSON fences & falls back to turboActions summary
            String eventId = JsonParser.parseString(client.post("/api/events", "{\"name\":\"Preview Strip Event\"}",
                    b -> b.header("Authorization", "Bearer " + token)).body().string()).getAsJsonObject().get("id").getAsString();

            String thread1Payload = """
                    {
                      "title": "Action + Prose",
                      "messages": [
                        {"id":"u1","role":"user","content":"Ban 111"},
                        {"id":"a1","role":"assistant","content":"Done banning team.\\n```sp27-action\\n{\\"actions\\":[{\\"type\\":\\"ban_team\\",\\"teamNumber\\":111}]}\\n```"}
                      ]
                    }
                    """;
            assertThat(client.post("/api/events/" + eventId + "/ai-threads", thread1Payload,
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);

            String thread2Payload = """
                    {
                      "title": "Action Only",
                      "messages": [
                        {"id":"u2","role":"user","content":"Tag 27570"},
                        {
                          "id":"a2",
                          "role":"assistant",
                          "content":"```sp27-action\\n{\\"actions\\":[{\\"type\\":\\"add_tag\\",\\"teamNumber\\":27570}]}\\n```",
                          "turboActions":[{"id":"act1","type":"add_tag","status":"success","summary":"Added fast tag to #27570"}]
                        }
                      ]
                    }
                    """;
            assertThat(client.post("/api/events/" + eventId + "/ai-threads", thread2Payload,
                    b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);

            var listRes = client.get("/api/events/" + eventId + "/ai-threads",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(listRes.code()).isEqualTo(200);
            String listBody = listRes.body().string();
            assertThat(listBody).doesNotContain("sp27-action");
            assertThat(listBody).doesNotContain("ban_team");
            assertThat(listBody).contains("Done banning team.");
            assertThat(listBody).contains("[Turbo] Added fast tag to #27570");
        });
    }

    @Test
    void testProfilesThreadsProbeAndNonStreamChatComprehensiveEdges() throws Exception {
        com.sun.net.httpserver.HttpServer mockServer = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        java.util.concurrent.atomic.AtomicReference<String> probeAuth = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicInteger probeStatus = new java.util.concurrent.atomic.AtomicInteger(200);
        java.util.concurrent.atomic.AtomicBoolean emitEmptyChat = new java.util.concurrent.atomic.AtomicBoolean(false);
        mockServer.createContext("/v1/models", ex -> {
            probeAuth.set(ex.getRequestHeaders().getFirst("Authorization"));
            int st = probeStatus.get();
            byte[] body = st == 200
                    ? "{\"data\":[{\"id\":\"gpt-4o\"}]}".getBytes(java.nio.charset.StandardCharsets.UTF_8)
                    : "{\"error\":\"unauthorized\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(st, body.length);
            try (var os = ex.getResponseBody()) { os.write(body); }
        });
        mockServer.createContext("/v1/chat/completions", ex -> {
            ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            ex.sendResponseHeaders(200, 0);
            try (var os = ex.getResponseBody()) {
                String payload = emitEmptyChat.get()
                        ? "data: [DONE]\n\n"
                        : "data: {\"choices\":[{\"delta\":{\"content\":\"Non-stream reply\"}}]}\n\ndata: [DONE]\n\n";
                os.write(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        });
        mockServer.start();
        int port = mockServer.getAddress().getPort();

        try {
            JavalinTest.test(app, (server, client) -> {
                // Schema bootstrap idempotency
                com.bear27570.app.routes.ai.AiSchemaBootstrap.ensureAiCopilotSchema(jdbi);

                JsonObject regA = JsonParser.parseString(client.post("/api/user/register",
                        "{\"username\":\"prof_a\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
                String tokenA = regA.get("token").getAsString();
                String userIdA = regA.get("id").getAsString();

                JsonObject regB = JsonParser.parseString(client.post("/api/user/register",
                        "{\"username\":\"prof_b\",\"password\":\"pass12345\"}").body().string()).getAsJsonObject();
                String tokenB = regB.get("token").getAsString();

                // Cross-user 403 isolation on profiles & legacy settings
                assertThat(client.get("/api/users/" + userIdA + "/ai-settings", b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
                assertThat(client.post("/api/users/" + userIdA + "/ai-settings", "{}", b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
                assertThat(client.get("/api/users/" + userIdA + "/ai-profiles", b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{}", b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles/p1/activate", "{}", b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);
                assertThat(client.delete("/api/users/" + userIdA + "/ai-profiles/p1", null, b -> b.header("Authorization", "Bearer " + tokenB)).code()).isEqualTo(403);

                // Profile validation errors -> 400
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "[]", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{bad", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"BOGUS\"}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-1\",\"baseUrl\":\"https://api.openai.com/" + "a".repeat(500) + "\"}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-1\",\"proxyHost\":\"192.168.1.5\",\"proxyPort\":8080}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-1\",\"proxyPort\":70000}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-1\",\"temperature\":-0.5}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles", "{\"protocol\":\"OPENAI\",\"baseUrl\":\"https://api.openai.com/v1\"}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);

                // Short key masking ("****") + local OpenAI clearApiKey:true
                var localRes = client.post("/api/users/" + userIdA + "/ai-profiles",
                        "{\"protocol\":\"OPENAI\",\"apiKey\":\"short\",\"baseUrl\":\"http://127.0.0.1:" + port + "/v1\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(localRes.code()).isEqualTo(200);
                JsonObject localObj = JsonParser.parseString(localRes.body().string()).getAsJsonObject();
                assertThat(localObj.get("apiKeyEncrypted").getAsString()).isEqualTo("****");
                String localId = localObj.get("id").getAsString();

                var clearedRes = client.post("/api/users/" + userIdA + "/ai-profiles",
                        "{\"id\":\"" + localId + "\",\"protocol\":\"OPENAI\",\"clearApiKey\":true,\"baseUrl\":\"http://127.0.0.1:" + port + "/v1\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(clearedRes.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(clearedRes.body().string()).getAsJsonObject().get("hasApiKey").getAsBoolean()).isFalse();

                // Second profile + activate + delete active fallback + delete last
                var secondRes = client.post("/api/users/" + userIdA + "/ai-profiles",
                        "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-second-key-1234\",\"baseUrl\":\"http://localhost:" + port + "/v1\",\"isActive\":true}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(secondRes.code()).isEqualTo(200);
                String secondId = JsonParser.parseString(secondRes.body().string()).getAsJsonObject().get("id").getAsString();

                assertThat(client.post("/api/users/" + userIdA + "/ai-profiles/nonexistent/activate", "{}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(404);
                assertThat(client.delete("/api/users/" + userIdA + "/ai-profiles/nonexistent", null, b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(404);

                // Regression #18.1: numeric JSON proxyPort in /api/ai/test-connection must parse cleanly (and reject non-integral/bad types)
                probeStatus.set(200);
                var numProxyRes = client.post("/api/ai/test-connection",
                        "{\"protocol\":\"OPENAI\",\"baseUrl\":\"http://localhost:" + port + "/v1\",\"proxyHost\":\"127.0.0.1\",\"proxyPort\":" + port + "}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                // Note: mockServer is an HTTP server (not an HTTP proxy), so it returns 200 (either models or upstream error), NOT 400 Invalid proxy port!
                assertThat(numProxyRes.code()).isEqualTo(200);
                assertThat(client.post("/api/ai/test-connection",
                        "{\"protocol\":\"OPENAI\",\"baseUrl\":\"http://localhost:" + port + "/v1\",\"proxyHost\":\"127.0.0.1\",\"proxyPort\":7890.5}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/ai/test-connection",
                        "{\"protocol\":\"OPENAI\",\"baseUrl\":\"http://localhost:" + port + "/v1\",\"proxyHost\":\"127.0.0.1\",\"proxyPort\":[]}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);

                // Regression #18.3a: non-primitive message role/content or non-array messages returns 400 (never 500)
                assertThat(client.post("/api/ai/chat",
                        "{\"profileId\":\"" + localId + "\",\"messages\":[{\"role\":{},\"content\":\"hi\"}]}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/ai/chat",
                        "{\"profileId\":\"" + localId + "\",\"messages\":[{\"role\":\"user\",\"content\":[\"arr\"]}]}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.post("/api/ai/chat",
                        "{\"profileId\":\"" + localId + "\",\"messages\":\"not-an-array\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);

                // Delete active secondId -> promotes localId
                var delSecond = client.delete("/api/users/" + userIdA + "/ai-profiles/" + secondId, null, b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(delSecond.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(delSecond.body().string()).getAsJsonObject().get("nextActiveProfileId").getAsString()).isEqualTo(localId);

                // Non-stream /api/ai/chat + [No Content Returned]
                var chatOk = client.post("/api/ai/chat",
                        "{\"profileId\":\"" + localId + "\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(chatOk.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(chatOk.body().string()).getAsJsonObject().get("reply").getAsString()).isEqualTo("Non-stream reply");

                emitEmptyChat.set(true);
                var chatEmpty = client.post("/api/ai/chat",
                        "{\"profileId\":\"" + localId + "\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(chatEmpty.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(chatEmpty.body().string()).getAsJsonObject().get("reply").getAsString()).isEqualTo("[No Content Returned]");

                // Probe GET query params & untrusted customBaseUrl does NOT leak saved key & PROBE_NEEDS_KEY / PROBE_AUTH_FAILED / PROBE_HTTP_ERROR
                var keyedProf = client.post("/api/users/" + userIdA + "/ai-profiles",
                        "{\"protocol\":\"OPENAI\",\"apiKey\":\"sk-secret-probe-9999\",\"baseUrl\":\"http://localhost:" + port + "/v1\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                String keyedId = JsonParser.parseString(keyedProf.body().string()).getAsJsonObject().get("id").getAsString();

                probeAuth.set(null);
                var untrustedProbe = client.post("/api/ai/test-connection",
                        "{\"profileId\":\"" + keyedId + "\",\"baseUrl\":\"http://127.0.0.1:" + port + "/v1\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(untrustedProbe.code()).isEqualTo(200);
                assertThat(probeAuth.get()).isNull();

                probeStatus.set(401);
                var needsKeyRes = client.get("/api/ai/test-connection?protocol=OPENAI&baseUrl=http://localhost:" + port + "/v1",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(needsKeyRes.code()).isEqualTo(200);
                assertThat(needsKeyRes.body().string()).contains("PROBE_NEEDS_KEY");

                var authFailRes = client.post("/api/ai/test-connection",
                        "{\"profileId\":\"" + keyedId + "\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(authFailRes.code()).isEqualTo(200);
                assertThat(authFailRes.body().string()).contains("PROBE_AUTH_FAILED");

                probeStatus.set(500);
                var httpErrRes = client.post("/api/ai/test-connection",
                        "{\"profileId\":\"" + keyedId + "\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(httpErrRes.code()).isEqualTo(200);
                assertThat(httpErrRes.body().string()).contains("PROBE_HTTP_ERROR");

                // Thread PUT idempotent create, messagesJson/contextConfigJson validation, and unclosed sp27-action preview stripping
                String eventId = JsonParser.parseString(client.post("/api/events", "{\"name\":\"Thread Edge Event\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA)).body().string()).getAsJsonObject().get("id").getAsString();

                assertThat(client.put("/api/events/" + eventId + "/ai-threads/" + "t".repeat(129), "{}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.put("/api/events/" + eventId + "/ai-threads/thr-put-1", "[]", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.put("/api/events/" + eventId + "/ai-threads/thr-put-1", "{\"messagesJson\":\"{}\"}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);
                assertThat(client.put("/api/events/" + eventId + "/ai-threads/thr-put-1", "{\"contextConfigJson\":\"[]\"}", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(400);

                var putCreate = client.put("/api/events/" + eventId + "/ai-threads/thr-put-1",
                        "{\"title\":\"PUT Thread\",\"messagesJson\":\"[{\\\"role\\\":\\\"assistant\\\",\\\"content\\\":\\\"Partial reply\\\\n```sp27-action\\\\n{\\\\\\\"actions\\\\\\\":[]\\\"}]\",\"contextConfigJson\":\"{\\\"enabled\\\":false}\"}",
                        b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(putCreate.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(putCreate.body().string()).getAsJsonObject().getAsJsonObject("contextConfig").get("enabled").getAsBoolean()).isFalse();

                var summaries = client.get("/api/events/" + eventId + "/ai-threads", b -> b.header("Authorization", "Bearer " + tokenA));
                assertThat(summaries.code()).isEqualTo(200);
                String sumStr = summaries.body().string();
                assertThat(sumStr).contains("Partial reply").doesNotContain("sp27-action");

                assertThat(client.delete("/api/events/" + eventId + "/ai-threads/missing", null, b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(404);
                assertThat(client.get("/api/events/" + eventId + "/ai-threads/missing", b -> b.header("Authorization", "Bearer " + tokenA)).code()).isEqualTo(404);
            });
        } finally {
            mockServer.stop(0);
        }
    }
}
