package com.bear27570.app.routes;

import com.bear27570.app.dao.AiChatSessionDao;
import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiChatSession;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.AiClient;
import com.bear27570.app.util.KeyDecryptionException;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class AiRoutes {
    private final Jdbi jdbi;
    private final Gson gson;
    private final ScheduledThreadPoolExecutor heartbeatScheduler;

    public AiRoutes(Jdbi jdbi, Gson gson, ScheduledThreadPoolExecutor heartbeatScheduler) {
        this.jdbi = jdbi;
        this.gson = gson;
        this.heartbeatScheduler = heartbeatScheduler;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot access settings of another user");
            }

            List<AiSettings> settings = jdbi.withExtension(
                AiSettingsDao.class, 
                dao -> dao.findByUserId(sessionUserId)
            );

            // Mask the API keys before sending to frontend
            for (AiSettings s : settings) {
                try {
                    String raw = AESUtil.decrypt(s.getApiKeyEncrypted());
                    if (raw != null && raw.length() > 6) {
                        s.setApiKeyEncrypted(raw.substring(0, 2) + "****************" + raw.substring(raw.length() - 4));
                    } else if (raw != null && !raw.isEmpty()) {
                        s.setApiKeyEncrypted("****");
                    }
                } catch (KeyDecryptionException e) {
                    s.setApiKeyEncrypted("ERR_KEY_LOST");
                }
            }

            ctx.result(gson.toJson(settings)).contentType("application/json");
        });

        routes.post("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify settings of another user");
            }

            AiSettings newSettings;
            try {
                newSettings = gson.fromJson(ctx.body(), AiSettings.class);
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body: " + e.getMessage()))).contentType("application/json");
                return;
            }

            if (newSettings == null || newSettings.getProvider() == null || newSettings.getProvider().isBlank()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body or missing provider"))).contentType("application/json");
                return;
            }
            newSettings.setUserId(sessionUserId);

            try {
                jdbi.useExtension(AiSettingsDao.class, dao -> {
                    AiSettings existing = dao.findByUserIdAndProvider(sessionUserId, newSettings.getProvider());
                    
                    String submittedKey = newSettings.getApiKeyEncrypted();
                    if (submittedKey == null || submittedKey.trim().isEmpty() || submittedKey.contains("***")) {
                        if (existing != null && existing.getApiKeyEncrypted() != null && !existing.getApiKeyEncrypted().isBlank()) {
                            // Keep existing encrypted key
                            newSettings.setApiKeyEncrypted(existing.getApiKeyEncrypted());
                        } else {
                            throw new IllegalArgumentException("API Key is required for new provider configuration");
                        }
                    } else {
                        // Encrypt new raw key
                        newSettings.setApiKeyEncrypted(AESUtil.encrypt(submittedKey.trim()));
                    }

                    dao.upsert(newSettings);
                });

                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (IllegalArgumentException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save settings: " + e.getMessage()))).contentType("application/json");
            }
        });

        io.javalin.http.Handler testConnectionHandler = ctx -> {
            String sessionUserId = ctx.attribute("userId");
            String provider = null;
            String proxyHost = null;
            String proxyPortStr = null;
            String customBaseUrl = null;
            String queryApiKey = null;

            if ("POST".equalsIgnoreCase(ctx.method().toString()) && ctx.body() != null && !ctx.body().isBlank()) {
                try {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
                    if (body != null) {
                        provider = asString(body.get("provider"));
                        proxyHost = asString(body.get("proxyHost"));
                        if (body.get("proxyPort") != null) {
                            proxyPortStr = asString(body.get("proxyPort"));
                        }
                        customBaseUrl = asString(body.get("baseUrl"));
                        queryApiKey = asString(body.get("apiKey"));
                    }
                } catch (Exception ignored) {}
            }
            if (provider == null) provider = ctx.queryParam("provider");
            if (proxyHost == null) proxyHost = ctx.queryParam("proxyHost");
            if (proxyPortStr == null) proxyPortStr = ctx.queryParam("proxyPort");
            if (customBaseUrl == null) customBaseUrl = ctx.queryParam("baseUrl");
            if (queryApiKey == null) queryApiKey = ctx.queryParam("apiKey");

            if (provider == null || provider.isEmpty()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider"))).contentType("application/json");
                return;
            }

            AiSettings saved = null;
            if (sessionUserId != null) {
                try {
                    String finalProvider = provider.toUpperCase();
                    saved = jdbi.withExtension(AiSettingsDao.class, dao -> dao.findByUserIdAndProvider(sessionUserId, finalProvider));
                } catch (Exception ignored) {}
            }

            // Determine API Key: passed in query/body (if not masked) OR decrypt from DB for current user
            String rawApiKey = null;
            if (queryApiKey != null && !queryApiKey.isBlank() && !queryApiKey.contains("***") && !queryApiKey.equals("****")) {
                rawApiKey = queryApiKey.trim();
            } else if (saved != null && saved.getApiKeyEncrypted() != null && !saved.getApiKeyEncrypted().isBlank()) {
                // Security Check: If customBaseUrl is provided and does not match saved.getBaseUrl(),
                // DO NOT attach saved API Key to an untrusted external URL!
                boolean isTrustedUrl = (customBaseUrl == null || customBaseUrl.isBlank()) ||
                        (saved.getBaseUrl() != null && saved.getBaseUrl().trim().equalsIgnoreCase(customBaseUrl.trim()));
                if (isTrustedUrl) {
                    try {
                        rawApiKey = AESUtil.decrypt(saved.getApiKeyEncrypted());
                    } catch (Exception ignored) {}
                }
            }

            String testUrl;
            if ("OPENAI".equalsIgnoreCase(provider)) {
                testUrl = AiClient.resolveOpenAiModelsEndpoint(customBaseUrl);
            } else if ("GEMINI".equalsIgnoreCase(provider)) {
                testUrl = "https://generativelanguage.googleapis.com/v1beta/models";
            } else {
                ctx.status(400).result(gson.toJson(Map.of("error", "Unsupported provider: " + provider))).contentType("application/json");
                return;
            }

            // SSRF Safety Check: validate testUrl
            if (!isSafeUrl(testUrl)) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden target URL: SSRF protection blocked access to private or metadata addresses"))).contentType("application/json");
                return;
            }

            Proxy proxy = Proxy.NO_PROXY;
            if (proxyPortStr != null && !proxyPortStr.isEmpty()) {
                try {
                    int port = Integer.parseInt(proxyPortStr);
                    String host = (proxyHost != null && !proxyHost.isEmpty()) ? proxyHost : "127.0.0.1";
                    proxy = new Proxy(Proxy.Type.HTTP, new java.net.InetSocketAddress(host, port));
                } catch (NumberFormatException e) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Invalid proxy port"))).contentType("application/json");
                    return;
                }
            }

            long start = System.currentTimeMillis();
            try {
                URL url = new URI(testUrl).toURL();
                HttpURLConnection conn = (HttpURLConnection) url.openConnection(proxy);
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);

                boolean hasKey = (rawApiKey != null && !rawApiKey.isBlank());
                if (hasKey) {
                    if ("GEMINI".equalsIgnoreCase(provider)) {
                        conn.setRequestProperty("x-goog-api-key", rawApiKey);
                    } else {
                        conn.setRequestProperty("Authorization", "Bearer " + rawApiKey);
                    }
                }

                int code = conn.getResponseCode();
                long latency = System.currentTimeMillis() - start;

                boolean success;
                String message;
                if (code == 200) {
                    success = true;
                    message = hasKey ? "API Key and endpoint authenticated successfully! (200 OK)" : "Endpoint reached successfully! (200 OK)";
                } else if (!hasKey && (code == 401 || code == 403)) {
                    success = true;
                    message = "Network connection is reachable (HTTP " + code + "). Please enter and save your API key to authenticate.";
                } else {
                    success = false;
                    if (code == 401 || code == 403 || code == 400) {
                        message = "Authentication failed (HTTP " + code + "): Invalid or unauthorized API key.";
                    } else {
                        message = "Endpoint returned HTTP " + code;
                    }
                }

                ctx.result(gson.toJson(Map.of("success", success, "statusCode", code, "latencyMs", latency, "message", message))).contentType("application/json");
            } catch (Exception e) {
                long latency = System.currentTimeMillis() - start;
                ctx.result(gson.toJson(Map.of("success", false, "error", e.getMessage() != null ? e.getMessage() : e.toString(), "latencyMs", latency))).contentType("application/json");
            }
        };

        routes.post("/api/ai/test-connection", testConnectionHandler);
        routes.get("/api/ai/test-connection", testConnectionHandler);

        routes.post("/api/ai/chat", ctx -> {
            String sessionUserId = ctx.attribute("userId");
            if (sessionUserId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }

            JsonObject body;
            try {
                JsonElement parsed = JsonParser.parseString(ctx.body());
                if (!parsed.isJsonObject()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                    return;
                }
                body = parsed.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON format: " + e.getMessage()))).contentType("application/json");
                return;
            }

            String provider = body.has("provider") && !body.get("provider").isJsonNull() ? body.get("provider").getAsString() : null;
            if (provider == null || provider.isEmpty()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider"))).contentType("application/json");
                return;
            }

            AiSettings settings = jdbi.withExtension(
                AiSettingsDao.class,
                dao -> dao.findByUserIdAndProvider(sessionUserId, provider)
            );

            if (settings == null) {
                ctx.status(400).result(gson.toJson(Map.of("error", "AI Settings not configured for provider: " + provider))).contentType("application/json");
                return;
            }

            String sysPrompt = body.has("systemPrompt") && !body.get("systemPrompt").isJsonNull() ? body.get("systemPrompt").getAsString() : settings.getSystemPrompt();

            List<Map<String, String>> msgList = new ArrayList<>();
            if (body.has("messages") && body.get("messages").isJsonArray()) {
                JsonArray arr = body.getAsJsonArray("messages");
                for (JsonElement e : arr) {
                    if (e.isJsonObject()) {
                        JsonObject msgObj = e.getAsJsonObject();
                        Map<String, String> m = new HashMap<>();
                        m.put("role", msgObj.has("role") && !msgObj.get("role").isJsonNull() ? msgObj.get("role").getAsString() : "user");
                        m.put("content", msgObj.has("content") && !msgObj.get("content").isJsonNull() ? msgObj.get("content").getAsString() : "");
                        msgList.add(m);
                    }
                }
            }

            try {
                String reply = AiClient.chat(settings, sysPrompt, msgList);
                ctx.result(gson.toJson(Map.of("reply", reply))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            }
        });

        routes.post("/api/ai/chat/stream", ctx -> {
            String sessionUserId = ctx.attribute("userId");
            if (sessionUserId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }

            JsonObject body;
            try {
                JsonElement parsed = JsonParser.parseString(ctx.body());
                if (!parsed.isJsonObject()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                    return;
                }
                body = parsed.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON format: " + e.getMessage()))).contentType("application/json");
                return;
            }

            String provider = body.has("provider") && !body.get("provider").isJsonNull() ? body.get("provider").getAsString() : null;
            if (provider == null || provider.isEmpty()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider"))).contentType("application/json");
                return;
            }

            AiSettings settings = jdbi.withExtension(
                AiSettingsDao.class,
                dao -> dao.findByUserIdAndProvider(sessionUserId, provider)
            );

            if (settings == null) {
                ctx.status(400).result(gson.toJson(Map.of("error", "AI Settings not configured for provider: " + provider))).contentType("application/json");
                return;
            }

            String sysPrompt = body.has("systemPrompt") && !body.get("systemPrompt").isJsonNull() ? body.get("systemPrompt").getAsString() : settings.getSystemPrompt();

            List<Map<String, String>> msgList = new ArrayList<>();
            if (body.has("messages") && body.get("messages").isJsonArray()) {
                JsonArray arr = body.getAsJsonArray("messages");
                for (JsonElement e : arr) {
                    if (e.isJsonObject()) {
                        JsonObject msgObj = e.getAsJsonObject();
                        Map<String, String> m = new HashMap<>();
                        m.put("role", msgObj.has("role") && !msgObj.get("role").isJsonNull() ? msgObj.get("role").getAsString() : "user");
                        m.put("content", msgObj.has("content") && !msgObj.get("content").isJsonNull() ? msgObj.get("content").getAsString() : "");
                        msgList.add(m);
                    }
                }
            }

            // Configure SSE response headers
            ctx.status(200);
            ctx.result("");
            ctx.contentType("text/event-stream; charset=UTF-8");
            ctx.header("Cache-Control", "no-cache");
            ctx.header("Connection", "keep-alive");
            ctx.header("X-Accel-Buffering", "no");

            ctx.async(() -> {
                final Object streamLock = new Object();
                final AtomicBoolean isCancelled = new AtomicBoolean(false);
                final AtomicBoolean isFinished = new AtomicBoolean(false);

                try {
                    if (ctx.req().isAsyncStarted()) {
                        ctx.req().getAsyncContext().addListener(new jakarta.servlet.AsyncListener() {
                            @Override public void onComplete(jakarta.servlet.AsyncEvent event) { isFinished.set(true); }
                            @Override public void onTimeout(jakarta.servlet.AsyncEvent event) { isCancelled.set(true); }
                            @Override public void onError(jakarta.servlet.AsyncEvent event) { isCancelled.set(true); }
                            @Override public void onStartAsync(jakarta.servlet.AsyncEvent event) {}
                        });
                    }
                } catch (Exception ignored) {}

                java.io.OutputStream out;
                try {
                    out = ctx.res().getOutputStream();
                } catch (Exception e) {
                    return;
                }

                // Periodic SSE heartbeat keep-alive (every 15s) to prevent idle timeouts
                ScheduledFuture<?> heartbeatTask = heartbeatScheduler.scheduleAtFixedRate(() -> {
                    if (isCancelled.get() || isFinished.get()) return;
                    synchronized (streamLock) {
                        if (isCancelled.get() || isFinished.get()) return;
                        try {
                            out.write(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));
                            out.flush();
                        } catch (Exception e) {
                            isCancelled.set(true);
                        }
                    }
                }, 15, 15, TimeUnit.SECONDS);

                try {
                    Consumer<String> chunkConsumer = textChunk -> {
                        if (isCancelled.get() || isFinished.get()) {
                            throw new RuntimeException("Stream cancelled by client");
                        }
                        synchronized (streamLock) {
                            if (isCancelled.get() || isFinished.get()) {
                                throw new RuntimeException("Stream cancelled by client");
                            }
                            try {
                                String event = "data: " + gson.toJson(Map.of("text", textChunk)) + "\n\n";
                                out.write(event.getBytes(StandardCharsets.UTF_8));
                                out.flush();
                            } catch (Exception e) {
                                isCancelled.set(true);
                                throw new RuntimeException("Client disconnected", e);
                            }
                        }
                    };

                    AiClient.chatStream(settings, sysPrompt, msgList, chunkConsumer, isCancelled);

                    if (!isCancelled.get() && !isFinished.get()) {
                        synchronized (streamLock) {
                            if (!isCancelled.get() && !isFinished.get()) {
                                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
                                out.flush();
                            }
                        }
                    }
                } catch (Throwable e) {
                    if (!isCancelled.get() && !isFinished.get()) {
                        synchronized (streamLock) {
                            if (!isCancelled.get() && !isFinished.get()) {
                                try {
                                    String errEvent = "data: " + gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : e.toString())) + "\n\n";
                                    out.write(errEvent.getBytes(StandardCharsets.UTF_8));
                                    out.flush();
                                } catch (Exception ignored) {
                                    isCancelled.set(true);
                                }
                            }
                        }
                    }
                } finally {
                    isFinished.set(true);
                    heartbeatTask.cancel(true);
                }
            });
        });

        routes.get("/api/events/{id}/ai-chat", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }
            AiChatSession session = jdbi.withExtension(
                AiChatSessionDao.class,
                dao -> dao.findSession(userId, eventId)
            );
            if (session != null && session.getChatHistoryJson() != null) {
                ctx.result(session.getChatHistoryJson()).contentType("application/json");
            } else {
                ctx.result("[]").contentType("application/json");
            }
        });

        routes.put("/api/events/{id}/ai-chat", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }
            
            // Validate JSON format roughly
            String jsonBody = ctx.body();
            try {
                JsonElement el = JsonParser.parseString(jsonBody);
                if (!el.isJsonArray()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Body must be a JSON array"))).contentType("application/json");
                    return;
                }
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON"))).contentType("application/json");
                return;
            }

            try {
                AiChatSession session = new AiChatSession();
                session.setUserId(userId);
                session.setEventId(eventId);
                session.setChatHistoryJson(jsonBody);

                jdbi.useExtension(AiChatSessionDao.class, dao -> {
                    dao.saveSession(session);
                });
                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save session: " + e.getMessage()))).contentType("application/json");
            }
        });
    }

    public static boolean isSafeUrl(String urlStr) {
        if (urlStr == null || urlStr.isBlank()) return false;
        try {
            URI uri = new URI(urlStr);
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            scheme = scheme.toLowerCase();
            if (!scheme.equals("http") && !scheme.equals("https")) {
                return false;
            }
            String host = uri.getHost();
            if (host == null || host.isBlank()) return false;
            host = host.toLowerCase();

            if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1")) {
                return true;
            }
            InetAddress addr = InetAddress.getByName(host);
            if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress() || addr.isAnyLocalAddress()) {
                return false;
            }
            String ip = addr.getHostAddress();
            if (ip.startsWith("169.254.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
                return false;
            }
            if (ip.startsWith("172.")) {
                String[] parts = ip.split("\\.");
                if (parts.length >= 2) {
                    try {
                        int second = Integer.parseInt(parts[1]);
                        if (second >= 16 && second <= 31) return false;
                    } catch (NumberFormatException ignored) {}
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
