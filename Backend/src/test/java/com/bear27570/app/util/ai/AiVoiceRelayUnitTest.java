package com.bear27570.app.util.ai;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import org.junit.jupiter.api.Test;

import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class AiVoiceRelayUnitTest {

    private static final class StubRelay extends AbstractVoiceWsRelay {
        StubRelay(String wsUrl, String rawApiKey, RelayEventListener listener) {
            super(wsUrl, rawApiKey, null, null, listener);
        }

        @Override
        protected void configureHeaders(WebSocket.Builder builder) {}

        @Override
        protected void onUpstreamConnected() {
            JsonObject setup = new JsonObject();
            setup.addProperty("action", "setup_first");
            sendJson(setup);
        }

        @Override
        protected void onUpstreamJsonMessage(JsonObject json) {
            listener.onEvent(json);
        }

        @Override
        protected String getRelayName() {
            return "StubRelay";
        }

        @Override
        public void sendAudio(String base64Pcm) {}

        @Override
        public void sendAudioEnd(boolean commit) {}

        @Override
        public void sendText(String text) {}

        @Override
        public void interrupt() {}
    }

    @Test
    void testTrimRecentHistoryAndSampleRateAndProxyUrlHelpers() {
        assertThat(AbstractVoiceWsRelay.toHttpProxyProbeUrl("wss://generativelanguage.googleapis.com/ws"))
                .isEqualTo("https://generativelanguage.googleapis.com/ws");
        assertThat(AbstractVoiceWsRelay.toHttpProxyProbeUrl("ws://127.0.0.1:8080/rt"))
                .isEqualTo("http://127.0.0.1:8080/rt");
        assertThat(AbstractVoiceWsRelay.toHttpProxyProbeUrl(null)).isEmpty();

        assertThat(AbstractVoiceWsRelay.parseSampleRate("audio/pcm;rate=24000", 16000)).isEqualTo(24000);
        assertThat(AbstractVoiceWsRelay.parseSampleRate("audio/pcm;rate=16000", 24000)).isEqualTo(16000);
        assertThat(AbstractVoiceWsRelay.parseSampleRate("audio/pcm;rate=100", 24000)).isEqualTo(24000);
        assertThat(AbstractVoiceWsRelay.parseSampleRate(null, 24000)).isEqualTo(24000);

        List<Map<String, String>> turns = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            turns.add(Map.of("role", i % 2 == 0 ? "user" : "model", "content", "turn-" + i));
        }
        turns.add(Map.of("role", "user", "content", "   "));
        List<Map<String, String>> trimmed = AbstractVoiceWsRelay.trimRecentHistory(turns);
        assertThat(trimmed).hasSize(12);
        assertThat(trimmed.get(0).get("content")).isEqualTo("turn-4");
        assertThat(trimmed.get(1).get("role")).isEqualTo("assistant");
        assertThat(trimmed.get(11).get("content")).isEqualTo("turn-15");

        // Single huge turn > 12,000 chars gets clipped safely
        List<Map<String, String>> huge = List.of(Map.of("role", "user", "content", "X".repeat(15_000)));
        List<Map<String, String>> clipped = AbstractVoiceWsRelay.trimRecentHistory(huge);
        assertThat(clipped).hasSize(1);
        assertThat(clipped.get(0).get("content")).hasSize(12_000);
    }

    @Test
    void testPreConnectOutboundQueueAndIdempotentClose() {
        StubRelay relay = new StubRelay("wss://example.com/ws", "sk-key\r\nInject: 1", new AiVoiceRelaySession.RelayEventListener() {
            @Override public void onEvent(JsonObject event) {}
            @Override public void onError(String code, String message) {}
            @Override public void onClosed(int statusCode, String reason) {}
        });

        assertThat(relay.rawApiKey).isEqualTo("sk-keyInject: 1");
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "ping");
        relay.sendJson(msg);
        assertThat(relay.isClosed()).isFalse();

        relay.close();
        assertThat(relay.isClosed()).isTrue();
        // Idempotent second close
        relay.close();
    }

    @Test
    void testRelayReassemblyOversizedFrameAndConnectFailure() throws Exception {
        List<String> serverReceived = new CopyOnWriteArrayList<>();
        CountDownLatch serverReceivedLatch = new CountDownLatch(1);
        Javalin mockWs = Javalin.create(cfg -> {
            cfg.jetty.modifyWebSocketServletFactory(f -> {
                f.setMaxTextMessageSize(6 * 1024 * 1024);
                f.setMaxBinaryMessageSize(6 * 1024 * 1024);
            });
            cfg.routes.ws("/rt", ws -> {
                ws.onMessage(ctx -> {
                    serverReceived.add(ctx.message());
                    serverReceivedLatch.countDown();
                    if (ctx.message().contains("trigger_fragments")) {
                        // Send malformed JSON (ignored), then valid JSON as binary frame, then >4MB frame
                        ctx.send("not-json");
                        ctx.send(ByteBuffer.wrap("{\"ok\":true}".getBytes(StandardCharsets.UTF_8)));
                    } else if (ctx.message().contains("trigger_oversize")) {
                        String big = "{\"pad\":\"" + "a".repeat(AbstractVoiceWsRelay.MAX_INBOUND_FRAME_BYTES + 32) + "\"}";
                        ctx.send(big);
                    }
                });
            });
        }).start(0);

        try {
            BlockingQueue<JsonObject> events = new LinkedBlockingQueue<>();
            BlockingQueue<String> errors = new LinkedBlockingQueue<>();
            CountDownLatch closedLatch = new CountDownLatch(1);
            StubRelay relay = new StubRelay("ws://127.0.0.1:" + mockWs.port() + "/rt", "sk-test", new AiVoiceRelaySession.RelayEventListener() {
                @Override public void onEvent(JsonObject event) { events.add(event); }
                @Override public void onError(String code, String message) { errors.add(code + ":" + message); }
                @Override public void onClosed(int statusCode, String reason) { closedLatch.countDown(); }
            });

            // Enqueue message BEFORE connect() to test pre-connect flush
            JsonObject preMsg = new JsonObject();
            preMsg.addProperty("action", "trigger_fragments");
            relay.sendJson(preMsg);
            relay.connect();

            assertThat(serverReceivedLatch.await(5, TimeUnit.SECONDS)).isTrue();
            // Wait briefly for both setup_first and trigger_fragments to arrive in strict FIFO order (#18.5)
            long deadline = System.currentTimeMillis() + 3000;
            while (serverReceived.size() < 2 && System.currentTimeMillis() < deadline) {
                Thread.sleep(15);
            }
            assertThat(serverReceived.size()).isGreaterThanOrEqualTo(2);
            assertThat(serverReceived.get(0)).contains("setup_first");
            assertThat(serverReceived.get(1)).contains("trigger_fragments");

            JsonObject evt = events.poll(5, TimeUnit.SECONDS);
            assertThat(evt).isNotNull();
            assertThat(evt.get("ok").getAsBoolean()).isTrue();

            // Trigger >4MB frame -> UPSTREAM_WS_ERROR & relay closes
            JsonObject overMsg = new JsonObject();
            overMsg.addProperty("action", "trigger_oversize");
            relay.sendJson(overMsg);
            String err = errors.poll(5, TimeUnit.SECONDS);
            assertThat(err).isNotNull().contains("UPSTREAM_WS_ERROR");
            relay.close();

            // Connect to closed port -> UPSTREAM_CONNECT_FAILED
            BlockingQueue<String> failErrors = new LinkedBlockingQueue<>();
            int deadPort = mockWs.port();
            mockWs.stop();
            StubRelay failRelay = new StubRelay("ws://127.0.0.1:" + deadPort + "/rt", "sk-test", new AiVoiceRelaySession.RelayEventListener() {
                @Override public void onEvent(JsonObject event) {}
                @Override public void onError(String code, String message) { failErrors.add(code); }
                @Override public void onClosed(int statusCode, String reason) {}
            });
            failRelay.connect();
            assertThat(failErrors.poll(5, TimeUnit.SECONDS)).isEqualTo("UPSTREAM_CONNECT_FAILED");
            failRelay.close();
        } finally {
            try { mockWs.stop(); } catch (Exception ignored) {}
        }
    }

    @Test
    void testOpenAiBetaPreviewAndGeminiExtendedThinkingDirectSessionEvents() {
        assertThat(OpenAiRealtimeRelaySession.resolveWebSocketUrl("https://proxy.example.com/v1/chat/completions", "gpt-4o-realtime-preview"))
                .isEqualTo("wss://proxy.example.com/v1/realtime?model=gpt-4o-realtime-preview");
        assertThat(OpenAiRealtimeRelaySession.resolveWebSocketUrl("https://proxy.example.com/v1/realtime?model=custom", "ignored"))
                .isEqualTo("wss://proxy.example.com/v1/realtime?model=custom");
        assertThat(OpenAiRealtimeRelaySession.resolveWebSocketUrl("https://proxy.example.com", "gpt-realtime"))
                .isEqualTo("wss://proxy.example.com/v1/realtime?model=gpt-realtime");

        assertThat(GeminiLiveRelaySession.resolveWebSocketUrl("https://proxy.example.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"))
                .isEqualTo("wss://proxy.example.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
        assertThat(GeminiLiveRelaySession.resolveWebSocketUrl("https://proxy.example.com/v2"))
                .isEqualTo("wss://proxy.example.com/ws/google.ai.generativelanguage.v2.GenerativeService.BidiGenerateContent");
        assertThat(GeminiLiveRelaySession.resolveWebSocketUrl("https://proxy.example.com"))
                .isEqualTo("wss://proxy.example.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");

        // OpenAI Realtime direct event handling (beta preview + usage + completed transcript + upstream error)
        List<JsonObject> oaEvents = new ArrayList<>();
        List<String> oaErrors = new ArrayList<>();
        OpenAiRealtimeRelaySession oa = new OpenAiRealtimeRelaySession(
                "https://api.openai.com/v1", "sk-oa", "gpt-4o-realtime-preview", "alloy", "sys",
                List.of(Map.of("role", "user", "content", "hi"), Map.of("role", "assistant", "content", "hello")),
                "ptt", null, null,
                new AiVoiceRelaySession.RelayEventListener() {
                    @Override public void onEvent(JsonObject event) { oaEvents.add(event); }
                    @Override public void onError(String code, String message) { oaErrors.add(code + ":" + message); }
                    @Override public void onClosed(int statusCode, String reason) {}
                });
        assertThat(oa.getInputMode()).isEqualTo("ptt");

        oa.onUpstreamJsonMessage(JsonParser.parseString("{\"type\":\"session.created\"}").getAsJsonObject());
        oa.onUpstreamJsonMessage(JsonParser.parseString("{\"type\":\"conversation.item.input_audio_transcription.delta\",\"delta\":\"par\"}").getAsJsonObject());
        oa.onUpstreamJsonMessage(JsonParser.parseString("{\"type\":\"conversation.item.input_audio_transcription.completed\",\"transcript\":\"partial full\"}").getAsJsonObject());
        oa.onUpstreamJsonMessage(JsonParser.parseString("{\"type\":\"response.done\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"total_tokens\":20}}}").getAsJsonObject());
        oa.onUpstreamJsonMessage(JsonParser.parseString("{\"type\":\"error\",\"error\":{\"message\":\"Quota exceeded\"}}").getAsJsonObject());

        assertThat(oaEvents).anyMatch(e -> "transcript".equals(e.get("type").getAsString()) && e.has("replace") && e.get("final").getAsBoolean());
        assertThat(oaEvents).anyMatch(e -> "usage".equals(e.get("type").getAsString()) && e.getAsJsonObject("usage").get("totalTokens").getAsInt() == 20);
        assertThat(oaEvents).anyMatch(e -> "turn_complete".equals(e.get("type").getAsString()));
        assertThat(oaErrors).containsExactly("UPSTREAM_ERROR:Quota exceeded");
        oa.close();

        // Gemini Live direct event handling (goAway + usageMetadata with thoughts + interim + interactionStatus + error)
        List<JsonObject> gemEvents = new ArrayList<>();
        List<String> gemErrors = new ArrayList<>();
        GeminiLiveRelaySession gem = new GeminiLiveRelaySession(
                "https://generativelanguage.googleapis.com/v1beta", "AIza", "models/gemini-extended-thinking", "Kore", "sys",
                List.of(Map.of("role", "user", "content", "q1")), null, null,
                new AiVoiceRelaySession.RelayEventListener() {
                    @Override public void onEvent(JsonObject event) { gemEvents.add(event); }
                    @Override public void onError(String code, String message) { gemErrors.add(code + ":" + message); }
                    @Override public void onClosed(int statusCode, String reason) {}
                });
        gem.onUpstreamJsonMessage(JsonParser.parseString("{\"goAway\":{\"timeLeft\":\"30s\"}}").getAsJsonObject());
        gem.onUpstreamJsonMessage(JsonParser.parseString("{\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5,\"thoughtsTokenCount\":3,\"totalTokenCount\":18}}").getAsJsonObject());
        gem.onUpstreamJsonMessage(JsonParser.parseString("{\"interactionStatus\":\"IN_PROGRESS\"}").getAsJsonObject());
        gem.onUpstreamJsonMessage(JsonParser.parseString("{\"serverContent\":{\"interimInputTranscription\":{\"text\":\"wait\"},\"modelTurn\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"abc\"}}]},\"generationComplete\":true}}").getAsJsonObject());
        gem.onUpstreamJsonMessage(JsonParser.parseString("{\"error\":{\"message\":\"Bad model\"}}").getAsJsonObject());

        assertThat(gemEvents).anyMatch(e -> "go_away".equals(e.get("type").getAsString()) && "30s".equals(e.get("timeLeft").getAsString()));
        assertThat(gemEvents).anyMatch(e -> "usage".equals(e.get("type").getAsString()) && e.getAsJsonObject("usage").get("thoughtsTokens").getAsInt() == 3);
        assertThat(gemEvents).anyMatch(e -> "status".equals(e.get("type").getAsString()) && "IN_PROGRESS".equals(e.get("interactionStatus").getAsString()));
        assertThat(gemEvents).anyMatch(e -> "transcript".equals(e.get("type").getAsString()) && e.get("interim").getAsBoolean());
        assertThat(gemEvents).noneMatch(e -> "audio".equals(e.get("type").getAsString()));
        assertThat(gemErrors).containsExactly("UPSTREAM_ERROR:Bad model");
        gem.close();
    }
}
