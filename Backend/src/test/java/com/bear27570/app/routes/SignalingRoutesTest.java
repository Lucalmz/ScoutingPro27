package com.bear27570.app.routes;

import io.javalin.Javalin;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class SignalingRoutesTest {

    private static final class RecordingListener implements WebSocket.Listener {
        final List<String> receivedMessages = new CopyOnWriteArrayList<>();
        final CountDownLatch openLatch = new CountDownLatch(1);
        final CountDownLatch closeLatch = new CountDownLatch(1);
        volatile CountDownLatch nextMessageLatch;
        private final StringBuilder partialBuffer = new StringBuilder();

        void expectMessages(int count) {
            nextMessageLatch = new CountDownLatch(count);
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            openLatch.countDown();
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            partialBuffer.append(data);
            if (last) {
                receivedMessages.add(partialBuffer.toString());
                partialBuffer.setLength(0);
                CountDownLatch latch = nextMessageLatch;
                if (latch != null) {
                    latch.countDown();
                }
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            closeLatch.countDown();
            return null;
        }
    }

    private static void awaitCondition(java.util.function.BooleanSupplier condition, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(15);
        }
    }

    @Test
    void testWebSocketRelayRoomIsolationAndDisconnectCleanup() throws Exception {
        SignalingRoutes signalingRoutes = new SignalingRoutes();
        Javalin app = Javalin.create(config -> signalingRoutes.register(config.routes));
        app.start(0);
        int port = app.port();

        HttpClient httpClient = HttpClient.newHttpClient();
        WebSocket ws1 = null;
        WebSocket ws2 = null;
        WebSocket ws3 = null;

        try {
            RecordingListener listener1 = new RecordingListener();
            RecordingListener listener2 = new RecordingListener();
            RecordingListener listener3 = new RecordingListener();

            ws1 = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/signal/roomA"), listener1)
                    .get(5, TimeUnit.SECONDS);
            ws2 = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/signal/roomA"), listener2)
                    .get(5, TimeUnit.SECONDS);

            assertThat(listener1.openLatch.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(listener2.openLatch.await(5, TimeUnit.SECONDS)).isTrue();
            awaitCondition(() -> signalingRoutes.getPeerCount("roomA") == 2, 2000);
            assertThat(signalingRoutes.getActiveRoomCount()).isEqualTo(1);
            assertThat(signalingRoutes.getPeerCount("roomA")).isEqualTo(2);

            ws3 = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/signal/roomB"), listener3)
                    .get(5, TimeUnit.SECONDS);
            assertThat(listener3.openLatch.await(5, TimeUnit.SECONDS)).isTrue();
            awaitCondition(() -> signalingRoutes.getPeerCount("roomB") == 1, 2000);
            assertThat(signalingRoutes.getActiveRoomCount()).isEqualTo(2);

            String sdpPayload = "{\"type\":\"offer\",\"sdp\":\"v=0 mock-sdp\"}";
            listener2.expectMessages(1);
            ws1.sendText(sdpPayload, true).get(5, TimeUnit.SECONDS);

            assertThat(listener2.nextMessageLatch.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(listener2.receivedMessages).containsExactly(sdpPayload);
            assertThat(listener1.receivedMessages).isEmpty();
            assertThat(listener3.receivedMessages).isEmpty();

            String icePayload = "{\"type\":\"ice\",\"candidate\":\"cand:1 1 udp\"}";
            listener1.expectMessages(1);
            ws2.sendText(icePayload, true).get(5, TimeUnit.SECONDS);

            assertThat(listener1.nextMessageLatch.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(listener1.receivedMessages).containsExactly(icePayload);
            assertThat(listener2.receivedMessages).containsExactly(sdpPayload);
            assertThat(listener3.receivedMessages).isEmpty();

            CompletableFuture.allOf(
                    ws1.sendClose(WebSocket.NORMAL_CLOSURE, "done"),
                    ws2.sendClose(WebSocket.NORMAL_CLOSURE, "done"),
                    ws3.sendClose(WebSocket.NORMAL_CLOSURE, "done")
            ).get(5, TimeUnit.SECONDS);

            awaitCondition(() -> signalingRoutes.getActiveRoomCount() == 0, 3000);
            assertThat(signalingRoutes.getPeerCount("roomA")).isEqualTo(0);
            assertThat(signalingRoutes.getPeerCount("roomB")).isEqualTo(0);
            assertThat(signalingRoutes.getActiveRoomCount()).isEqualTo(0);
        } finally {
            for (WebSocket ws : new WebSocket[]{ws1, ws2, ws3}) {
                if (ws != null) {
                    try {
                        ws.abort();
                    } catch (Exception ignored) {}
                }
            }
            app.stop();
        }
    }
}
