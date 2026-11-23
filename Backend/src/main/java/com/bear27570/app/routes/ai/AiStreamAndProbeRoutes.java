package com.bear27570.app.routes.ai;

import com.bear27570.app.dao.AiProviderProfileDao;
import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.AiClient;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;
import org.jdbi.v3.core.Jdbi;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * HTTP routes for AI connection probing, live model discovery, non-streaming chat, and 3-protocol SSE streaming.
 */
public final class AiStreamAndProbeRoutes {
    private final Jdbi jdbi;
    private final Gson gson;
    private final ScheduledThreadPoolExecutor heartbeatScheduler;

    public AiStreamAndProbeRoutes(Jdbi jdbi, Gson gson, ScheduledThreadPoolExecutor heartbeatScheduler) {
        this.jdbi = jdbi;
        this.gson = gson;
        this.heartbeatScheduler = heartbeatScheduler;
    }

    public void register(RoutesConfig routes) {
        io.javalin.http.Handler modelsAndConnectionHandler = this::handleModelsOrConnectionCheck;
        routes.post("/api/ai/test-connection", modelsAndConnectionHandler);
        routes.get("/api/ai/test-connection", modelsAndConnectionHandler);
        routes.post("/api/ai/models", modelsAndConnectionHandler);

        routes.post("/api/ai/chat", ctx -> handleChat(ctx, false));
        routes.post("/api/ai/chat/stream", ctx -> handleChat(ctx, true));
    }

    private void handleChat(Context ctx, boolean streaming) {
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

        String profileId = AiUrlGuard.getOptionalString(body, "profileId");
        String provider = AiUrlGuard.getOptionalString(body, "provider");
        if ((profileId == null || profileId.isBlank()) && (provider == null || provider.isBlank())) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider or profileId"))).contentType("application/json");
            return;
        }

        AiProviderProfile profile = AiProfileRoutes.resolveProfileForChat(jdbi, sessionUserId, profileId, provider);
        if (profile == null) {
            ctx.status(400).result(gson.toJson(Map.of("error", "AI Settings not configured for provider: " + (profileId != null ? profileId : provider)))).contentType("application/json");
            return;
        }

        if (streaming && profile.getBaseUrl() != null && !profile.getBaseUrl().isBlank() && !AiUrlGuard.isSafeUrl(profile.getBaseUrl())) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden baseUrl: SSRF protection blocked access"))).contentType("application/json");
            return;
        }

        String sysPrompt = body.has("systemPrompt") && !body.get("systemPrompt").isJsonNull()
                ? body.get("systemPrompt").getAsString()
                : profile.getSystemPrompt();
        String modelOverride = AiUrlGuard.getOptionalString(body, "modelName");
        Double tempOverride = body.has("temperature") && !body.get("temperature").isJsonNull()
                ? body.get("temperature").getAsDouble()
                : null;
        List<Map<String, String>> msgList = AiUrlGuard.parseMessagesArray(body);

        if (!streaming) {
            try {
                if (profileId == null && provider != null) {
                    profile.setEnableThinking(false);
                }
                String reply = AiClient.chat(profile, sysPrompt, msgList, tempOverride, modelOverride);
                ctx.result(gson.toJson(Map.of("reply", reply))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "AI chat failed"))).contentType("application/json");
            }
            return;
        }

        streamSseResponse(ctx, profile, sysPrompt, msgList, tempOverride, modelOverride);
    }

    private void streamSseResponse(
            Context ctx,
            AiProviderProfile profile,
            String sysPrompt,
            List<Map<String, String>> msgList,
            Double tempOverride,
            String modelOverride
    ) {
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
                Consumer<AiClient.StreamChunk> chunkConsumer = chunk -> {
                    if (chunk == null || "done".equals(chunk.kind())) {
                        return;
                    }
                    if (isCancelled.get() || isFinished.get()) {
                        throw new RuntimeException("Stream cancelled by client");
                    }
                    synchronized (streamLock) {
                        if (isCancelled.get() || isFinished.get()) {
                            throw new RuntimeException("Stream cancelled by client");
                        }
                        try {
                            String eventJson;
                            if ("reasoning".equals(chunk.kind()) && chunk.text() != null) {
                                eventJson = gson.toJson(Map.of("reasoning", chunk.text()));
                            } else if ("usage".equals(chunk.kind()) && chunk.usage() != null) {
                                JsonObject wrapper = new JsonObject();
                                wrapper.add("usage", chunk.usage());
                                eventJson = gson.toJson(wrapper);
                            } else if ("text".equals(chunk.kind()) && chunk.text() != null) {
                                eventJson = gson.toJson(Map.of("text", chunk.text()));
                            } else {
                                return;
                            }
                            String event = "data: " + eventJson + "\n\n";
                            out.write(event.getBytes(StandardCharsets.UTF_8));
                            out.flush();
                        } catch (Exception e) {
                            isCancelled.set(true);
                            throw new RuntimeException("Client disconnected", e);
                        }
                    }
                };

                AiClient.chatStream(profile, sysPrompt, msgList, tempOverride, modelOverride, chunkConsumer, isCancelled);

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
    }

    private void handleModelsOrConnectionCheck(Context ctx) {
        String sessionUserId = ctx.attribute("userId");
        String profileId = null;
        String protocolOrProvider = null;
        String proxyHost = null;
        String proxyPortStr = null;
        String customBaseUrl = null;
        String queryApiKey = null;
        String anthropicVersion = null;

        if ("POST".equalsIgnoreCase(ctx.method().toString()) && ctx.body() != null && !ctx.body().isBlank()) {
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
                if (body != null) {
                    profileId = AiUrlGuard.asString(body.get("profileId"));
                    protocolOrProvider = AiUrlGuard.asString(body.get("protocol"));
                    if (protocolOrProvider == null || protocolOrProvider.isBlank()) {
                        protocolOrProvider = AiUrlGuard.asString(body.get("provider"));
                    }
                    proxyHost = AiUrlGuard.asString(body.get("proxyHost"));
                    if (body.get("proxyPort") != null) {
                        proxyPortStr = AiUrlGuard.asString(body.get("proxyPort"));
                    }
                    customBaseUrl = AiUrlGuard.asString(body.get("baseUrl"));
                    queryApiKey = AiUrlGuard.asString(body.get("apiKey"));
                    anthropicVersion = AiUrlGuard.asString(body.get("anthropicVersion"));
                }
            } catch (Exception ignored) {}
        }
        if (profileId == null) profileId = ctx.queryParam("profileId");
        if (protocolOrProvider == null) protocolOrProvider = ctx.queryParam("protocol");
        if (protocolOrProvider == null) protocolOrProvider = ctx.queryParam("provider");
        if (proxyHost == null) proxyHost = ctx.queryParam("proxyHost");
        if (proxyPortStr == null) proxyPortStr = ctx.queryParam("proxyPort");
        if (customBaseUrl == null) customBaseUrl = ctx.queryParam("baseUrl");
        if (queryApiKey == null) queryApiKey = ctx.queryParam("apiKey");
        if (anthropicVersion == null) anthropicVersion = ctx.queryParam("anthropicVersion");

        AiProviderProfile savedProfile = null;
        if (sessionUserId != null && profileId != null && !profileId.isBlank()) {
            String fid = profileId.trim();
            savedProfile = jdbi.withExtension(AiProviderProfileDao.class, dao -> dao.findByIdAndUserId(fid, sessionUserId));
        }

        if ((protocolOrProvider == null || protocolOrProvider.isBlank()) && savedProfile != null) {
            protocolOrProvider = savedProfile.getProtocol();
        }
        if (protocolOrProvider == null || protocolOrProvider.isBlank()) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider/protocol"))).contentType("application/json");
            return;
        }
        String protocol = protocolOrProvider.trim().toUpperCase(Locale.ROOT);

        AiSettings legacySaved = null;
        if (savedProfile == null && sessionUserId != null) {
            try {
                legacySaved = jdbi.withExtension(AiSettingsDao.class, dao -> dao.findByUserIdAndProvider(sessionUserId, protocol));
            } catch (Exception ignored) {}
        }

        String effectiveBaseUrl = customBaseUrl;
        if ((effectiveBaseUrl == null || effectiveBaseUrl.isBlank()) && savedProfile != null) {
            effectiveBaseUrl = savedProfile.getBaseUrl();
        } else if ((effectiveBaseUrl == null || effectiveBaseUrl.isBlank()) && legacySaved != null) {
            effectiveBaseUrl = legacySaved.getBaseUrl();
        }

        if ((anthropicVersion == null || anthropicVersion.isBlank()) && savedProfile != null) {
            anthropicVersion = savedProfile.getAnthropicVersion();
        }
        if (anthropicVersion == null || anthropicVersion.isBlank()) {
            anthropicVersion = "2023-06-01";
        }

        String rawApiKey = null;
        if (!AiUrlGuard.isBlankOrMasked(queryApiKey)) {
            rawApiKey = queryApiKey.trim();
        } else if (savedProfile != null && savedProfile.getApiKeyEncrypted() != null && !savedProfile.getApiKeyEncrypted().isBlank()) {
            if (AiUrlGuard.isTrustedSavedUrl(customBaseUrl, savedProfile.getBaseUrl())) {
                try {
                    rawApiKey = AESUtil.decrypt(savedProfile.getApiKeyEncrypted());
                } catch (Exception ignored) {}
            }
        } else if (legacySaved != null && legacySaved.getApiKeyEncrypted() != null && !legacySaved.getApiKeyEncrypted().isBlank()) {
            if (AiUrlGuard.isTrustedSavedUrl(customBaseUrl, legacySaved.getBaseUrl())) {
                try {
                    rawApiKey = AESUtil.decrypt(legacySaved.getApiKeyEncrypted());
                } catch (Exception ignored) {}
            }
        }

        String testUrl;
        if ("OPENAI".equals(protocol)) {
            testUrl = AiClient.resolveOpenAiModelsEndpoint(effectiveBaseUrl);
        } else if ("GEMINI".equals(protocol)) {
            testUrl = AiClient.resolveGeminiModelsEndpoint(effectiveBaseUrl);
        } else if ("ANTHROPIC".equals(protocol)) {
            testUrl = AiClient.resolveAnthropicModelsEndpoint(effectiveBaseUrl);
        } else {
            ctx.status(400).result(gson.toJson(Map.of("error", "Unsupported protocol: " + protocol))).contentType("application/json");
            return;
        }

        if (!AiUrlGuard.isSafeUrl(testUrl)) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden target URL: SSRF protection blocked access to private or metadata addresses"))).contentType("application/json");
            return;
        }

        Integer proxyPort = null;
        if (proxyPortStr != null && !proxyPortStr.isBlank()) {
            try {
                proxyPort = Integer.parseInt(proxyPortStr.trim());
            } catch (NumberFormatException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid proxy port"))).contentType("application/json");
                return;
            }
        } else if (savedProfile != null && savedProfile.getProxyPort() != null) {
            proxyPort = savedProfile.getProxyPort();
            if (proxyHost == null || proxyHost.isBlank()) {
                proxyHost = savedProfile.getProxyHost();
            }
        }

        long start = System.currentTimeMillis();
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(8))
                    .proxy(AiClient.resolveEffectiveProxySelector(proxyHost, proxyPort, testUrl))
                    .build();

            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(testUrl))
                    .timeout(Duration.ofSeconds(8))
                    .GET();

            boolean hasKey = (rawApiKey != null && !rawApiKey.isBlank());
            if ("GEMINI".equals(protocol)) {
                if (hasKey) reqBuilder.header("x-goog-api-key", rawApiKey);
            } else if ("ANTHROPIC".equals(protocol)) {
                reqBuilder.header("anthropic-version", anthropicVersion);
                if (hasKey) reqBuilder.header("x-api-key", rawApiKey);
            } else {
                if (hasKey) reqBuilder.header("Authorization", "Bearer " + rawApiKey);
            }

            HttpResponse<String> response = client.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            int code = response.statusCode();
            long latency = System.currentTimeMillis() - start;

            Map<String, Object> result = new LinkedHashMap<>();
            List<String> models = List.of();
            boolean modelsSupported = false;
            boolean success;
            String message;
            String messageCode;

            if (code >= 200 && code < 300) {
                success = true;
                modelsSupported = true;
                models = AiClient.parseModelsResponse(protocol, response.body());
                messageCode = hasKey ? "PROBE_AUTH_OK" : "PROBE_REACHABLE_OK";
                message = hasKey
                        ? "API Key and endpoint authenticated successfully! (200 OK)"
                        : "Endpoint reached successfully! (200 OK)";
            } else if ("ANTHROPIC".equals(protocol) && (code == 404 || code == 405)) {
                success = true;
                modelsSupported = false;
                messageCode = "PROBE_MODELS_UNSUPPORTED";
                message = "Endpoint reachable, but model discovery endpoint is not exposed (HTTP " + code + "). Enter a model ID directly to chat.";
            } else if (!hasKey && (code == 401 || code == 403)) {
                success = true;
                modelsSupported = false;
                messageCode = "PROBE_NEEDS_KEY";
                message = "Network connection is reachable (HTTP " + code + "). Please enter and save your API key to authenticate.";
            } else {
                success = false;
                if (code == 401 || code == 403 || code == 400) {
                    messageCode = "PROBE_AUTH_FAILED";
                    message = "Authentication failed (HTTP " + code + "): Invalid or unauthorized API key.";
                } else {
                    messageCode = "PROBE_HTTP_ERROR";
                    message = "Endpoint returned HTTP " + code;
                }
            }

            result.put("success", success);
            result.put("modelsSupported", modelsSupported);
            result.put("statusCode", code);
            result.put("latencyMs", latency);
            result.put("models", models);
            result.put("messageCode", messageCode);
            result.put("message", message);
            if (!success) {
                result.put("error", message);
            }
            ctx.result(gson.toJson(result)).contentType("application/json");
        } catch (Exception e) {
            long latency = System.currentTimeMillis() - start;
            ctx.result(gson.toJson(Map.of(
                    "success", false,
                    "models", List.of(),
                    "error", e.getMessage() != null ? e.getMessage() : e.toString(),
                    "latencyMs", latency
            ))).contentType("application/json");
        }
    }
}
