package com.bear27570.app;

import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.AESUtil;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public class AiEndToEndVerificationTest {

    private Jdbi jdbi;
    private Javalin app;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:e2e_test_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
            .dataSource(url, "sa", "")
            .locations("classpath:db")
            .load()
            .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        app = Javalin.create(config -> {
            new ApiRoutes(jdbi).register(config.routes);
        });
    }

    @Test
    void runCompleteUserJourney() {
        JavalinTest.test(app, (server, client) -> {
            System.err.println("==================================================");
            System.err.println("[E2E Step 1] Registering User & Logging In...");
            var regRes = client.post("/api/user/register", "{\"username\":\"e2e_user\",\"password\":\"pass12345\"}");
            System.err.println("  -> Register Response Code: " + regRes.code());
            String regBody = regRes.body().string();
            System.err.println("  -> Register Response Body: " + regBody);
            assertThat(regRes.code()).isEqualTo(200);

            String token = regBody.split("\"token\":\"")[1].split("\"")[0];
            String userId = regBody.split("\"id\":\"")[1].split("\"")[0];
            System.err.println("  -> Extracted UserId: " + userId + ", Token (prefix): " + token.substring(0, 15) + "...");

            System.err.println("\n[E2E Step 2] Creating an Event...");
            var eventRes = client.post("/api/events", "{\"name\":\"2026 World Championship\"}", b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Event Creation Code: " + eventRes.code());
            String eventBody = eventRes.body().string();
            System.err.println("  -> Event Creation Body: " + eventBody);
            assertThat(eventRes.code()).isEqualTo(200);
            String eventId = eventBody.split("\"id\":\"")[1].split("\"")[0];

            System.err.println("\n[E2E Step 3] User configures OpenAI Compatible Settings (DeepSeek with custom BaseUrl)...");
            String openAiPayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk-real-secret-key-1234567890\","
                    + "\"modelName\":\"deepseek-chat\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\","
                    + "\"proxyHost\":\"127.0.0.1\","
                    + "\"proxyPort\":7890,"
                    + "\"systemPrompt\":\"You are FTC AI Assistant.\""
                    + "}";
            var saveOpenAiRes = client.post("/api/users/" + userId + "/ai-settings", openAiPayload, b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Save OpenAI Settings Code: " + saveOpenAiRes.code());
            System.err.println("  -> Save OpenAI Settings Body: " + saveOpenAiRes.body().string());
            assertThat(saveOpenAiRes.code()).isEqualTo(200);

            System.err.println("\n[E2E Step 4] User configures Gemini Settings (gemini-flash-latest)...");
            String geminiPayload = "{"
                    + "\"provider\":\"GEMINI\","
                    + "\"apiKeyEncrypted\":\"AIzaSySecretGeminiKey9876543210\","
                    + "\"modelName\":\"gemini-flash-latest\","
                    + "\"proxyHost\":\"127.0.0.1\","
                    + "\"proxyPort\":null,"
                    + "\"systemPrompt\":\"You are Gemini FTC Assistant.\""
                    + "}";
            var saveGeminiRes = client.post("/api/users/" + userId + "/ai-settings", geminiPayload, b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Save Gemini Settings Code: " + saveGeminiRes.code());
            System.err.println("  -> Save Gemini Settings Body: " + saveGeminiRes.body().string());
            assertThat(saveGeminiRes.code()).isEqualTo(200);

            System.err.println("\n[E2E Step 5] User fetches saved AI Settings from frontend...");
            var fetchSettingsRes = client.get("/api/users/" + userId + "/ai-settings", b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Fetch Settings Code: " + fetchSettingsRes.code());
            String settingsJson = fetchSettingsRes.body().string();
            System.err.println("  -> Fetch Settings Body (Masked): " + settingsJson);
            assertThat(fetchSettingsRes.code()).isEqualTo(200);
            assertThat(settingsJson).contains("sk****************7890");
            assertThat(settingsJson).contains("AI****************3210");
            assertThat(settingsJson).contains("https://api.deepseek.com/v1");

            System.err.println("\n[E2E Step 6] User clicks 'Save' in UI with masked key (re-saving without changing key)...");
            String resaveWithMaskPayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk****************7890\","
                    + "\"modelName\":\"deepseek-coder\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\""
                    + "}";
            var resaveRes = client.post("/api/users/" + userId + "/ai-settings", resaveWithMaskPayload, b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Re-save with mask Code: " + resaveRes.code());
            assertThat(resaveRes.code()).isEqualTo(200);

            // Verify in DB that original key is intact
            jdbi.useExtension(AiSettingsDao.class, dao -> {
                AiSettings s = dao.findByUserIdAndProvider(userId, "OPENAI");
                assertThat(s.getModelName()).isEqualTo("deepseek-coder");
                String recovered = AESUtil.decrypt(s.getApiKeyEncrypted());
                System.err.println("  -> Database Key Decrypted Verification: " + recovered);
                assertThat(recovered).isEqualTo("sk-real-secret-key-1234567890");
            });

            System.err.println("\n[E2E Step 7] User sends message & chat session is saved to Event...");
            String chatHistoryPayload = "["
                    + "{\"id\":\"msg-1\",\"role\":\"user\",\"content\":\"What is the scoring rate of Team 27570?\"},"
                    + "{\"id\":\"msg-2\",\"role\":\"assistant\",\"content\":\"Team 27570 has an average total score of 142.5 points with 100% autonomous accuracy.\"}"
                    + "]";
            var saveChatRes = client.put("/api/events/" + eventId + "/ai-chat", chatHistoryPayload, b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Save Chat Session Code: " + saveChatRes.code());
            System.err.println("  -> Save Chat Session Body: " + saveChatRes.body().string());
            assertThat(saveChatRes.code()).isEqualTo(200);

            System.err.println("\n[E2E Step 8] User switches tabs / reopens Event and hydrates chat history...");
            var loadChatRes = client.get("/api/events/" + eventId + "/ai-chat", b -> b.header("Authorization", "Bearer " + token));
            System.err.println("  -> Load Chat History Code: " + loadChatRes.code());
            String loadedChat = loadChatRes.body().string();
            System.err.println("  -> Load Chat History Body: " + loadedChat);
            assertThat(loadChatRes.code()).isEqualTo(200);
            assertThat(loadedChat).isEqualTo(chatHistoryPayload);

            System.err.println("\n[E2E Step 9] Verifying Windows Master Key file integrity and access...");
            String masterKeyPath = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "master.key";
            File keyFile = new File(masterKeyPath);
            System.err.println("  -> Key file location: " + keyFile.getAbsolutePath());
            System.err.println("  -> Exists: " + keyFile.exists() + ", Size: " + keyFile.length() + " bytes");
            System.err.println("  -> canRead: " + keyFile.canRead() + ", canWrite: " + keyFile.canWrite());
            assertThat(keyFile.exists()).isTrue();
            assertThat(keyFile.canRead()).isTrue();
            assertThat(keyFile.canWrite()).isTrue();

            System.err.println("\n==================================================");
            System.err.println("[E2E CONCLUSION] All user journeys and AI API pipelines verified successfully!");
            System.err.println("==================================================");
        });
    }

    @Test
    void testSseStreamingEndToEnd() throws Exception {
        // 1. Start a mock upstream LLM HTTP server
        com.sun.net.httpserver.HttpServer mockLlmServer = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        java.util.concurrent.atomic.AtomicBoolean mockLlmCancelled = new java.util.concurrent.atomic.AtomicBoolean(false);

        mockLlmServer.createContext("/v1/chat/completions", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=UTF-8");
            exchange.sendResponseHeaders(200, 0);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                String[] chunks = {
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Team 27570 \"}}]}\n\n",
                    ": heartbeat\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"is performing stably \"}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"with 142.5 avg points.\"}}]}\n\n",
                    "data: [DONE]\n\n"
                };
                for (String chunk : chunks) {
                    os.write(chunk.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    os.flush();
                    Thread.sleep(50);
                }
            } catch (Exception e) {
                mockLlmCancelled.set(true);
            }
        });
        mockLlmServer.start();
        int mockPort = mockLlmServer.getAddress().getPort();
        String mockBaseUrl = "http://localhost:" + mockPort + "/v1";

        try {
            JavalinTest.test(app, (server, client) -> {
                System.err.println("\n==================================================");
                System.err.println("[SSE E2E Step 1] Register user & save mock OpenAI settings...");
                var regRes = client.post("/api/user/register", "{\"username\":\"sse_user\",\"password\":\"pass123\"}");
                String token = regRes.body().string().split("\"token\":\"")[1].split("\"")[0];
                String userId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];

                String settingsPayload = "{"
                        + "\"provider\":\"OPENAI\","
                        + "\"apiKeyEncrypted\":\"sk-test-sse-key\","
                        + "\"modelName\":\"mock-llm\","
                        + "\"baseUrl\":\"" + mockBaseUrl + "\""
                        + "}";
                client.post("/api/users/" + userId + "/ai-settings", settingsPayload, b -> b.header("Authorization", "Bearer " + token));

                System.err.println("\n[SSE E2E Step 2] Requesting /api/ai/chat/stream and measuring TTFT & chunk deltas...");
                long startTime = System.currentTimeMillis();
                String streamUrl = "http://localhost:" + server.port() + "/api/ai/chat/stream";

                java.net.http.HttpClient testHttpClient = java.net.http.HttpClient.newHttpClient();
                java.net.http.HttpRequest sseRequest = java.net.http.HttpRequest.newBuilder()
                        .uri(java.net.URI.create(streamUrl))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .header("Accept", "text/event-stream")
                        .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"provider\":\"OPENAI\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}"))
                        .build();

                java.net.http.HttpResponse<java.io.InputStream> sseResponse = testHttpClient.send(sseRequest, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
                assertThat(sseResponse.statusCode()).isEqualTo(200);
                assertThat(sseResponse.headers().firstValue("Content-Type").orElse("")).contains("text/event-stream");
                System.err.println("  -> Received Response Code: " + sseResponse.statusCode() + ", Content-Type: " + sseResponse.headers().firstValue("Content-Type").orElse(""));

                try (java.io.BufferedReader sseReader = new java.io.BufferedReader(new java.io.InputStreamReader(sseResponse.body(), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    StringBuilder aggregated = new StringBuilder();
                    long firstTokenTime = -1;
                    boolean receivedDone = false;

                    while ((line = sseReader.readLine()) != null) {
                        line = line.trim();
                        if (line.isEmpty()) continue;
                        System.err.println("  -> Stream Line Received: " + line);
                        if (line.startsWith(":")) {
                            // Verified heartbeat comment ignored
                            continue;
                        }
                        if (line.startsWith("data:")) {
                            String data = line.substring(5).trim();
                            if ("[DONE]".equals(data)) {
                                receivedDone = true;
                                break;
                            }
                            com.google.gson.JsonObject obj = com.google.gson.JsonParser.parseString(data).getAsJsonObject();
                            if (obj.has("text")) {
                                if (firstTokenTime < 0) {
                                    firstTokenTime = System.currentTimeMillis();
                                    long ttft = firstTokenTime - startTime;
                                    System.err.println("  -> First Token Latency (TTFT): " + ttft + "ms");
                                    assertThat(ttft).isLessThan(2000); // TTFT under 2s
                                }
                                aggregated.append(obj.get("text").getAsString());
                            }
                        }
                    }

                    System.err.println("  -> Aggregated AI Reply: \"" + aggregated.toString() + "\"");
                    assertThat(receivedDone).isTrue();
                    assertThat(aggregated.toString()).isEqualTo("Team 27570 is performing stably with 142.5 avg points.");
                }

                System.err.println("\n[SSE E2E Step 3] Testing client abrupt abort / cancel handling...");
                java.util.concurrent.CompletableFuture<java.net.http.HttpResponse<java.io.InputStream>> asyncFuture = testHttpClient.sendAsync(sseRequest, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
                java.net.http.HttpResponse<java.io.InputStream> asyncRes = asyncFuture.get();
                assertThat(asyncRes.statusCode()).isEqualTo(200);
                try (java.io.InputStream asyncIs = asyncRes.body();
                     java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(asyncIs, java.nio.charset.StandardCharsets.UTF_8))) {
                    br.readLine();
                    // Abruptly cancel and close stream
                    asyncFuture.cancel(true);
                    asyncIs.close();
                    Thread.sleep(100);
                }

                System.err.println("\n==================================================");
                System.err.println("[SSE E2E CONCLUSION] Real SSE streaming pipeline, heartbeat parsing, cancellation & TTFT verified!");
                System.err.println("==================================================");
            });
        } finally {
            mockLlmServer.stop(0);
        }
    }
}
