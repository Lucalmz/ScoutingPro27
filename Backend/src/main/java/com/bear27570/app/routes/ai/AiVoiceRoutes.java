package com.bear27570.app.routes.ai;

import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.model.User;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.KeyDecryptionException;
import com.bear27570.app.util.ai.AiProxyResolver;
import com.bear27570.app.util.ai.AiStreamSupport;
import com.bear27570.app.util.ai.AiVoiceRelaySession;
import com.bear27570.app.util.ai.GeminiLiveRelaySession;
import com.bear27570.app.util.ai.GeminiProtocolAdapter;
import com.bear27570.app.util.ai.OpenAiRealtimeRelaySession;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;
import io.javalin.websocket.WsCloseStatus;
import io.javalin.websocket.WsContext;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * WebSocket voice relay (`WS /ws/ai/voice`) and audio transcription endpoint (`POST /api/ai/audio/transcribe`).
 */
public final class AiVoiceRoutes {
    private static final Logger logger = LoggerFactory.getLogger(AiVoiceRoutes.class);
    private static final int MAX_AUDIO_BYTES = 10 * 1024 * 1024;
    private static final int MAX_TRANSCRIBE_BODY_CHARS = 15 * 1024 * 1024;
    private static final long AUTH_TIMEOUT_SECONDS = 10L;

    private final Jdbi jdbi;
    private final Gson gson;
    private final ScheduledThreadPoolExecutor scheduler;
    private final ConcurrentHashMap<String, VoiceWsState> activeSessions = new ConcurrentHashMap<>();
    private final ExecutorService connectExecutor = new ThreadPoolExecutor(
            2, 16, 60L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(64),
            r -> {
                Thread t = new Thread(r, "ai-voice-connect");
                t.setDaemon(true);
                return t;
            }
    );

    public AiVoiceRoutes(Jdbi jdbi, Gson gson, ScheduledThreadPoolExecutor scheduler) {
        this.jdbi = jdbi;
        this.gson = gson;
        this.scheduler = scheduler;
    }

    public void register(RoutesConfig routes) {
        registerVoiceWebSocket(routes);
        routes.post("/api/ai/audio/transcribe", this::handleTranscribe);
    }

    public void shutdown() {
        for (VoiceWsState state : activeSessions.values()) {
            state.closeAll(WsCloseStatus.GOING_AWAY, "Server shutting down");
        }
        activeSessions.clear();
        connectExecutor.shutdownNow();
    }

    private void registerVoiceWebSocket(RoutesConfig routes) {
        routes.ws("/ws/ai/voice", ws -> {
            ws.onConnect(ctx -> {
                ctx.enableAutomaticPings(20, TimeUnit.SECONDS);
                VoiceWsState state = new VoiceWsState(ctx);
                activeSessions.put(ctx.sessionId(), state);
                state.authTimeoutFuture = scheduler.schedule(() -> {
                    if (!state.authenticated.get() && !state.closed.get()) {
                        state.sendErrorAndClose("AUTH_TIMEOUT", "Voice session start timeout", WsCloseStatus.POLICY_VIOLATION);
                    }
                }, AUTH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            });

            ws.onMessage(ctx -> {
                VoiceWsState state = activeSessions.get(ctx.sessionId());
                if (state == null || state.closed.get()) return;
                JsonObject msg;
                try {
                    JsonElement el = JsonParser.parseString(ctx.message());
                    if (!el.isJsonObject()) {
                        state.sendError("BAD_MESSAGE", "WebSocket message must be a JSON object");
                        return;
                    }
                    msg = el.getAsJsonObject();
                } catch (Exception e) {
                    state.sendError("INVALID_JSON", "Invalid JSON payload");
                    return;
                }

                try {
                    String type = AiUrlGuard.getOptionalString(msg, "type");
                    if (type == null || type.isBlank()) {
                        state.sendError("MISSING_TYPE", "Missing message type");
                        return;
                    }

                    switch (type) {
                        case "start" -> handleWsStart(state, msg);
                        case "audio" -> {
                            if (!requireStarted(state)) return;
                            String data = AiUrlGuard.getOptionalString(msg, "data");
                            if (data != null && !data.isBlank()) {
                                state.relay.sendAudio(data);
                            }
                        }
                        case "audio_end" -> {
                            if (!requireStarted(state)) return;
                            Boolean commitVal = AiUrlGuard.getOptionalBoolean(msg, "commit");
                            boolean commit = commitVal == null || commitVal;
                            state.relay.sendAudioEnd(commit);
                        }
                        case "mode" -> {
                            if (!requireStarted(state)) return;
                            String mode = AiUrlGuard.getOptionalString(msg, "inputMode");
                            if (state.relay instanceof OpenAiRealtimeRelaySession openAiRelay && mode != null && !mode.isBlank()) {
                                openAiRelay.setInputMode(mode);
                            }
                        }
                        case "text" -> {
                            if (!requireStarted(state)) return;
                            String text = AiUrlGuard.getOptionalString(msg, "text");
                            if (text != null && !text.isBlank()) {
                                state.relay.sendText(text);
                            }
                        }
                        case "interrupt" -> {
                            if (!requireStarted(state)) return;
                            state.relay.interrupt();
                        }
                        case "stop" -> state.closeAll(WsCloseStatus.NORMAL_CLOSURE, "Stopped by client");
                        default -> state.sendError("UNKNOWN_TYPE", "Unsupported message type: " + type);
                    }
                } catch (IllegalArgumentException e) {
                    state.sendError("BAD_MESSAGE", e.getMessage());
                }
            });

            ws.onClose(ctx -> {
                VoiceWsState state = activeSessions.remove(ctx.sessionId());
                if (state != null) {
                    state.cleanup();
                }
            });

            ws.onError(ctx -> {
                VoiceWsState state = activeSessions.remove(ctx.sessionId());
                if (state != null) {
                    state.cleanup();
                }
            });
        });
    }

    private boolean requireStarted(VoiceWsState state) {
        if (!state.authenticated.get() || state.relay == null) {
            state.sendError("NOT_STARTED", "Send start message before streaming audio or text");
            return false;
        }
        return true;
    }

    private void handleWsStart(VoiceWsState state, JsonObject msg) {
        if (state.started.get()) {
            state.sendError("ALREADY_STARTED", "Voice session already started");
            return;
        }
        String token = AiUrlGuard.getOptionalString(msg, "token");
        if (!state.started.compareAndSet(false, true)) {
            state.sendError("ALREADY_STARTED", "Voice session already started");
            return;
        }
        String userId = authenticateJwtUser(token);
        if (userId == null) {
            state.sendErrorAndClose("UNAUTHORIZED", "Invalid or expired JWT token", WsCloseStatus.POLICY_VIOLATION);
            return;
        }
        state.authenticated.set(true);
        state.cancelAuthTimeout();

        String profileId = AiUrlGuard.getOptionalString(msg, "profileId");
        String provider = AiUrlGuard.getOptionalString(msg, "provider");
        if ((profileId == null || profileId.isBlank()) && (provider == null || provider.isBlank())) {
            state.sendErrorAndClose("MISSING_PROFILE", "Missing profileId or provider", WsCloseStatus.NORMAL_CLOSURE);
            return;
        }

        AiProviderProfile profile = AiProfileRoutes.resolveProfileForChat(jdbi, userId, profileId, provider);
        if (profile == null) {
            state.sendErrorAndClose("PROFILE_NOT_FOUND", "AI profile not found", WsCloseStatus.NORMAL_CLOSURE);
            return;
        }

        String baseUrl = profile.getBaseUrl() != null ? profile.getBaseUrl().trim() : "";
        if (!baseUrl.isEmpty() && !AiUrlGuard.isSafeUrl(baseUrl)) {
            state.sendErrorAndClose("FORBIDDEN_URL", "Forbidden baseUrl: SSRF protection blocked access", WsCloseStatus.POLICY_VIOLATION);
            return;
        }
        if (!AiUrlGuard.isSafeProxyHost(profile.getProxyHost())) {
            state.sendErrorAndClose("FORBIDDEN_URL", "Forbidden proxyHost: SSRF protection blocked access", WsCloseStatus.POLICY_VIOLATION);
            return;
        }

        String rawKey;
        try {
            rawKey = decryptProfileKey(profile);
        } catch (KeyDecryptionException e) {
            state.sendErrorAndClose("KEY_DECRYPT_FAILED", "Failed to decrypt stored API key", WsCloseStatus.NORMAL_CLOSURE);
            return;
        }

        String protocol = profile.getProtocol() != null ? profile.getProtocol().trim().toUpperCase(Locale.ROOT) : "";
        boolean isLocalOpenAi = "OPENAI".equals(protocol) && AiProxyResolver.isLoopbackUrl(baseUrl);
        if ((rawKey == null || rawKey.isEmpty()) && !isLocalOpenAi) {
            state.sendErrorAndClose("API_KEY_REQUIRED", "API Key is required for this profile", WsCloseStatus.NORMAL_CLOSURE);
            return;
        }

        String requestedModel;
        String requestedVoice;
        String inputMode;
        String systemPrompt;
        List<Map<String, String>> history;
        try {
            requestedModel = AiUrlGuard.getOptionalString(msg, "model");
            requestedVoice = AiUrlGuard.getOptionalString(msg, "voice");
            inputMode = AiUrlGuard.getOptionalString(msg, "inputMode");
            systemPrompt = msg.has("systemPrompt") && !msg.get("systemPrompt").isJsonNull()
                    ? AiUrlGuard.getOptionalString(msg, "systemPrompt")
                    : profile.getSystemPrompt();
            history = parseHistoryArray(msg);
        } catch (IllegalArgumentException e) {
            state.sendErrorAndClose("BAD_MESSAGE", e.getMessage(), WsCloseStatus.POLICY_VIOLATION);
            return;
        }

        final AiVoiceRelaySession[] relayHolder = new AiVoiceRelaySession[1];
        AiVoiceRelaySession.RelayEventListener listener = new AiVoiceRelaySession.RelayEventListener() {
            @Override
            public void onEvent(JsonObject event) {
                state.sendJson(event);
            }

            @Override
            public void onError(String code, String message) {
                state.sendError(code, message);
            }

            @Override
            public void onClosed(int statusCode, String reason) {
                if (state.relay == relayHolder[0]) {
                    state.closeAll(WsCloseStatus.NORMAL_CLOSURE, reason != null && !reason.isBlank() ? reason : "Upstream closed");
                }
            }
        };

        AiVoiceRelaySession relay;
        if ("GEMINI".equals(protocol)) {
            String wsUrl = GeminiLiveRelaySession.resolveWebSocketUrl(baseUrl);
            if (!AiUrlGuard.isSafeWebSocketUrl(wsUrl)) {
                state.sendErrorAndClose("FORBIDDEN_URL", "Forbidden WebSocket URL: SSRF protection blocked access", WsCloseStatus.POLICY_VIOLATION);
                return;
            }
            String effectiveModel = resolveEffectiveLiveModel(requestedModel, profile.getModelName(), GeminiLiveRelaySession.DEFAULT_LIVE_MODEL, true);
            String effectiveVoice = (requestedVoice != null && !requestedVoice.isBlank()) ? requestedVoice.trim() : GeminiLiveRelaySession.DEFAULT_VOICE;
            relay = new GeminiLiveRelaySession(
                    baseUrl, rawKey, effectiveModel, effectiveVoice, systemPrompt, history,
                    profile.getProxyHost(), profile.getProxyPort(), listener
            );
        } else if ("OPENAI".equals(protocol)) {
            String effectiveModel = resolveEffectiveLiveModel(requestedModel, profile.getModelName(), OpenAiRealtimeRelaySession.DEFAULT_REALTIME_MODEL, false);
            String wsUrl = OpenAiRealtimeRelaySession.resolveWebSocketUrl(baseUrl, effectiveModel);
            if (!AiUrlGuard.isSafeWebSocketUrl(wsUrl)) {
                state.sendErrorAndClose("FORBIDDEN_URL", "Forbidden WebSocket URL: SSRF protection blocked access", WsCloseStatus.POLICY_VIOLATION);
                return;
            }
            String effectiveVoice = (requestedVoice != null && !requestedVoice.isBlank()) ? requestedVoice.trim() : OpenAiRealtimeRelaySession.DEFAULT_VOICE;
            relay = new OpenAiRealtimeRelaySession(
                    baseUrl, rawKey, effectiveModel, effectiveVoice, systemPrompt, history, inputMode,
                    profile.getProxyHost(), profile.getProxyPort(), listener
            );
        } else {
            state.sendErrorAndClose(
                    "UNSUPPORTED_PROTOCOL",
                    "Native realtime voice requires a GEMINI or OPENAI profile",
                    WsCloseStatus.NORMAL_CLOSURE
            );
            return;
        }

        relayHolder[0] = relay;
        state.relay = relay;

        try {
            connectExecutor.submit(() -> {
                if (!state.closed.get()) {
                    relay.connect();
                }
            });
        } catch (RejectedExecutionException e) {
            state.sendErrorAndClose("UPSTREAM_CONNECT_FAILED", "Voice relay server is busy; please retry", WsCloseStatus.TRY_AGAIN_LATER);
        }
    }

    private String authenticateJwtUser(String token) {
        if (token == null || token.isBlank()) return null;
        JwtUtil.TokenClaims claims = JwtUtil.verifyTokenClaims(token.trim());
        if (claims == null || claims.getUserId() == null || claims.getUserId().isBlank()) {
            return null;
        }
        User user = jdbi.withExtension(UserDao.class, dao -> dao.findById(claims.getUserId()));
        if (user != null) {
            return user.getId();
        }
        if (claims.getUsername() != null && !claims.getUsername().isBlank()) {
            User migrated = jdbi.withExtension(UserDao.class, dao -> dao.findRegisteredByUsername(claims.getUsername()));
            if (migrated != null) {
                return migrated.getId();
            }
        }
        return null;
    }

    private static String resolveEffectiveLiveModel(String requestedModel, String profileModel, String defaultLiveModel, boolean isGemini) {
        if (requestedModel != null && !requestedModel.isBlank()) {
            return requestedModel.trim();
        }
        if (profileModel != null && !profileModel.isBlank()) {
            String lower = profileModel.trim().toLowerCase(Locale.ROOT);
            if (isGemini) {
                if (lower.contains("live") || lower.contains("native-audio")) {
                    return profileModel.trim();
                }
            } else {
                if (lower.contains("realtime")) {
                    return profileModel.trim();
                }
            }
        }
        return defaultLiveModel;
    }

    private static List<Map<String, String>> parseHistoryArray(JsonObject body) {
        List<Map<String, String>> list = new ArrayList<>();
        if (body == null || !body.has("history") || !body.get("history").isJsonArray()) {
            return list;
        }
        for (JsonElement el : body.getAsJsonArray("history")) {
            if (!el.isJsonObject()) continue;
            JsonObject obj = el.getAsJsonObject();
            String role = AiUrlGuard.getOptionalString(obj, "role");
            String content = AiUrlGuard.getOptionalString(obj, "content");
            if (content != null && !content.isBlank()) {
                Map<String, String> item = new HashMap<>();
                item.put("role", role != null ? role : "user");
                item.put("content", content);
                list.add(item);
            }
        }
        return list;
    }

    private void handleTranscribe(Context ctx) {
        String sessionUserId = ctx.attribute("userId");
        if (sessionUserId == null) {
            throw new io.javalin.http.UnauthorizedResponse("Not logged in");
        }

        String rawBody = ctx.body();
        if (rawBody != null && rawBody.length() > MAX_TRANSCRIBE_BODY_CHARS) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Request body exceeds maximum allowed size"))).contentType("application/json");
            return;
        }

        JsonObject body;
        try {
            JsonElement parsed = JsonParser.parseString(rawBody);
            if (!parsed.isJsonObject()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                return;
            }
            body = parsed.getAsJsonObject();
        } catch (Exception e) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON format: " + e.getMessage()))).contentType("application/json");
            return;
        }

        String profileId;
        String provider;
        String audioBase64;
        String mimeType;
        String language;
        String modelOverride;
        try {
            profileId = AiUrlGuard.getOptionalString(body, "profileId");
            provider = AiUrlGuard.getOptionalString(body, "provider");
            audioBase64 = AiUrlGuard.getOptionalString(body, "audioBase64");
            mimeType = AiUrlGuard.getOptionalString(body, "mimeType");
            language = AiUrlGuard.getOptionalString(body, "language");
            modelOverride = AiUrlGuard.getOptionalString(body, "model");
        } catch (IllegalArgumentException e) {
            ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            return;
        }
        if ((profileId == null || profileId.isBlank()) && (provider == null || provider.isBlank())) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider or profileId"))).contentType("application/json");
            return;
        }

        if (audioBase64 == null || audioBase64.isBlank()) {
            ctx.status(400).result(gson.toJson(Map.of("error", "audioBase64 is required"))).contentType("application/json");
            return;
        }
        String cleanBase64 = stripDataUrlPrefix(audioBase64.trim());
        byte[] audioBytes;
        try {
            audioBytes = Base64.getMimeDecoder().decode(cleanBase64);
        } catch (IllegalArgumentException e) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Invalid audioBase64 encoding"))).contentType("application/json");
            return;
        }
        if (audioBytes.length == 0) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Audio payload cannot be empty"))).contentType("application/json");
            return;
        }
        if (audioBytes.length > MAX_AUDIO_BYTES) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Audio payload exceeds 10 MB limit"))).contentType("application/json");
            return;
        }

        AiProviderProfile profile = AiProfileRoutes.resolveProfileForChat(jdbi, sessionUserId, profileId, provider);
        if (profile == null) {
            ctx.status(400).result(gson.toJson(Map.of("error", "AI Settings not configured for provider: " + (profileId != null ? profileId : provider)))).contentType("application/json");
            return;
        }

        String baseUrl = profile.getBaseUrl() != null ? profile.getBaseUrl().trim() : "";
        if (!baseUrl.isEmpty() && !AiUrlGuard.isSafeUrl(baseUrl)) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden baseUrl: SSRF protection blocked access"))).contentType("application/json");
            return;
        }
        if (!AiUrlGuard.isSafeProxyHost(profile.getProxyHost())) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden proxyHost: SSRF protection blocked access"))).contentType("application/json");
            return;
        }

        String protocol = profile.getProtocol() != null ? profile.getProtocol().trim().toUpperCase(Locale.ROOT) : "";
        if ("ANTHROPIC".equals(protocol)) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Anthropic protocol does not support audio transcription"))).contentType("application/json");
            return;
        }

        String rawKey;
        try {
            rawKey = decryptProfileKey(profile);
        } catch (KeyDecryptionException e) {
            ctx.status(400).result(gson.toJson(Map.of("error", "Failed to decrypt API key; please re-save it in settings"))).contentType("application/json");
            return;
        }

        boolean isLocalOpenAi = "OPENAI".equals(protocol) && AiProxyResolver.isLoopbackUrl(baseUrl);
        if ((rawKey == null || rawKey.isEmpty()) && !isLocalOpenAi) {
            ctx.status(400).result(gson.toJson(Map.of("error", "API Key is required for audio transcription"))).contentType("application/json");
            return;
        }

        if (mimeType == null || mimeType.isBlank()) {
            mimeType = "audio/wav";
        }
        mimeType = AiUrlGuard.stripControlChars(mimeType.trim());
        if (language != null) {
            language = AiUrlGuard.stripControlChars(language.trim());
        }
        if (modelOverride != null) {
            modelOverride = AiUrlGuard.stripControlChars(modelOverride.trim());
        }

        try {
            String text;
            if ("GEMINI".equals(protocol)) {
                text = transcribeWithGemini(profile, rawKey, cleanBase64, mimeType.trim(), language, modelOverride);
            } else if ("OPENAI".equals(protocol)) {
                text = transcribeWithOpenAi(profile, rawKey, audioBytes, mimeType.trim(), language, modelOverride);
            } else {
                ctx.status(400).result(gson.toJson(Map.of("error", "Unsupported protocol for transcription: " + protocol))).contentType("application/json");
                return;
            }
            ctx.status(200).result(gson.toJson(Map.of("text", text))).contentType("application/json");
        } catch (IllegalArgumentException e) {
            ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
        } catch (Exception e) {
            logger.warn("[AiVoiceRoutes] Audio transcription failed: {}", e.getMessage());
            ctx.status(502).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Audio transcription failed"))).contentType("application/json");
        }
    }

    private String transcribeWithGemini(
            AiProviderProfile profile,
            String rawKey,
            String audioBase64,
            String mimeType,
            String language,
            String modelOverride
    ) throws Exception {
        String effectiveModel = resolveGeminiSttModel(modelOverride, profile.getModelName());
        String endpoint = GeminiProtocolAdapter.resolveGenerateEndpoint(profile.getBaseUrl(), effectiveModel, false);
        if (!AiUrlGuard.isSafeUrl(endpoint)) {
            throw new IllegalArgumentException("Forbidden baseUrl: SSRF protection blocked access");
        }

        String prompt = "Transcribe the speech in this audio verbatim. Output ONLY the transcribed words with punctuation, and nothing else.";
        if (language != null && !language.isBlank()) {
            prompt += " Primary language hint: " + language.trim() + ".";
        }

        JsonObject textPart = new JsonObject();
        textPart.addProperty("text", prompt);

        JsonObject inlineData = new JsonObject();
        inlineData.addProperty("mime_type", mimeType);
        inlineData.addProperty("data", audioBase64);
        JsonObject audioPart = new JsonObject();
        audioPart.add("inline_data", inlineData);

        JsonArray parts = new JsonArray();
        parts.add(textPart);
        parts.add(audioPart);

        JsonObject userTurn = new JsonObject();
        userTurn.addProperty("role", "user");
        userTurn.add("parts", parts);

        JsonArray contents = new JsonArray();
        contents.add(userTurn);

        JsonObject genConfig = new JsonObject();
        genConfig.addProperty("temperature", 0);

        JsonObject payload = new JsonObject();
        payload.add("contents", contents);
        payload.add("generationConfig", genConfig);

        HttpClient client = AiProxyResolver.buildHttpClient(profile.getProxyHost(), profile.getProxyPort(), endpoint);
        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload), StandardCharsets.UTF_8));
        if (rawKey != null && !rawKey.isEmpty()) {
            req.header("x-goog-api-key", rawKey);
        }

        HttpResponse<String> response = client.send(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new RuntimeException("Gemini STT Error (" + response.statusCode() + "): " + response.body());
        }
        return extractGeminiCandidateText(response.body());
    }

    private String transcribeWithOpenAi(
            AiProviderProfile profile,
            String rawKey,
            byte[] audioBytes,
            String mimeType,
            String language,
            String modelOverride
    ) throws Exception {
        String endpoint = resolveOpenAiTranscriptionsEndpoint(profile.getBaseUrl());
        if (!AiUrlGuard.isSafeUrl(endpoint)) {
            throw new IllegalArgumentException("Forbidden baseUrl: SSRF protection blocked access");
        }

        String sttModel = resolveOpenAiSttModel(modelOverride, profile.getBaseUrl(), profile.getPresetId());
        String ext = mimeType.toLowerCase(Locale.ROOT).contains("webm") ? "webm"
                : mimeType.toLowerCase(Locale.ROOT).contains("mp4") ? "mp4"
                : mimeType.toLowerCase(Locale.ROOT).contains("ogg") ? "ogg" : "wav";

        String boundary = "----ScoutingProVoice" + UUID.randomUUID().toString().replace("-", "");
        byte[] multipartBody = buildMultipartAudioBody(boundary, audioBytes, mimeType, "recording." + ext, sttModel, language);

        HttpClient client = AiProxyResolver.buildHttpClient(profile.getProxyHost(), profile.getProxyPort(), endpoint);
        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofByteArray(multipartBody));
        if (rawKey != null && !rawKey.isEmpty()) {
            req.header("Authorization", "Bearer " + rawKey);
        }

        HttpResponse<String> response = client.send(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new RuntimeException("OpenAI STT Error (" + response.statusCode() + "): " + response.body());
        }
        String bodyStr = response.body() != null ? response.body().trim() : "";
        if (bodyStr.startsWith("{")) {
            JsonObject obj = JsonParser.parseString(bodyStr).getAsJsonObject();
            String text = AiStreamSupport.getNonEmptyString(obj, "text");
            return text != null ? text.trim() : "";
        }
        return bodyStr;
    }

    public static String resolveOpenAiTranscriptionsEndpoint(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://api.openai.com/v1/audio/transcriptions";
        }
        String bUrl = AiUrlGuard.stripQueryAndFragment(baseUrl);
        if (bUrl.endsWith("/audio/transcriptions")) {
            return bUrl;
        }
        if (bUrl.endsWith("/chat/completions")) {
            bUrl = bUrl.substring(0, bUrl.length() - "/chat/completions".length());
        }
        if (bUrl.matches(".*/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/audio/transcriptions";
        }
        return bUrl + "/v1/audio/transcriptions";
    }

    private static String resolveGeminiSttModel(String modelOverride, String profileModel) {
        if (modelOverride != null && !modelOverride.isBlank()) {
            return modelOverride.trim();
        }
        if (profileModel != null && !profileModel.isBlank()) {
            String lower = profileModel.trim().toLowerCase(Locale.ROOT);
            if (!lower.contains("live") && !lower.contains("tts")) {
                return profileModel.trim();
            }
        }
        return "gemini-flash-latest";
    }

    private static String resolveOpenAiSttModel(String modelOverride, String baseUrl, String presetId) {
        if (modelOverride != null && !modelOverride.isBlank()) {
            return modelOverride.trim();
        }
        String lowerUrl = baseUrl != null ? baseUrl.toLowerCase(Locale.ROOT) : "";
        String lowerPreset = presetId != null ? presetId.toLowerCase(Locale.ROOT) : "";
        if ("groq".equals(lowerPreset) || lowerUrl.contains("groq.com")) {
            return "whisper-large-v3-turbo";
        }
        if ("siliconflow".equals(lowerPreset) || lowerUrl.contains("siliconflow")) {
            return "FunAudioLLM/SenseVoiceSmall";
        }
        if (lowerUrl.isBlank() || lowerUrl.contains("api.openai.com")) {
            return "gpt-4o-mini-transcribe";
        }
        return "whisper-1";
    }

    private static String extractGeminiCandidateText(String rawJson) {
        if (rawJson == null || rawJson.isBlank()) return "";
        JsonObject root = JsonParser.parseString(rawJson).getAsJsonObject();
        if (!root.has("candidates") || !root.get("candidates").isJsonArray()) return "";
        JsonArray candidates = root.getAsJsonArray("candidates");
        if (candidates.isEmpty() || !candidates.get(0).isJsonObject()) return "";
        JsonObject cand = candidates.get(0).getAsJsonObject();
        if (!cand.has("content") || !cand.get("content").isJsonObject()) return "";
        JsonObject content = cand.getAsJsonObject("content");
        if (!content.has("parts") || !content.get("parts").isJsonArray()) return "";
        StringBuilder sb = new StringBuilder();
        for (JsonElement pEl : content.getAsJsonArray("parts")) {
            if (!pEl.isJsonObject()) continue;
            JsonObject part = pEl.getAsJsonObject();
            boolean isThought = part.has("thought") && !part.get("thought").isJsonNull() && part.get("thought").getAsBoolean();
            if (isThought) continue;
            String text = AiStreamSupport.getNonEmptyString(part, "text");
            if (text != null) {
                sb.append(text);
            }
        }
        return sb.toString().trim();
    }

    private static byte[] buildMultipartAudioBody(
            String boundary,
            byte[] audioBytes,
            String mimeType,
            String filename,
            String model,
            String language
    ) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeFormField(out, boundary, "model", model);
        writeFormField(out, boundary, "response_format", "json");
        if (language != null && !language.isBlank()) {
            writeFormField(out, boundary, "language", language.trim());
        }
        String fileHeader = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\n"
                + "Content-Type: " + mimeType + "\r\n\r\n";
        out.write(fileHeader.getBytes(StandardCharsets.UTF_8));
        out.write(audioBytes);
        out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    private static void writeFormField(ByteArrayOutputStream out, String boundary, String name, String value) throws Exception {
        String part = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
                + value + "\r\n";
        out.write(part.getBytes(StandardCharsets.UTF_8));
    }

    private static String stripDataUrlPrefix(String raw) {
        int commaIdx = raw.indexOf(',');
        if (raw.startsWith("data:") && commaIdx > 0) {
            return raw.substring(commaIdx + 1).trim();
        }
        return raw;
    }

    private static String decryptProfileKey(AiProviderProfile profile) throws KeyDecryptionException {
        String enc = profile.getApiKeyEncrypted();
        if (enc == null || enc.isBlank()) {
            return "";
        }
        String raw = AESUtil.decrypt(enc);
        return raw != null ? raw.trim() : "";
    }

    private final class VoiceWsState {
        final WsContext ctx;
        final Object sendLock = new Object();
        final AtomicBoolean started = new AtomicBoolean(false);
        final AtomicBoolean authenticated = new AtomicBoolean(false);
        final AtomicBoolean closed = new AtomicBoolean(false);
        volatile ScheduledFuture<?> authTimeoutFuture;
        volatile AiVoiceRelaySession relay;

        VoiceWsState(WsContext ctx) {
            this.ctx = ctx;
        }

        void cancelAuthTimeout() {
            ScheduledFuture<?> f = this.authTimeoutFuture;
            if (f != null) {
                f.cancel(false);
            }
        }

        void sendJson(JsonObject obj) {
            if (closed.get() || obj == null) return;
            String payload = gson.toJson(obj);
            synchronized (sendLock) {
                if (closed.get()) return;
                try {
                    if (ctx.session != null && ctx.session.isOpen()) {
                        ctx.send(payload);
                    }
                } catch (Exception e) {
                    logger.debug("[AiVoiceRoutes] Failed to write WS frame to client {}: {}", ctx.sessionId(), e.getMessage());
                }
            }
        }

        void sendError(String code, String message) {
            JsonObject err = new JsonObject();
            err.addProperty("type", "error");
            err.addProperty("code", code);
            err.addProperty("message", message != null ? message : "Voice session error");
            sendJson(err);
        }

        void sendErrorAndClose(String code, String message, WsCloseStatus status) {
            sendError(code, message);
            closeAll(status, message != null ? message : code);
        }

        void closeAll(WsCloseStatus status, String reason) {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            activeSessions.remove(ctx.sessionId(), this);
            cancelAuthTimeout();
            AiVoiceRelaySession r = this.relay;
            this.relay = null;
            if (r != null) {
                r.close();
            }
            synchronized (sendLock) {
                try {
                    if (ctx.session != null && ctx.session.isOpen()) {
                        String safeReason = reason != null && reason.length() > 100 ? reason.substring(0, 100) : (reason != null ? reason : "");
                        ctx.closeSession(status, safeReason);
                    }
                } catch (Exception ignored) {}
            }
        }

        void cleanup() {
            closed.set(true);
            cancelAuthTimeout();
            AiVoiceRelaySession r = this.relay;
            this.relay = null;
            if (r != null) {
                r.close();
            }
        }
    }
}
