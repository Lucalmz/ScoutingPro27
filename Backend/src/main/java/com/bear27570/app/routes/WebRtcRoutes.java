package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.util.Map;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class WebRtcRoutes {

    private final Jdbi jdbi;
    private final Gson gson;

    public WebRtcRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.post("/api/webrtc/handshake-ticket", ctx -> {
            String userId = ctx.attribute("userId");
            User user = jdbi.withExtension(UserDao.class, dao -> dao.findById(userId));
            if (user == null) {
                ctx.status(404).result("User not found");
                return;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String eventId = asString(body.get("eventId"));
            String ecdhPublicKey = asString(body.get("ecdhPublicKey"));
            if (eventId == null || eventId.isBlank() || ecdhPublicKey == null || ecdhPublicKey.isBlank()) {
                ctx.status(400).result("eventId and ecdhPublicKey are required");
                return;
            }

            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> {
                ScoutingEvent e = dao.findById(eventId);
                if (e != null) return e;
                return dao.findByInviteCode(eventId);
            });
            if (event == null) {
                ctx.status(404).result("Event not found");
                return;
            }

            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(event.getId(), userId));
            if (!isMember) {
                ctx.status(403).result("User is not a member of this event");
                return;
            }

            String ticket = JwtUtil.generateWebRtcTicket(user.getId(), user.getUsername(), event.getId(), ecdhPublicKey);
            ctx.result(gson.toJson(Map.of(
                    "ticket", ticket,
                    "expiresIn", JwtUtil.HANDSHAKE_TICKET_EXPIRATION_MS / 1000
            ))).contentType("application/json");
        });

        routes.post("/api/webrtc/verify-ticket", ctx -> {
            String callerUserId = ctx.attribute("userId");
            if (callerUserId == null || callerUserId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Missing or invalid token");
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String ticket = asString(body.get("ticket"));
            String eventId = asString(body.get("eventId"));
            String ecdhPublicKey = asString(body.get("ecdhPublicKey"));
            if (ticket == null || ticket.isBlank() || eventId == null || eventId.isBlank() || ecdhPublicKey == null || ecdhPublicKey.isBlank()) {
                ctx.status(400).result("ticket, eventId, and ecdhPublicKey are required");
                return;
            }

            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> {
                ScoutingEvent e = dao.findById(eventId);
                if (e != null) return e;
                return dao.findByInviteCode(eventId);
            });
            if (event == null) {
                ctx.status(404).result(gson.toJson(Map.of("valid", false, "error", "Event not found"))).contentType("application/json");
                return;
            }

            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(event.getId(), callerUserId));
            if (!isMember) {
                ctx.status(403).result(gson.toJson(Map.of("valid", false, "error", "Caller is not a member of this event"))).contentType("application/json");
                return;
            }

            JwtUtil.WebRtcTicketValidation validation =
                    JwtUtil.verifyWebRtcTicket(ticket, event.getId(), ecdhPublicKey);
            if (!validation.isValid()) {
                ctx.status(200).result(gson.toJson(Map.of(
                        "valid", false,
                        "error", validation.getErrorMessage()
                ))).contentType("application/json");
                return;
            }

            User user = jdbi.withExtension(UserDao.class, dao -> dao.findById(validation.getUserId()));
            if (user == null) {
                ctx.status(404).result(gson.toJson(Map.of("valid", false, "error", "User not found"))).contentType("application/json");
                return;
            }

            ctx.result(gson.toJson(Map.of(
                    "valid", true,
                    "userId", user.getId(),
                    "username", user.getUsername(),
                    "eventId", event.getId()
            ))).contentType("application/json");
        });
    }
}
