package com.bear27570.app.util.ai;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Shared serialized WebSocket transport base for realtime AI voice relay sessions.
 * Handles partial text/binary frame reassembly, single-threaded outbound writes (preventing
 * Java HttpClient WebSocket Send-pending conflicts), and clean shutdown.
 */
abstract class AbstractVoiceWsRelay implements AiVoiceRelaySession {
    private static final Logger logger = LoggerFactory.getLogger(AbstractVoiceWsRelay.class);
    private static final Gson GSON_SERIALIZE_NULLS = new GsonBuilder().serializeNulls().create();
    protected static final int MAX_HISTORY_TURNS = 12;
    protected static final int MAX_HISTORY_CHARS = 12_000;
    protected static final int MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024;
    private static final int MAX_PENDING_OUTBOUND = 128;

    protected final String wsUrl;
    protected final String rawApiKey;
    protected final String proxyHost;
    protected final Integer proxyPort;
    protected final RelayEventListener listener;

    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Object pendingLock = new Object();
    private final List<String> pendingOutbound = new ArrayList<>();
    private final ExecutorService sendExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "ai-voice-ws-send");
        t.setDaemon(true);
        return t;
    });

    private volatile WebSocket upstreamWs;

    protected AbstractVoiceWsRelay(
            String wsUrl,
            String rawApiKey,
            String proxyHost,
            Integer proxyPort,
            RelayEventListener listener
    ) {
        this.wsUrl = wsUrl;
        this.rawApiKey = com.bear27570.app.routes.ai.AiUrlGuard.stripControlChars(rawApiKey != null ? rawApiKey.trim() : "");
        this.proxyHost = proxyHost;
        this.proxyPort = proxyPort;
        this.listener = listener;
    }

    protected abstract void configureHeaders(WebSocket.Builder builder);

    protected abstract void onUpstreamConnected();

    protected abstract void onUpstreamJsonMessage(JsonObject json);

    protected abstract String getRelayName();

    @Override
    public void connect() {
        if (closed.get()) return;
        String proxyLookupUrl = toHttpProxyProbeUrl(wsUrl);
        HttpClient client = AiProxyResolver.buildHttpClient(proxyHost, proxyPort, proxyLookupUrl);
        WebSocket.Builder builder = client.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(15));
        configureHeaders(builder);

        builder.buildAsync(URI.create(wsUrl), new UpstreamListener())
                .whenComplete((ws, err) -> {
                    if (err != null) {
                        if (!closed.get()) {
                            Throwable root = err.getCause() != null ? err.getCause() : err;
                            String msg = root.getMessage() != null ? root.getMessage() : root.toString();
                            logger.warn("[{}] Failed to connect upstream WebSocket {}: {}", getRelayName(), wsUrl, msg);
                            listener.onError("UPSTREAM_CONNECT_FAILED", msg);
                        }
                        close();
                        return;
                    }
                    List<String> preConnect;
                    synchronized (pendingLock) {
                        if (closed.get()) {
                            closeWebSocketQuietly(ws);
                            return;
                        }
                        preConnect = new ArrayList<>(pendingOutbound);
                        pendingOutbound.clear();
                        this.upstreamWs = ws;
                        ws.request(1);
                        onUpstreamConnected();
                        for (String jsonStr : preConnect) {
                            submitSendToExecutor(ws, jsonStr);
                        }
                    }
                });
    }

    protected void sendJson(JsonObject payload) {
        if (closed.get() || payload == null) return;
        final String jsonStr = GSON_SERIALIZE_NULLS.toJson(payload);
        enqueueSendRaw(jsonStr);
    }

    private void enqueueSendRaw(String jsonStr) {
        WebSocket ws;
        synchronized (pendingLock) {
            if (closed.get() || sendExecutor.isShutdown()) return;
            ws = this.upstreamWs;
            if (ws == null) {
                if (pendingOutbound.size() < MAX_PENDING_OUTBOUND) {
                    pendingOutbound.add(jsonStr);
                }
                return;
            }
        }
        submitSendToExecutor(ws, jsonStr);
    }

    private void submitSendToExecutor(WebSocket ws, String jsonStr) {
        if (closed.get() || sendExecutor.isShutdown()) return;
        try {
            sendExecutor.execute(() -> {
                if (closed.get()) return;
                try {
                    ws.sendText(jsonStr, true).join();
                } catch (Exception e) {
                    if (!closed.get()) {
                        Throwable root = e.getCause() != null ? e.getCause() : e;
                        logger.warn("[{}] Outbound WebSocket send error: {}", getRelayName(), root.getMessage());
                        listener.onError("UPSTREAM_SEND_FAILED", root.getMessage() != null ? root.getMessage() : root.toString());
                        close();
                    }
                }
            });
        } catch (Exception ignored) {}
    }

    protected void runAfterPendingSends(Runnable action) {
        if (closed.get() || action == null || sendExecutor.isShutdown()) return;
        try {
            sendExecutor.execute(() -> {
                if (!closed.get()) {
                    action.run();
                }
            });
        } catch (Exception ignored) {}
    }

    protected boolean isClosed() {
        return closed.get();
    }

    @Override
    public void close() {
        WebSocket ws;
        synchronized (pendingLock) {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            ws = this.upstreamWs;
            this.upstreamWs = null;
            pendingOutbound.clear();
        }
        if (ws != null) {
            closeWebSocketQuietly(ws);
        }
        sendExecutor.shutdownNow();
    }

    private static void closeWebSocketQuietly(WebSocket ws) {
        if (ws == null) return;
        try {
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "Client closed");
        } catch (Exception ignored) {
            try {
                ws.abort();
            } catch (Exception ignored2) {}
        }
    }

    protected static String toHttpProxyProbeUrl(String wsUrl) {
        if (wsUrl == null) return "";
        if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.substring(6);
        if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.substring(5);
        return wsUrl;
    }

    protected static List<Map<String, String>> trimRecentHistory(List<Map<String, String>> history) {
        if (history == null || history.isEmpty()) return List.of();
        List<Map<String, String>> filtered = new ArrayList<>();
        for (Map<String, String> item : history) {
            if (item == null) continue;
            String content = item.get("content");
            if (content == null || content.isBlank()) continue;
            String rawRole = item.get("role");
            String role = ("assistant".equalsIgnoreCase(rawRole) || "model".equalsIgnoreCase(rawRole)) ? "assistant" : "user";
            Map<String, String> copy = new LinkedHashMap<>();
            copy.put("role", role);
            copy.put("content", content.trim());
            filtered.add(copy);
        }
        if (filtered.size() > MAX_HISTORY_TURNS) {
            filtered = new ArrayList<>(filtered.subList(filtered.size() - MAX_HISTORY_TURNS, filtered.size()));
        }
        int totalChars = 0;
        List<Map<String, String>> reversed = new ArrayList<>();
        for (int i = filtered.size() - 1; i >= 0; i--) {
            Map<String, String> item = filtered.get(i);
            String text = item.get("content");
            if (totalChars + text.length() > MAX_HISTORY_CHARS && !reversed.isEmpty()) {
                break;
            }
            if (text.length() > MAX_HISTORY_CHARS) {
                Map<String, String> clipped = new LinkedHashMap<>(item);
                clipped.put("content", text.substring(0, MAX_HISTORY_CHARS));
                reversed.add(clipped);
                break;
            }
            totalChars += text.length();
            reversed.add(item);
        }
        List<Map<String, String>> ordered = new ArrayList<>(reversed.size());
        for (int i = reversed.size() - 1; i >= 0; i--) {
            ordered.add(reversed.get(i));
        }
        return ordered;
    }

    protected static int parseSampleRate(String mimeType, int fallbackRate) {
        if (mimeType == null || mimeType.isBlank()) return fallbackRate;
        String lower = mimeType.toLowerCase(Locale.ROOT);
        int idx = lower.indexOf("rate=");
        if (idx < 0) return fallbackRate;
        int start = idx + 5;
        int end = start;
        while (end < lower.length() && Character.isDigit(lower.charAt(end))) {
            end++;
        }
        if (end > start) {
            try {
                int parsed = Integer.parseInt(lower.substring(start, end));
                if (parsed >= 8000 && parsed <= 96000) return parsed;
            } catch (NumberFormatException ignored) {}
        }
        return fallbackRate;
    }

    private final class UpstreamListener implements WebSocket.Listener {
        private final StringBuilder textBuffer = new StringBuilder();
        private final ByteArrayOutputStream binaryBuffer = new ByteArrayOutputStream();

        @Override
        public void onOpen(WebSocket webSocket) {
            // Handshake completion is driven via buildAsync().whenComplete so upstreamWs is guaranteed set
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            if (textBuffer.length() + data.length() > MAX_INBOUND_FRAME_BYTES) {
                textBuffer.setLength(0);
                logger.warn("[{}] Inbound text frame exceeded {} bytes limit", getRelayName(), MAX_INBOUND_FRAME_BYTES);
                listener.onError("UPSTREAM_WS_ERROR", "Inbound WebSocket frame exceeded 4 MB limit");
                close();
                return null;
            }
            textBuffer.append(data);
            if (last) {
                String payload = textBuffer.toString();
                textBuffer.setLength(0);
                dispatchRawPayload(payload);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            int remaining = data.remaining();
            if (binaryBuffer.size() + remaining > MAX_INBOUND_FRAME_BYTES) {
                binaryBuffer.reset();
                logger.warn("[{}] Inbound binary frame exceeded {} bytes limit", getRelayName(), MAX_INBOUND_FRAME_BYTES);
                listener.onError("UPSTREAM_WS_ERROR", "Inbound WebSocket binary frame exceeded 4 MB limit");
                close();
                return null;
            }
            byte[] bytes = new byte[remaining];
            data.get(bytes);
            binaryBuffer.write(bytes, 0, bytes.length);
            if (last) {
                String payload = binaryBuffer.toString(StandardCharsets.UTF_8);
                binaryBuffer.reset();
                dispatchRawPayload(payload);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            if (closed.compareAndSet(false, true)) {
                sendExecutor.shutdownNow();
                listener.onClosed(statusCode, reason != null ? reason : "");
            }
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            if (!closed.get()) {
                String msg = error != null && error.getMessage() != null ? error.getMessage() : String.valueOf(error);
                logger.warn("[{}] Upstream WebSocket error: {}", getRelayName(), msg);
                listener.onError("UPSTREAM_WS_ERROR", msg);
            }
            close();
        }

        private void dispatchRawPayload(String payload) {
            if (closed.get() || payload == null || payload.isBlank()) return;
            try {
                JsonObject obj = JsonParser.parseString(payload).getAsJsonObject();
                onUpstreamJsonMessage(obj);
            } catch (Exception e) {
                logger.warn("[{}] Failed to parse upstream WS JSON message: {}", getRelayName(), e.getMessage());
            }
        }
    }
}
