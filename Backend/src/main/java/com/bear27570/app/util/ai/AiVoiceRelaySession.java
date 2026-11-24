package com.bear27570.app.util.ai;

import com.google.gson.JsonObject;

/**
 * Bidirectional realtime voice relay session bridging client browser/JCEF WebSockets
 * to upstream native-audio AI WebSocket endpoints (Gemini Live, OpenAI Realtime).
 */
public interface AiVoiceRelaySession {

    interface RelayEventListener {
        void onEvent(JsonObject event);
        void onError(String code, String message);
        void onClosed(int statusCode, String reason);
    }

    void connect();

    void sendAudio(String base64Pcm);

    void sendAudioEnd(boolean commit);

    void sendText(String text);

    void interrupt();

    void close();
}
