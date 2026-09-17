package com.bear27570.app.routes;

import io.javalin.config.RoutesConfig;
import io.javalin.websocket.WsContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 线下离线赛场纯内网轻量 WebSocket 信令中继路由。
 * 在完全断网或无公网连接的封闭体育馆内，主控电脑自身充当信令房间广播器。
 * 零外网依赖、纯内存操作、毫秒级交互。
 */
public class SignalingRoutes {
    private static final Logger logger = LoggerFactory.getLogger(SignalingRoutes.class);

    // room -> Set of active WsContext
    private final ConcurrentHashMap<String, Set<WsContext>> roomPeers = new ConcurrentHashMap<>();

    public void register(RoutesConfig routes) {
        routes.ws("/ws/signal/{room}", ws -> {
            ws.onConnect(ctx -> {
                String room = ctx.pathParam("room");
                roomPeers.computeIfAbsent(room, k -> ConcurrentHashMap.newKeySet()).add(ctx);
                logger.info("[Signaling LAN] Client connected to room [{}] (room size: {})", 
                        room, roomPeers.get(room).size());
            });

            ws.onMessage(ctx -> {
                String room = ctx.pathParam("room");
                String message = ctx.message();
                Set<WsContext> peers = roomPeers.get(room);
                if (peers != null && !peers.isEmpty()) {
                    for (WsContext peer : peers) {
                        // 广播给房间内的所有其他对端
                        if (!peer.equals(ctx)) {
                            try {
                                peer.send(message);
                            } catch (Exception e) {
                                logger.warn("[Signaling LAN] Failed to forward signal to peer: {}", e.getMessage());
                            }
                        }
                    }
                }
            });

            ws.onClose(ctx -> {
                String room = ctx.pathParam("room");
                Set<WsContext> peers = roomPeers.get(room);
                if (peers != null) {
                    peers.remove(ctx);
                    if (peers.isEmpty()) {
                        roomPeers.remove(room);
                    }
                }
                logger.info("[Signaling LAN] Client disconnected from room [{}]", room);
            });

            ws.onError(ctx -> {
                String room = ctx.pathParam("room");
                Set<WsContext> peers = roomPeers.get(room);
                if (peers != null) {
                    peers.remove(ctx);
                    if (peers.isEmpty()) {
                        roomPeers.remove(room);
                    }
                }
                logger.warn("[Signaling LAN] Error on client in room [{}]: {}", room, 
                        ctx.error() != null ? ctx.error().getMessage() : "unknown error");
            });
        });
    }

    public int getActiveRoomCount() {
        return roomPeers.size();
    }

    public int getPeerCount(String room) {
        Set<WsContext> peers = roomPeers.get(room);
        return peers != null ? peers.size() : 0;
    }
}
