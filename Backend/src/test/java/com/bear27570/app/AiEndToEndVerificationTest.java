package com.bear27570.app;

import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

public class AiEndToEndVerificationTest {

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

        String url = "jdbc:h2:mem:e2e_test_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

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
    void runCompleteUserJourney() {
        JavalinTest.test(app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"e2e_user\",\"password\":\"pass12345\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String regBody = regRes.body().string();
            String token = regBody.split("\"token\":\"")[1].split("\"")[0];
            String userId = regBody.split("\"id\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"2026 World Championship\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(eventRes.code()).isEqualTo(200);
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // Legacy chat session initial empty array & non-array 400 validation
            var initialChatRes = client.get("/api/events/" + eventId + "/ai-chat",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(initialChatRes.code()).isEqualTo(200);
            assertThat(initialChatRes.body().string()).isEqualTo("[]");

            var invalidChatRes = client.put("/api/events/" + eventId + "/ai-chat", "{\"invalid\":\"not an array\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(invalidChatRes.code()).isEqualTo(400);

            String openAiPayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk-real-secret-key-1234567890\","
                    + "\"modelName\":\"deepseek-chat\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\","
                    + "\"proxyHost\":\"127.0.0.1\","
                    + "\"proxyPort\":7890,"
                    + "\"systemPrompt\":\"You are FTC AI Assistant.\""
                    + "}";
            var saveOpenAiRes = client.post("/api/users/" + userId + "/ai-settings", openAiPayload,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(saveOpenAiRes.code()).isEqualTo(200);

            String geminiPayload = "{"
                    + "\"provider\":\"GEMINI\","
                    + "\"apiKeyEncrypted\":\"AIzaSySecretGeminiKey9876543210\","
                    + "\"modelName\":\"gemini-flash-latest\","
                    + "\"proxyHost\":\"127.0.0.1\","
                    + "\"proxyPort\":null,"
                    + "\"systemPrompt\":\"You are Gemini FTC Assistant.\""
                    + "}";
            var saveGeminiRes = client.post("/api/users/" + userId + "/ai-settings", geminiPayload,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(saveGeminiRes.code()).isEqualTo(200);

            var fetchSettingsRes = client.get("/api/users/" + userId + "/ai-settings",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(fetchSettingsRes.code()).isEqualTo(200);
            String settingsJson = fetchSettingsRes.body().string();
            assertThat(settingsJson).contains("sk****************7890");
            assertThat(settingsJson).contains("AI****************3210");
            assertThat(settingsJson).contains("https://api.deepseek.com/v1");

            String resaveWithMaskPayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk****************7890\","
                    + "\"modelName\":\"deepseek-coder\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\""
                    + "}";
            var resaveRes = client.post("/api/users/" + userId + "/ai-settings", resaveWithMaskPayload,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(resaveRes.code()).isEqualTo(200);

            jdbi.useExtension(AiSettingsDao.class, dao -> {
                AiSettings s = dao.findByUserIdAndProvider(userId, "OPENAI");
                assertThat(s.getModelName()).isEqualTo("deepseek-coder");
                String recovered = AESUtil.decrypt(s.getApiKeyEncrypted());
                assertThat(recovered).isEqualTo("sk-real-secret-key-1234567890");
            });

            String chatHistoryPayload = "["
                    + "{\"id\":\"msg-1\",\"role\":\"user\",\"content\":\"What is the scoring rate of Team 27570?\"},"
                    + "{\"id\":\"msg-2\",\"role\":\"assistant\",\"content\":\"Team 27570 has an average total score of 142.5 points with 100% autonomous accuracy.\"}"
                    + "]";
            var saveChatRes = client.put("/api/events/" + eventId + "/ai-chat", chatHistoryPayload,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(saveChatRes.code()).isEqualTo(200);

            var loadChatRes = client.get("/api/events/" + eventId + "/ai-chat",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(loadChatRes.code()).isEqualTo(200);
            assertThat(loadChatRes.body().string()).isEqualTo(chatHistoryPayload);

            File keyFile = AESUtil.getMasterKeyFile();
            assertThat(keyFile.toPath().toAbsolutePath().normalize()).startsWith(tempDir.toAbsolutePath().normalize());
            assertThat(keyFile.exists()).isTrue();
            assertThat(keyFile.canRead()).isTrue();
            assertThat(keyFile.canWrite()).isTrue();
        });
    }

    @Test
    void testAiEndpointValidationAndSsrfProtection() {
        assertThat(ApiRoutes.isSafeUrl("http://192.168.1.1/api")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://10.0.0.1/api")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://169.254.169.254/latest/meta-data/")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://localhost:7070/api")).isTrue();
        assertThat(ApiRoutes.isSafeUrl("https://api.openai.com/v1")).isTrue();

        JavalinTest.test(app, (server, client) -> {
            var unauthRes = client.post("/api/ai/chat/stream", "{\"provider\":\"OPENAI\"}");
            assertThat(unauthRes.code()).isEqualTo(401);

            var regRes = client.post("/api/user/register", "{\"username\":\"aichatval\", \"password\":\"secret\"}");
            String regBody = regRes.body().string();
            String token = regBody.split("\"token\":\"")[1].split("\"")[0];

            var missingProviderStream = client.post("/api/ai/chat/stream", "{}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(missingProviderStream.code()).isEqualTo(400);
            assertThat(missingProviderStream.body().string()).contains("Missing provider");

            var notConfiguredRes = client.post("/api/ai/chat/stream", "{\"provider\":\"OPENAI\",\"messages\":[]}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(notConfiguredRes.code()).isEqualTo(400);
            assertThat(notConfiguredRes.body().string()).contains("AI Settings not configured");

            var ssrfRes = client.post("/api/ai/test-connection",
                    "{\"provider\":\"OPENAI\",\"baseUrl\":\"http://192.168.1.100/v1\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(ssrfRes.code()).isEqualTo(400);
            assertThat(ssrfRes.body().string()).contains("SSRF");

            var missingProviderConn = client.post("/api/ai/test-connection", "{}",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(missingProviderConn.code()).isEqualTo(400);
        });
    }

    @Test
    void testSseStreamingEndToEnd() throws Exception {
        HttpServer mockLlmServer = HttpServer.create(new InetSocketAddress(0), 0);
        AtomicBoolean mockLlmCancelled = new AtomicBoolean(false);
        AtomicInteger cancelChunksSent = new AtomicInteger(0);
        CountDownLatch cancelFirstChunkSent = new CountDownLatch(1);
        CountDownLatch upstreamCancelled = new CountDownLatch(1);

        mockLlmServer.createContext("/v1/chat/completions", exchange -> {
            String reqBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            exchange.sendResponseHeaders(200, 0);
            if (reqBody.contains("CANCEL_TEST")) {
                String padding = "x".repeat(4096);
                try (OutputStream os = exchange.getResponseBody()) {
                    for (int i = 0; i < 200; i++) {
                        String chunk = "data: {\"choices\":[{\"delta\":{\"content\":\"chunk-" + i + "-" + padding + " \"}}]}\n\n";
                        os.write(chunk.getBytes(StandardCharsets.UTF_8));
                        os.flush();
                        cancelChunksSent.incrementAndGet();
                        if (i == 0) {
                            cancelFirstChunkSent.countDown();
                        }
                        try {
                            if (upstreamCancelled.await(25, TimeUnit.MILLISECONDS)) {
                                mockLlmCancelled.set(true);
                                break;
                            }
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            mockLlmCancelled.set(true);
                            upstreamCancelled.countDown();
                            break;
                        }
                    }
                } catch (Exception e) {
                    mockLlmCancelled.set(true);
                    upstreamCancelled.countDown();
                }
                return;
            }

            try (OutputStream os = exchange.getResponseBody()) {
                String[] chunks = {
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Team 27570 \"}}]}\n\n",
                        ": heartbeat\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"is performing stably \"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"with 142.5 avg points.\"}}]}\n\n",
                        "data: [DONE]\n\n"
                };
                for (String chunk : chunks) {
                    os.write(chunk.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            }
        });
        mockLlmServer.start();
        int mockPort = mockLlmServer.getAddress().getPort();
        String mockBaseUrl = "http://localhost:" + mockPort + "/v1";

        try {
            JavalinTest.test(app, (server, client) -> {
                var regRes = client.post("/api/user/register", "{\"username\":\"sse_user\",\"password\":\"pass123\"}");
                String regBody = regRes.body().string();
                String token = regBody.split("\"token\":\"")[1].split("\"")[0];
                String userId = regBody.split("\"id\":\"")[1].split("\"")[0];

                String settingsPayload = "{"
                        + "\"provider\":\"OPENAI\","
                        + "\"apiKeyEncrypted\":\"sk-test-sse-key\","
                        + "\"modelName\":\"mock-llm\","
                        + "\"baseUrl\":\"" + mockBaseUrl + "\""
                        + "}";
                assertThat(client.post("/api/users/" + userId + "/ai-settings", settingsPayload,
                        b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);

                long startTime = System.currentTimeMillis();
                String streamUrl = "http://localhost:" + server.port() + "/api/ai/chat/stream";

                HttpClient testHttpClient = HttpClient.newHttpClient();
                HttpRequest sseRequest = HttpRequest.newBuilder()
                        .uri(URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .header("Accept", "text/event-stream")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"provider\":\"OPENAI\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}"))
                        .build();

                HttpResponse<InputStream> sseResponse = testHttpClient.send(sseRequest, HttpResponse.BodyHandlers.ofInputStream());
                assertThat(sseResponse.statusCode()).isEqualTo(200);
                assertThat(sseResponse.headers().firstValue("Content-Type").orElse("")).contains("text/event-stream");

                try (BufferedReader sseReader = new BufferedReader(new InputStreamReader(sseResponse.body(), StandardCharsets.UTF_8))) {
                    String line;
                    StringBuilder aggregated = new StringBuilder();
                    long firstTokenTime = -1;
                    boolean receivedDone = false;

                    while ((line = sseReader.readLine()) != null) {
                        line = line.trim();
                        if (line.isEmpty() || line.startsWith(":")) {
                            continue;
                        }
                        if (line.startsWith("data:")) {
                            String data = line.substring(5).trim();
                            if ("[DONE]".equals(data)) {
                                receivedDone = true;
                                break;
                            }
                            var obj = JsonParser.parseString(data).getAsJsonObject();
                            if (obj.has("text")) {
                                if (firstTokenTime < 0) {
                                    firstTokenTime = System.currentTimeMillis();
                                    assertThat(firstTokenTime - startTime).isLessThan(2000);
                                }
                                aggregated.append(obj.get("text").getAsString());
                            }
                        }
                    }

                    assertThat(receivedDone).isTrue();
                    assertThat(aggregated.toString()).isEqualTo("Team 27570 is performing stably with 142.5 avg points.");
                }

                // Abrupt client cancellation must propagate upstream and stop the LLM stream early
                HttpRequest cancelRequest = HttpRequest.newBuilder()
                        .uri(URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .header("Accept", "text/event-stream")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"provider\":\"OPENAI\",\"messages\":[{\"role\":\"user\",\"content\":\"CANCEL_TEST\"}]}"))
                        .build();

                CompletableFuture<HttpResponse<InputStream>> asyncFuture =
                        testHttpClient.sendAsync(cancelRequest, HttpResponse.BodyHandlers.ofInputStream());
                HttpResponse<InputStream> asyncRes = asyncFuture.get(5, TimeUnit.SECONDS);
                assertThat(asyncRes.statusCode()).isEqualTo(200);
                try (InputStream asyncIs = asyncRes.body();
                     BufferedReader br = new BufferedReader(new InputStreamReader(asyncIs, StandardCharsets.UTF_8))) {
                    assertThat(cancelFirstChunkSent.await(5, TimeUnit.SECONDS)).isTrue();
                    String firstLine = br.readLine();
                    assertThat(firstLine).isNotBlank();
                    asyncIs.close();
                    asyncFuture.cancel(true);
                }

                assertThat(upstreamCancelled.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(mockLlmCancelled.get()).isTrue();
                assertThat(cancelChunksSent.get()).isLessThan(200);
            });
        } finally {
            mockLlmServer.stop(0);
        }
    }

    @Test
    void testThreeProtocolsLazyMigrationProfilesThreadsAndFallbacks() throws Exception {
        HttpServer mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        AtomicInteger openAiAttempts = new AtomicInteger(0);
        AtomicInteger geminiAttempts = new AtomicInteger(0);
        AtomicReference<String> lastAnthropicAuth = new AtomicReference<>();
        AtomicReference<String> lastAnthropicBearer = new AtomicReference<>();
        AtomicReference<String> lastAnthropicBody = new AtomicReference<>();
        AtomicReference<String> lastOpenAiBody = new AtomicReference<>();
        AtomicReference<String> lastGeminiHeaderKey = new AtomicReference<>();
        AtomicBoolean triggerAnthropicMidStreamError = new AtomicBoolean(false);

        mockServer.createContext("/openai/v1/chat/completions", exchange -> {
            String reqBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            lastOpenAiBody.set(reqBody);
            int attempt = openAiAttempts.incrementAndGet();
            if (attempt == 1 && reqBody.contains("stream_options")) {
                byte[] err = "{\"error\":{\"message\":\"Unrecognized request argument supplied: stream_options\"}}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(400, err.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(err);
                }
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream os = exchange.getResponseBody()) {
                String[] chunks = {
                        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Analyzing 27570 \"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Pick 27570.\"}}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":30,\"total_tokens\":150}}\n\n",
                        "data: [DONE]\n\n"
                };
                for (String c : chunks) {
                    os.write(c.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            }
        });
        mockServer.createContext("/openai/v1/models", exchange -> {
            byte[] res = "{\"data\":[{\"id\":\"deepseek-reasoner\"},{\"id\":\"deepseek-chat\"}]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, res.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(res); }
        });

        mockServer.createContext("/gemini-proxy/v1beta/models", exchange -> {
            lastGeminiHeaderKey.set(exchange.getRequestHeaders().getFirst("x-goog-api-key"));
            String path = exchange.getRequestURI().getPath();
            if (path.endsWith("/models")) {
                byte[] res = "{\"models\":[{\"name\":\"models/text-embedding-004\",\"supportedGenerationMethods\":[\"embedContent\"]},{\"name\":\"models/gemini-flash-latest\",\"supportedGenerationMethods\":[\"generateContent\"]},{\"name\":\"models/gemini-pro-latest\",\"supportedGenerationMethods\":[\"generateContent\"]}]}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, res.length);
                try (OutputStream os = exchange.getResponseBody()) { os.write(res); }
                return;
            }
            String reqBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            int attempt = geminiAttempts.incrementAndGet();
            if (attempt == 1 && reqBody.contains("thinkingConfig")) {
                byte[] err = "{\"error\":{\"message\":\"thinkingConfig is not enabled for this model\"}}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(400, err.length);
                try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream os = exchange.getResponseBody()) {
                String[] chunks = {
                        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini reasoning\",\"thought\":true},{\"text\":\"Gemini final answer\"}]}}],\"usageMetadata\":{\"promptTokenCount\":50,\"candidatesTokenCount\":15,\"thoughtsTokenCount\":10,\"totalTokenCount\":75}}\n\n"
                };
                for (String c : chunks) {
                    os.write(c.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            }
        });

        mockServer.createContext("/anthropic-proxy/v1/messages", exchange -> {
            lastAnthropicAuth.set(exchange.getRequestHeaders().getFirst("x-api-key") + "|" + exchange.getRequestHeaders().getFirst("anthropic-version"));
            lastAnthropicBearer.set(exchange.getRequestHeaders().getFirst("Authorization"));
            lastAnthropicBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream os = exchange.getResponseBody()) {
                if (triggerAnthropicMidStreamError.get()) {
                    String errChunk = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded temporarily\"}}\n\n";
                    os.write(errChunk.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                    return;
                }
                String[] chunks = {
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":64}}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Claude planning...\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Claude picks #27570.\"}}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":16}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                };
                for (String c : chunks) {
                    os.write(c.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            }
        });
        mockServer.createContext("/anthropic-proxy/v1/models", exchange -> {
            byte[] err = "{\"error\":{\"message\":\"Not implemented\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(404, err.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
        });

        mockServer.start();
        int port = mockServer.getAddress().getPort();

        try {
            JavalinTest.test(app, (server, client) -> {
                var regRes = client.post("/api/user/register", "{\"username\":\"copilot_e2e\",\"password\":\"pass12345\"}");
                assertThat(regRes.code()).isEqualTo(200);
                String regBody = regRes.body().string();
                String token = JsonParser.parseString(regBody).getAsJsonObject().get("token").getAsString();
                String userId = JsonParser.parseString(regBody).getAsJsonObject().get("id").getAsString();

                var evtRes = client.post("/api/events", "{\"name\":\"BIOBUZZ Finals\"}", b -> b.header("Authorization", "Bearer " + token));
                assertThat(evtRes.code()).isEqualTo(200);
                String eventId = JsonParser.parseString(evtRes.body().string()).getAsJsonObject().get("id").getAsString();

                String legacyOpenAiPayload = "{\"provider\":\"OPENAI\",\"apiKeyEncrypted\":\"sk-legacy-123456\",\"modelName\":\"deepseek-chat\",\"baseUrl\":\"http://localhost:" + port + "/openai/v1\"}";
                assertThat(client.post("/api/users/" + userId + "/ai-settings", legacyOpenAiPayload, b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);
                String legacyChat = "[{\"id\":\"m1\",\"role\":\"user\",\"content\":\"Old scouting summary question\"}]";
                assertThat(client.put("/api/events/" + eventId + "/ai-chat", legacyChat, b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);

                var migratedProfilesRes = client.get("/api/users/" + userId + "/ai-profiles", b -> b.header("Authorization", "Bearer " + token));
                assertThat(migratedProfilesRes.code()).isEqualTo(200);
                var profilesArr = JsonParser.parseString(migratedProfilesRes.body().string()).getAsJsonArray();
                assertThat(profilesArr.size()).isEqualTo(1);
                String migratedProfileId = profilesArr.get(0).getAsJsonObject().get("id").getAsString();
                assertThat(profilesArr.get(0).getAsJsonObject().get("isActive").getAsBoolean()).isTrue();
                assertThat(profilesArr.get(0).getAsJsonObject().get("hasApiKey").getAsBoolean()).isTrue();

                String ollamaPayload = "{\"name\":\"Local Ollama\",\"presetId\":\"ollama\",\"protocol\":\"OPENAI\",\"baseUrl\":\"http://localhost:11434/v1\",\"modelName\":\"llama3\",\"apiKeyEncrypted\":\"\"}";
                var ollamaRes = client.post("/api/users/" + userId + "/ai-profiles", ollamaPayload, b -> b.header("Authorization", "Bearer " + token));
                assertThat(ollamaRes.code()).isEqualTo(200);

                String geminiProfilePayload = "{\"name\":\"Gemini Proxy\",\"protocol\":\"GEMINI\",\"baseUrl\":\"http://localhost:" + port + "/gemini-proxy\",\"apiKeyEncrypted\":\"AIzaSyMockGeminiKey1234\",\"modelName\":\"gemini-pro-latest\",\"enableThinking\":true}";
                var gemSaveRes = client.post("/api/users/" + userId + "/ai-profiles", geminiProfilePayload, b -> b.header("Authorization", "Bearer " + token));
                assertThat(gemSaveRes.code()).isEqualTo(200);
                var gemObj = JsonParser.parseString(gemSaveRes.body().string()).getAsJsonObject();
                String geminiProfileId = gemObj.get("id").getAsString();
                assertThat(gemObj.getAsJsonArray("customModels").toString()).contains("gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest");

                String anthropicPayload = "{\"name\":\"Claude Official Proxy\",\"protocol\":\"ANTHROPIC\",\"baseUrl\":\"http://localhost:" + port + "/anthropic-proxy\",\"apiKeyEncrypted\":\"sk-ant-api03-testkey999\",\"modelName\":\"claude-sonnet-4-20250514\",\"enableThinking\":true,\"thinkingBudget\":2048,\"maxTokens\":4096,\"temperature\":0.3}";
                var antSaveRes = client.post("/api/users/" + userId + "/ai-profiles", anthropicPayload, b -> b.header("Authorization", "Bearer " + token));
                assertThat(antSaveRes.code()).isEqualTo(200);
                String anthropicProfileId = JsonParser.parseString(antSaveRes.body().string()).getAsJsonObject().get("id").getAsString();

                var antTestRes = client.post("/api/ai/test-connection", "{\"profileId\":\"" + anthropicProfileId + "\"}", b -> b.header("Authorization", "Bearer " + token));
                assertThat(antTestRes.code()).isEqualTo(200);
                var antTestJson = JsonParser.parseString(antTestRes.body().string()).getAsJsonObject();
                assertThat(antTestJson.get("success").getAsBoolean()).isTrue();
                assertThat(antTestJson.get("modelsSupported").getAsBoolean()).isFalse();
                assertThat(antTestJson.get("statusCode").getAsInt()).isEqualTo(404);

                var gemModelsRes = client.post("/api/ai/models", "{\"profileId\":\"" + geminiProfileId + "\"}", b -> b.header("Authorization", "Bearer " + token));
                assertThat(gemModelsRes.code()).isEqualTo(200);
                var gemModelsJson = JsonParser.parseString(gemModelsRes.body().string()).getAsJsonObject();
                assertThat(gemModelsJson.getAsJsonArray("models").toString()).contains("gemini-flash-latest", "gemini-pro-latest");
                assertThat(gemModelsJson.getAsJsonArray("models").toString()).doesNotContain("text-embedding-004");
                assertThat(lastGeminiHeaderKey.get()).isEqualTo("AIzaSyMockGeminiKey1234");

                HttpClient httpClient = HttpClient.newHttpClient();
                String streamUrl = "http://localhost:" + server.port() + "/api/ai/chat/stream";

                var oaReq = HttpRequest.newBuilder(URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"profileId\":\"" + migratedProfileId + "\",\"modelName\":\"deepseek-reasoner\",\"messages\":[{\"role\":\"user\",\"content\":\"Analyze 27570\"}]}"))
                        .build();
                String oaSse = httpClient.send(oaReq, HttpResponse.BodyHandlers.ofString()).body();
                assertThat(openAiAttempts.get()).isEqualTo(2);
                assertThat(lastOpenAiBody.get()).doesNotContain("\"temperature\"");
                assertThat(oaSse).contains("\"reasoning\":\"Analyzing 27570 \"");
                assertThat(oaSse).contains("\"text\":\"Pick 27570.\"");
                assertThat(oaSse).contains("\"totalTokens\":150");
                assertThat(oaSse).contains("data: [DONE]");

                var gmReq = HttpRequest.newBuilder(URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"profileId\":\"" + geminiProfileId + "\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi Gemini\"}]}"))
                        .build();
                String gmSse = httpClient.send(gmReq, HttpResponse.BodyHandlers.ofString()).body();
                assertThat(geminiAttempts.get()).isEqualTo(2);
                assertThat(gmSse).contains("\"reasoning\":\"Gemini reasoning\"");
                assertThat(gmSse).contains("\"text\":\"Gemini final answer\"");
                assertThat(gmSse).contains("\"totalTokens\":75");

                var anReq = HttpRequest.newBuilder(URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"profileId\":\"" + anthropicProfileId + "\",\"systemPrompt\":\"FTC Copilot\",\"messages\":[{\"role\":\"assistant\",\"content\":\"Leading\"},{\"role\":\"user\",\"content\":\"Compare\"}]}"))
                        .build();
                String anSse = httpClient.send(anReq, HttpResponse.BodyHandlers.ofString()).body();
                assertThat(lastAnthropicAuth.get()).isEqualTo("sk-ant-api03-testkey999|2023-06-01");
                assertThat(lastAnthropicBearer.get()).isNull();
                var sentAntJson = JsonParser.parseString(lastAnthropicBody.get()).getAsJsonObject();
                assertThat(sentAntJson.get("system").getAsString()).isEqualTo("FTC Copilot");
                assertThat(sentAntJson.has("temperature")).isFalse();
                assertThat(sentAntJson.get("max_tokens").getAsInt()).isGreaterThan(2048);
                assertThat(anSse).contains("\"reasoning\":\"Claude planning...\"");
                assertThat(anSse).contains("\"text\":\"Claude picks #27570.\"");
                assertThat(anSse).contains("\"totalTokens\":80");

                triggerAnthropicMidStreamError.set(true);
                String anErrSse = httpClient.send(anReq, HttpResponse.BodyHandlers.ofString()).body();
                assertThat(anErrSse).contains("\"error\":");
                assertThat(anErrSse).contains("overloaded_error");

                assertThat(client.post("/api/users/" + userId + "/ai-profiles/" + anthropicProfileId + "/activate", "{}", b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);
                var delRes = client.delete("/api/users/" + userId + "/ai-profiles/" + anthropicProfileId, null, b -> b.header("Authorization", "Bearer " + token));
                assertThat(delRes.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(delRes.body().string()).getAsJsonObject().get("nextActiveProfileId").getAsString()).isNotBlank();

                var threadsRes = client.get("/api/events/" + eventId + "/ai-threads", b -> b.header("Authorization", "Bearer " + token));
                assertThat(threadsRes.code()).isEqualTo(200);
                var threadsArr = JsonParser.parseString(threadsRes.body().string()).getAsJsonArray();
                assertThat(threadsArr.size()).isEqualTo(1);
                String migratedThreadId = threadsArr.get(0).getAsJsonObject().get("id").getAsString();
                assertThat(threadsArr.get(0).getAsJsonObject().has("messagesJson")).isFalse();

                var createThrRes = client.post("/api/events/" + eventId + "/ai-threads", "{\"title\":\"Alliance Pick 2\",\"personaId\":\"brag_auditor\"}", b -> b.header("Authorization", "Bearer " + token));
                assertThat(createThrRes.code()).isEqualTo(200);
                String thr2Id = JsonParser.parseString(createThrRes.body().string()).getAsJsonObject().get("id").getAsString();

                var putThrRes = client.put("/api/events/" + eventId + "/ai-threads/" + thr2Id, "{\"pinned\":true,\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"content\":\"Audit #27570\"}]}", b -> b.header("Authorization", "Bearer " + token));
                assertThat(putThrRes.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(putThrRes.body().string()).getAsJsonObject().get("pinned").getAsBoolean()).isTrue();

                var getThrRes = client.get("/api/events/" + eventId + "/ai-threads/" + migratedThreadId, b -> b.header("Authorization", "Bearer " + token));
                assertThat(getThrRes.code()).isEqualTo(200);
                assertThat(JsonParser.parseString(getThrRes.body().string()).getAsJsonObject().getAsJsonArray("messages").size()).isEqualTo(1);

                assertThat(client.delete("/api/events/" + eventId + "/ai-threads/" + thr2Id, null, b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);

                // Legacy /ai-chat endpoint MUST enforce event membership (positive member 200 vs non-member 403)
                assertThat(client.put("/api/events/" + eventId + "/ai-chat", "[{\"role\":\"user\",\"content\":\"legacy ok\"}]",
                        b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(200);
                var memberLegacyGet = client.get("/api/events/" + eventId + "/ai-chat",
                        b -> b.header("Authorization", "Bearer " + token));
                assertThat(memberLegacyGet.code()).isEqualTo(200);
                assertThat(memberLegacyGet.body().string()).contains("legacy ok");

                var outsiderReg = client.post("/api/user/register", "{\"username\":\"ai_outsider_sec\",\"password\":\"pass123\"}");
                String outsiderToken = outsiderReg.body().string().split("\"token\":\"")[1].split("\"")[0];
                assertThat(client.get("/api/events/" + eventId + "/ai-chat",
                        b -> b.header("Authorization", "Bearer " + outsiderToken)).code()).isEqualTo(403);
                assertThat(client.put("/api/events/" + eventId + "/ai-chat", "[]",
                        b -> b.header("Authorization", "Bearer " + outsiderToken)).code()).isEqualTo(403);
            });
        } finally {
            mockServer.stop(0);
        }
    }
}
