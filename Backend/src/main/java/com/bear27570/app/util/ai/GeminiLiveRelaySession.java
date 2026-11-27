package com.bear27570.app.util.ai;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.net.http.WebSocket;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bidirectional WebSocket relay for Google Gemini Live API (`BidiGenerateContent`).
 * Handles setup handshake, sliding-window compression, audio/text/transcript events,
 * barge-in interruptions, and recent conversation history seeding.
 */
public final class GeminiLiveRelaySession extends AbstractVoiceWsRelay {
    public static final String DEFAULT_LIVE_MODEL = "gemini-3.8-live";
    public static final String DEFAULT_VOICE = "Kore";
    private static final String DEFAULT_WS_ENDPOINT =
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

    private final String model;
    private final String voice;
    private final String systemPrompt;
    private final List<Map<String, String>> history;
    private final AtomicBoolean readyEmitted = new AtomicBoolean(false);

    public GeminiLiveRelaySession(
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
        super(resolveWebSocketUrl(baseUrl), rawApiKey, proxyHost, proxyPort, listener);
        String resolvedModel = (modelName != null && !modelName.isBlank()) ? modelName.trim() : DEFAULT_LIVE_MODEL;
        if (resolvedModel.startsWith("models/")) {
            resolvedModel = resolvedModel.substring(7);
        }
        this.model = resolvedModel;
        this.voice = (voiceName != null && !voiceName.isBlank()) ? voiceName.trim() : DEFAULT_VOICE;
        this.systemPrompt = systemPrompt != null ? systemPrompt.trim() : "";
        this.history = trimRecentHistory(history);
    }

    public static String resolveWebSocketUrl(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return DEFAULT_WS_ENDPOINT;
        }
        String bUrl = com.bear27570.app.routes.ai.AiUrlGuard.stripQueryAndFragment(baseUrl);
        if (bUrl.regionMatches(true, 0, "https://", 0, 8)) {
            bUrl = "wss://" + bUrl.substring(8);
        } else if (bUrl.regionMatches(true, 0, "http://", 0, 7)) {
            bUrl = "ws://" + bUrl.substring(7);
        }
        if (bUrl.contains("BidiGenerateContent")) {
            return bUrl;
        }

        String apiVersion = "v1beta";
        String prefix = bUrl;
        if (bUrl.endsWith("/v1alpha")) {
            apiVersion = "v1alpha";
            prefix = bUrl.substring(0, bUrl.length() - "/v1alpha".length());
        } else if (bUrl.endsWith("/v1beta")) {
            apiVersion = "v1beta";
            prefix = bUrl.substring(0, bUrl.length() - "/v1beta".length());
        } else if (bUrl.matches(".*/v[0-9]+[a-zA-Z0-9_-]*$")) {
            int slashIdx = bUrl.lastIndexOf('/');
            apiVersion = bUrl.substring(slashIdx + 1);
            prefix = bUrl.substring(0, slashIdx);
        }

        return prefix + "/ws/google.ai.generativelanguage." + apiVersion + ".GenerativeService.BidiGenerateContent";
    }

    @Override
    protected String getRelayName() {
        return "GeminiLiveRelay";
    }

    @Override
    protected void configureHeaders(WebSocket.Builder builder) {
        if (!rawApiKey.isEmpty()) {
            builder.header("x-goog-api-key", rawApiKey);
        }
    }

    @Override
    protected void onUpstreamConnected() {
        JsonObject setup = new JsonObject();
        setup.addProperty("model", "models/" + model);

        JsonObject generationConfig = new JsonObject();
        JsonArray modalities = new JsonArray();
        modalities.add("AUDIO");
        generationConfig.add("responseModalities", modalities);

        JsonObject prebuiltVoice = new JsonObject();
        prebuiltVoice.addProperty("voiceName", voice);
        JsonObject voiceConfig = new JsonObject();
        voiceConfig.add("prebuiltVoiceConfig", prebuiltVoice);
        JsonObject speechConfig = new JsonObject();
        speechConfig.add("voiceConfig", voiceConfig);
        generationConfig.add("speechConfig", speechConfig);

        if (model.toLowerCase(Locale.ROOT).contains("extended-thinking")) {
            JsonObject thinkingConfig = new JsonObject();
            thinkingConfig.addProperty("thinkingLevel", "LOW");
            generationConfig.add("thinkingConfig", thinkingConfig);
        }
        setup.add("generationConfig", generationConfig);

        if (!systemPrompt.isEmpty()) {
            JsonObject sysInst = new JsonObject();
            JsonArray parts = new JsonArray();
            JsonObject part = new JsonObject();
            part.addProperty("text", systemPrompt);
            parts.add(part);
            sysInst.add("parts", parts);
            setup.add("systemInstruction", sysInst);
        }

        setup.add("inputAudioTranscription", new JsonObject());
        setup.add("outputAudioTranscription", new JsonObject());

        JsonObject compression = new JsonObject();
        compression.add("slidingWindow", new JsonObject());
        setup.add("contextWindowCompression", compression);
        setup.add("sessionResumption", new JsonObject());

        JsonObject wrapper = new JsonObject();
        wrapper.add("setup", setup);
        sendJson(wrapper);
    }

    @Override
    protected void onUpstreamJsonMessage(JsonObject root) {
        if (root.has("error") && root.get("error").isJsonObject()) {
            JsonObject err = root.getAsJsonObject("error");
            String msg = err.has("message") ? err.get("message").getAsString() : err.toString();
            listener.onError("UPSTREAM_ERROR", msg);
            return;
        }

        if (root.has("setupComplete")) {
            if (readyEmitted.compareAndSet(false, true)) {
                seedInitialHistory();
                JsonObject readyEvent = new JsonObject();
                readyEvent.addProperty("type", "ready");
                readyEvent.addProperty("engine", "gemini-live");
                readyEvent.addProperty("model", model);
                readyEvent.addProperty("voice", voice);
                readyEvent.addProperty("inputSampleRate", 16000);
                readyEvent.addProperty("outputSampleRate", 24000);
                runAfterPendingSends(() -> listener.onEvent(readyEvent));
            }
        }

        if (root.has("goAway") && root.get("goAway").isJsonObject()) {
            JsonObject goAway = root.getAsJsonObject("goAway");
            JsonObject evt = new JsonObject();
            evt.addProperty("type", "go_away");
            if (goAway.has("timeLeft") && !goAway.get("timeLeft").isJsonNull()) {
                evt.addProperty("timeLeft", goAway.get("timeLeft").getAsString());
            }
            listener.onEvent(evt);
        }

        if (root.has("usageMetadata") && root.get("usageMetadata").isJsonObject()) {
            JsonObject meta = root.getAsJsonObject("usageMetadata");
            int prompt = AiStreamSupport.getIntOrDefault(meta, "promptTokenCount", 0);
            int candidates = AiStreamSupport.getIntOrDefault(meta, "candidatesTokenCount", 0);
            int thoughts = AiStreamSupport.getIntOrDefault(meta, "thoughtsTokenCount", 0);
            int completion = candidates + thoughts;
            int total = AiStreamSupport.getIntOrDefault(meta, "totalTokenCount", prompt + completion);
            JsonObject usage = new JsonObject();
            usage.addProperty("promptTokens", prompt);
            usage.addProperty("completionTokens", completion);
            usage.addProperty("totalTokens", total);
            if (thoughts > 0) {
                usage.addProperty("thoughtsTokens", thoughts);
            }
            JsonObject evt = new JsonObject();
            evt.addProperty("type", "usage");
            evt.add("usage", usage);
            listener.onEvent(evt);
        }

        String topInteractionStatus = AiStreamSupport.getNonEmptyString(root, "interactionStatus");

        if (root.has("serverContent") && root.get("serverContent").isJsonObject()) {
            handleServerContent(root.getAsJsonObject("serverContent"), topInteractionStatus);
        } else if (topInteractionStatus != null) {
            JsonObject statusEvt = new JsonObject();
            statusEvt.addProperty("type", "status");
            statusEvt.addProperty("interactionStatus", topInteractionStatus);
            listener.onEvent(statusEvt);
        }
    }

    private void seedInitialHistory() {
        if (history.isEmpty()) return;
        JsonArray turns = new JsonArray();
        for (Map<String, String> item : history) {
            JsonObject content = new JsonObject();
            content.addProperty("role", "assistant".equals(item.get("role")) ? "model" : "user");
            JsonArray parts = new JsonArray();
            JsonObject part = new JsonObject();
            part.addProperty("text", item.get("content"));
            parts.add(part);
            content.add("parts", parts);
            turns.add(content);
        }
        JsonObject clientContent = new JsonObject();
        clientContent.add("turns", turns);
        clientContent.addProperty("turnComplete", false);
        JsonObject wrapper = new JsonObject();
        wrapper.add("clientContent", clientContent);
        sendJson(wrapper);
    }

    private void handleServerContent(JsonObject sc, String topInteractionStatus) {
        if (sc.has("interrupted") && !sc.get("interrupted").isJsonNull() && sc.get("interrupted").getAsBoolean()) {
            JsonObject evt = new JsonObject();
            evt.addProperty("type", "interrupted");
            listener.onEvent(evt);
        }

        if (sc.has("modelTurn") && sc.get("modelTurn").isJsonObject()) {
            JsonObject modelTurn = sc.getAsJsonObject("modelTurn");
            if (modelTurn.has("parts") && modelTurn.get("parts").isJsonArray()) {
                for (JsonElement el : modelTurn.getAsJsonArray("parts")) {
                    if (!el.isJsonObject()) continue;
                    JsonObject part = el.getAsJsonObject();
                    if (part.has("inlineData") && part.get("inlineData").isJsonObject()) {
                        JsonObject inline = part.getAsJsonObject("inlineData");
                        String data = AiStreamSupport.getNonEmptyString(inline, "data");
                        String mime = AiStreamSupport.getNonEmptyString(inline, "mimeType");
                        if (data != null && (mime == null || mime.toLowerCase(Locale.ROOT).startsWith("audio/"))) {
                            String effectiveMime = mime != null ? mime : "audio/pcm;rate=24000";
                            JsonObject audioEvt = new JsonObject();
                            audioEvt.addProperty("type", "audio");
                            audioEvt.addProperty("data", data);
                            audioEvt.addProperty("sampleRate", parseSampleRate(effectiveMime, 24000));
                            audioEvt.addProperty("mimeType", effectiveMime);
                            listener.onEvent(audioEvt);
                        }
                    }
                }
            }
        }

        emitTranscriptionIfPresent(sc, "interimInputTranscription", "user", true);
        emitTranscriptionIfPresent(sc, "inputTranscription", "user", false);
        emitTranscriptionIfPresent(sc, "outputTranscription", "assistant", false);

        String interactionStatus = AiStreamSupport.getNonEmptyString(sc, "interactionStatus");
        if (interactionStatus == null) {
            interactionStatus = topInteractionStatus;
        }
        if (interactionStatus != null) {
            JsonObject statusEvt = new JsonObject();
            statusEvt.addProperty("type", "status");
            statusEvt.addProperty("interactionStatus", interactionStatus);
            listener.onEvent(statusEvt);
        }

        boolean turnComplete = sc.has("turnComplete") && !sc.get("turnComplete").isJsonNull() && sc.get("turnComplete").getAsBoolean();
        boolean generationComplete = sc.has("generationComplete") && !sc.get("generationComplete").isJsonNull() && sc.get("generationComplete").getAsBoolean();
        if (turnComplete || generationComplete) {
            JsonObject doneEvt = new JsonObject();
            doneEvt.addProperty("type", "turn_complete");
            doneEvt.addProperty("turnComplete", turnComplete);
            doneEvt.addProperty("generationComplete", generationComplete);
            if (interactionStatus != null) {
                doneEvt.addProperty("interactionStatus", interactionStatus);
            }
            listener.onEvent(doneEvt);
        }
    }

    private void emitTranscriptionIfPresent(JsonObject sc, String field, String role, boolean interim) {
        if (!sc.has(field) || !sc.get(field).isJsonObject()) return;
        JsonObject trans = sc.getAsJsonObject(field);
        String text = AiStreamSupport.getNonEmptyString(trans, "text");
        if (text == null) return;
        JsonObject evt = new JsonObject();
        evt.addProperty("type", "transcript");
        evt.addProperty("role", role);
        evt.addProperty("text", text);
        evt.addProperty("interim", interim);
        listener.onEvent(evt);
    }

    @Override
    public void sendAudio(String base64Pcm) {
        if (base64Pcm == null || base64Pcm.isBlank() || isClosed()) return;
        JsonObject audio = new JsonObject();
        audio.addProperty("mimeType", "audio/pcm;rate=16000");
        audio.addProperty("data", base64Pcm);
        JsonObject realtimeInput = new JsonObject();
        realtimeInput.add("audio", audio);
        JsonObject wrapper = new JsonObject();
        wrapper.add("realtimeInput", realtimeInput);
        sendJson(wrapper);
    }

    @Override
    public void sendAudioEnd(boolean commit) {
        if (isClosed()) return;
        JsonObject realtimeInput = new JsonObject();
        realtimeInput.addProperty("audioStreamEnd", true);
        JsonObject wrapper = new JsonObject();
        wrapper.add("realtimeInput", realtimeInput);
        sendJson(wrapper);
    }

    @Override
    public void sendText(String text) {
        if (text == null || text.isBlank() || isClosed()) return;
        JsonObject realtimeInput = new JsonObject();
        realtimeInput.addProperty("text", text.trim());
        JsonObject wrapper = new JsonObject();
        wrapper.add("realtimeInput", realtimeInput);
        sendJson(wrapper);
    }

    @Override
    public void interrupt() {
        // Gemini Live interrupts automatically when user speech arrives; client playback queue is cleared locally.
    }
}
