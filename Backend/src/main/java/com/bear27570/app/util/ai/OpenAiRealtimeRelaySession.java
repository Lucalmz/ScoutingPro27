package com.bear27570.app.util.ai;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.net.URLEncoder;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bidirectional WebSocket relay for OpenAI Realtime API (GA schema + Beta preview compatibility).
 */
public final class OpenAiRealtimeRelaySession extends AbstractVoiceWsRelay {
    public static final String DEFAULT_REALTIME_MODEL = "gpt-realtime";
    public static final String DEFAULT_VOICE = "alloy";

    private final String model;
    private final String voice;
    private final String systemPrompt;
    private final List<Map<String, String>> history;
    private final boolean isBetaPreview;
    private volatile String inputMode;
    private final AtomicBoolean initialized = new AtomicBoolean(false);

    public OpenAiRealtimeRelaySession(
            String baseUrl,
            String rawApiKey,
            String modelName,
            String voiceName,
            String systemPrompt,
            List<Map<String, String>> history,
            String proxyHost,
            Integer proxyPort,
            RelayEventListener listener
    ) {
        this(baseUrl, rawApiKey, modelName, voiceName, systemPrompt, history, "vad", proxyHost, proxyPort, listener);
    }

    public OpenAiRealtimeRelaySession(
            String baseUrl,
            String rawApiKey,
            String modelName,
            String voiceName,
            String systemPrompt,
            List<Map<String, String>> history,
            String inputMode,
            String proxyHost,
            Integer proxyPort,
            RelayEventListener listener
    ) {
        super(resolveWebSocketUrl(baseUrl, modelName), rawApiKey, proxyHost, proxyPort, listener);
        this.model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : DEFAULT_REALTIME_MODEL;
        this.voice = (voiceName != null && !voiceName.isBlank()) ? voiceName.trim() : DEFAULT_VOICE;
        this.systemPrompt = systemPrompt != null ? systemPrompt.trim() : "";
        this.history = trimRecentHistory(history);
        this.isBetaPreview = this.model.toLowerCase(Locale.ROOT).contains("preview");
        this.inputMode = normalizeInputMode(inputMode);
    }

    private static String normalizeInputMode(String raw) {
        return "ptt".equalsIgnoreCase(raw != null ? raw.trim() : "") ? "ptt" : "vad";
    }

    public void setInputMode(String mode) {
        String normalized = normalizeInputMode(mode);
        if (normalized.equals(this.inputMode)) {
            return;
        }
        this.inputMode = normalized;
        if (initialized.get() && !isClosed()) {
            sendSessionUpdate();
        }
    }

    public String getInputMode() {
        return inputMode;
    }

    public static String resolveWebSocketUrl(String baseUrl, String modelName) {
        String effectiveModel = (modelName != null && !modelName.isBlank()) ? modelName.trim() : DEFAULT_REALTIME_MODEL;
        String encodedModel = URLEncoder.encode(effectiveModel, StandardCharsets.UTF_8).replace("+", "%20");
        if (baseUrl == null || baseUrl.isBlank()) {
            return "wss://api.openai.com/v1/realtime?model=" + encodedModel;
        }
        String bUrl = baseUrl.trim();
        int hashIdx = bUrl.indexOf('#');
        if (hashIdx >= 0) {
            bUrl = bUrl.substring(0, hashIdx);
        }
        while (bUrl.endsWith("/")) {
            bUrl = bUrl.substring(0, bUrl.length() - 1);
        }
        if (bUrl.regionMatches(true, 0, "https://", 0, 8)) {
            bUrl = "wss://" + bUrl.substring(8);
        } else if (bUrl.regionMatches(true, 0, "http://", 0, 7)) {
            bUrl = "ws://" + bUrl.substring(7);
        }
        if (bUrl.contains("/realtime")) {
            if (bUrl.contains("model=")) {
                return bUrl;
            }
            return bUrl + (bUrl.contains("?") ? "&" : "?") + "model=" + encodedModel;
        }
        bUrl = com.bear27570.app.routes.ai.AiUrlGuard.stripQueryAndFragment(bUrl);
        if (bUrl.endsWith("/chat/completions")) {
            bUrl = bUrl.substring(0, bUrl.length() - "/chat/completions".length());
        }
        if (bUrl.matches(".*/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/realtime?model=" + encodedModel;
        }
        return bUrl + "/v1/realtime?model=" + encodedModel;
    }

    @Override
    protected String getRelayName() {
        return "OpenAiRealtimeRelay";
    }

    @Override
    protected void configureHeaders(WebSocket.Builder builder) {
        if (!rawApiKey.isEmpty()) {
            builder.header("Authorization", "Bearer " + rawApiKey);
        }
        if (isBetaPreview) {
            builder.header("OpenAI-Beta", "realtime=v1");
        }
    }

    @Override
    protected void onUpstreamConnected() {
        // Wait for upstream `session.created` before issuing `session.update`
    }

    @Override
    protected void onUpstreamJsonMessage(JsonObject root) {
        String type = AiStreamSupport.getNonEmptyString(root, "type");
        if (type == null) return;

        switch (type) {
            case "session.created" -> handleSessionCreated();
            case "response.output_audio.delta", "response.audio.delta" -> {
                String delta = AiStreamSupport.getNonEmptyString(root, "delta");
                if (delta != null) {
                    JsonObject evt = new JsonObject();
                    evt.addProperty("type", "audio");
                    evt.addProperty("data", delta);
                    evt.addProperty("sampleRate", 24000);
                    evt.addProperty("mimeType", "audio/pcm;rate=24000");
                    listener.onEvent(evt);
                }
            }
            case "response.output_audio_transcript.delta", "response.audio_transcript.delta" -> {
                String delta = AiStreamSupport.getNonEmptyString(root, "delta");
                if (delta != null) {
                    JsonObject evt = new JsonObject();
                    evt.addProperty("type", "transcript");
                    evt.addProperty("role", "assistant");
                    evt.addProperty("text", delta);
                    evt.addProperty("interim", false);
                    listener.onEvent(evt);
                }
            }
            case "conversation.item.input_audio_transcription.delta" -> {
                String delta = AiStreamSupport.getNonEmptyString(root, "delta");
                if (delta != null) {
                    JsonObject evt = new JsonObject();
                    evt.addProperty("type", "transcript");
                    evt.addProperty("role", "user");
                    evt.addProperty("text", delta);
                    evt.addProperty("interim", false);
                    listener.onEvent(evt);
                }
            }
            case "conversation.item.input_audio_transcription.completed" -> {
                String transcript = AiStreamSupport.getNonEmptyString(root, "transcript");
                if (transcript != null) {
                    JsonObject evt = new JsonObject();
                    evt.addProperty("type", "transcript");
                    evt.addProperty("role", "user");
                    evt.addProperty("text", transcript);
                    evt.addProperty("replace", true);
                    evt.addProperty("final", true);
                    listener.onEvent(evt);
                }
            }
            case "input_audio_buffer.speech_started" -> {
                JsonObject evt = new JsonObject();
                evt.addProperty("type", "interrupted");
                listener.onEvent(evt);
            }
            case "response.done" -> {
                if (root.has("response") && root.get("response").isJsonObject()) {
                    JsonObject resp = root.getAsJsonObject("response");
                    if (resp.has("usage") && resp.get("usage").isJsonObject()) {
                        JsonObject rawUsage = resp.getAsJsonObject("usage");
                        JsonObject usage = new JsonObject();
                        int inTok = AiStreamSupport.getIntOrDefault(rawUsage, "input_tokens", 0);
                        int outTok = AiStreamSupport.getIntOrDefault(rawUsage, "output_tokens", 0);
                        int total = AiStreamSupport.getIntOrDefault(rawUsage, "total_tokens", inTok + outTok);
                        usage.addProperty("promptTokens", inTok);
                        usage.addProperty("completionTokens", outTok);
                        usage.addProperty("totalTokens", total);
                        JsonObject usageEvt = new JsonObject();
                        usageEvt.addProperty("type", "usage");
                        usageEvt.add("usage", usage);
                        listener.onEvent(usageEvt);
                    }
                }
                JsonObject doneEvt = new JsonObject();
                doneEvt.addProperty("type", "turn_complete");
                doneEvt.addProperty("turnComplete", true);
                listener.onEvent(doneEvt);
            }
            case "error" -> {
                String msg = "Upstream realtime error";
                if (root.has("error") && root.get("error").isJsonObject()) {
                    JsonObject err = root.getAsJsonObject("error");
                    String m = AiStreamSupport.getNonEmptyString(err, "message");
                    if (m != null) msg = m;
                }
                listener.onError("UPSTREAM_ERROR", msg);
            }
            default -> {
                // Ignore informational events (session.updated, rate_limits.updated, etc.)
            }
        }
    }

    private void handleSessionCreated() {
        if (!initialized.compareAndSet(false, true)) {
            return;
        }
        sendSessionUpdate();
        seedInitialHistory();

        JsonObject readyEvt = new JsonObject();
        readyEvt.addProperty("type", "ready");
        readyEvt.addProperty("engine", "openai-realtime");
        readyEvt.addProperty("model", model);
        readyEvt.addProperty("voice", voice);
        readyEvt.addProperty("inputSampleRate", 24000);
        readyEvt.addProperty("outputSampleRate", 24000);
        runAfterPendingSends(() -> listener.onEvent(readyEvt));
    }

    private void sendSessionUpdate() {
        JsonObject session = new JsonObject();
        if (isBetaPreview) {
            JsonArray modalities = new JsonArray();
            modalities.add("audio");
            modalities.add("text");
            session.add("modalities", modalities);
            if (!systemPrompt.isEmpty()) {
                session.addProperty("instructions", systemPrompt);
            }
            session.addProperty("voice", voice);
            session.addProperty("input_audio_format", "pcm16");
            session.addProperty("output_audio_format", "pcm16");

            JsonObject transcription = new JsonObject();
            transcription.addProperty("model", "whisper-1");
            session.add("input_audio_transcription", transcription);

            if ("ptt".equals(inputMode)) {
                session.add("turn_detection", JsonNull.INSTANCE);
            } else {
                JsonObject turnDetection = new JsonObject();
                turnDetection.addProperty("type", "server_vad");
                turnDetection.addProperty("create_response", true);
                turnDetection.addProperty("interrupt_response", true);
                session.add("turn_detection", turnDetection);
            }
        } else {
            session.addProperty("type", "realtime");
            JsonArray outputModalities = new JsonArray();
            outputModalities.add("audio");
            session.add("output_modalities", outputModalities);
            if (!systemPrompt.isEmpty()) {
                session.addProperty("instructions", systemPrompt);
            }

            JsonObject pcmFormat = new JsonObject();
            pcmFormat.addProperty("type", "audio/pcm");
            pcmFormat.addProperty("rate", 24000);

            JsonObject inputAudio = new JsonObject();
            inputAudio.add("format", pcmFormat.deepCopy());
            JsonObject transcription = new JsonObject();
            transcription.addProperty("model", "gpt-4o-mini-transcribe");
            inputAudio.add("transcription", transcription);
            if ("ptt".equals(inputMode)) {
                inputAudio.add("turn_detection", JsonNull.INSTANCE);
            } else {
                JsonObject turnDetection = new JsonObject();
                turnDetection.addProperty("type", "server_vad");
                turnDetection.addProperty("create_response", true);
                turnDetection.addProperty("interrupt_response", true);
                inputAudio.add("turn_detection", turnDetection);
            }

            JsonObject outputAudio = new JsonObject();
            outputAudio.add("format", pcmFormat);
            outputAudio.addProperty("voice", voice);

            JsonObject audio = new JsonObject();
            audio.add("input", inputAudio);
            audio.add("output", outputAudio);
            session.add("audio", audio);
        }

        JsonObject update = new JsonObject();
        update.addProperty("type", "session.update");
        update.add("session", session);
        sendJson(update);
    }

    private void seedInitialHistory() {
        for (Map<String, String> msg : history) {
            String role = "assistant".equals(msg.get("role")) ? "assistant" : "user";
            JsonObject contentPart = new JsonObject();
            contentPart.addProperty("type", "assistant".equals(role) ? "output_text" : "input_text");
            contentPart.addProperty("text", msg.get("content"));
            JsonArray contentArr = new JsonArray();
            contentArr.add(contentPart);

            JsonObject item = new JsonObject();
            item.addProperty("type", "message");
            item.addProperty("role", role);
            item.add("content", contentArr);

            JsonObject create = new JsonObject();
            create.addProperty("type", "conversation.item.create");
            create.add("item", item);
            sendJson(create);
        }
    }

    @Override
    public void sendAudio(String base64Pcm) {
        if (base64Pcm == null || base64Pcm.isBlank() || isClosed()) return;
        JsonObject evt = new JsonObject();
        evt.addProperty("type", "input_audio_buffer.append");
        evt.addProperty("audio", base64Pcm);
        sendJson(evt);
    }

    @Override
    public void sendAudioEnd(boolean commit) {
        if (isClosed() || !commit || !"ptt".equals(this.inputMode)) return;
        JsonObject commitEvt = new JsonObject();
        commitEvt.addProperty("type", "input_audio_buffer.commit");
        sendJson(commitEvt);

        JsonObject respEvt = new JsonObject();
        respEvt.addProperty("type", "response.create");
        sendJson(respEvt);
    }

    @Override
    public void sendText(String text) {
        if (text == null || text.isBlank() || isClosed()) return;
        JsonObject contentPart = new JsonObject();
        contentPart.addProperty("type", "input_text");
        contentPart.addProperty("text", text.trim());
        JsonArray contentArr = new JsonArray();
        contentArr.add(contentPart);

        JsonObject item = new JsonObject();
        item.addProperty("type", "message");
        item.addProperty("role", "user");
        item.add("content", contentArr);

        JsonObject create = new JsonObject();
        create.addProperty("type", "conversation.item.create");
        create.add("item", item);
        sendJson(create);

        JsonObject respEvt = new JsonObject();
        respEvt.addProperty("type", "response.create");
        sendJson(respEvt);
    }

    @Override
    public void interrupt() {
        if (isClosed()) return;
        JsonObject cancelEvt = new JsonObject();
        cancelEvt.addProperty("type", "response.cancel");
        sendJson(cancelEvt);
    }
}
