package com.bear27570.app.routes;

import com.bear27570.app.dao.BannedTeamDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.EventMember;
import com.bear27570.app.model.ScoutingEvent;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class EventRoutes {

    private final Jdbi jdbi;
    private final Gson gson;

    public EventRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/events", ctx -> {
            String userId = ctx.attribute("userId");
            List<ScoutingEvent> events = jdbi.withExtension(EventDao.class, dao -> dao.findForUser(userId));
            ctx.result(gson.toJson(events)).contentType("application/json");
        });

        routes.post("/api/events", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String userId = ctx.attribute("userId");
            ScoutingEvent event = new ScoutingEvent();
            event.setId(UUID.randomUUID().toString());
            event.setName(asString(body.get("name")));
            event.setHostId(userId);
            jdbi.useExtension(EventDao.class, dao -> {
                event.setInviteCode(generateInviteCode(dao));
                dao.insert(event);
                dao.joinEvent(event.getId(), userId);
            });
            ctx.result(gson.toJson(Map.of("id", event.getId(), "inviteCode", event.getInviteCode())))
               .contentType("application/json");
        });

        routes.post("/api/events/join", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String inviteCode = asString(body.get("inviteCode"));
            
            if (inviteCode == null || inviteCode.isBlank()) {
                ctx.status(400).result("Missing inviteCode");
                return;
            }

            String userId = ctx.attribute("userId");
            String normalizedCode = inviteCode.trim().toUpperCase();

            ScoutingEvent evt = jdbi.inTransaction(handle -> {
                EventDao dao = handle.attach(EventDao.class);
                UserDao userDao = handle.attach(UserDao.class);

                ScoutingEvent e = dao.findByInviteCode(normalizedCode);
                if (e != null) {
                    dao.joinEvent(e.getId(), userId);
                    return e;
                }

                // Distributed multi-device support: If event was created on another physical machine,
                // create an external event stub in local DB so the user can immediately enter the room.
                String extEventId = "ext_" + normalizedCode;
                String extHostId = "external_host";
                userDao.ensureScoutUserPlaceholder(extHostId, "External Host");

                ScoutingEvent stub = new ScoutingEvent();
                stub.setId(extEventId);
                stub.setName("Remote Event (" + normalizedCode + ")");
                stub.setInviteCode(normalizedCode);
                stub.setHostId(extHostId);

                dao.insert(stub);
                dao.joinEvent(extEventId, userId);
                return dao.findById(extEventId);
            });
            
            ctx.status(200).result(gson.toJson(evt)).contentType("application/json");
        });

        routes.post("/api/events/external-sync", ctx -> {
            String userId = ctx.attribute("userId");
            if (userId == null || userId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            ScoutingEvent incoming = gson.fromJson(ctx.body(), ScoutingEvent.class);
            if (incoming == null || incoming.getId() == null || incoming.getInviteCode() == null) {
                ctx.status(400).result("Invalid event payload");
                return;
            }

            ScoutingEvent synced = jdbi.inTransaction(handle -> {
                UserDao userDao = handle.attach(UserDao.class);
                EventDao eventDao = handle.attach(EventDao.class);

                String hostId = incoming.getHostId() != null && !incoming.getHostId().isBlank() ? incoming.getHostId() : userId;
                userDao.ensureScoutUserPlaceholder(hostId, "Host " + hostId.substring(0, Math.min(6, hostId.length())));

                String normalizedCode = incoming.getInviteCode().trim().toUpperCase();

                // If an existing event (such as a temporary distributed stub 'ext_...') is currently using this inviteCode,
                // unbind its invite_code first so the UNIQUE constraint on invite_code is not violated when inserting/updating the authoritative event.
                ScoutingEvent existingByCode = eventDao.findByInviteCode(normalizedCode);
                if (existingByCode != null && !existingByCode.getId().equals(incoming.getId())) {
                    handle.execute("UPDATE events SET invite_code = NULL WHERE id = ?", existingByCode.getId());
                }

                ScoutingEvent existing = eventDao.findById(incoming.getId());
                if (existing == null) {
                    incoming.setInviteCode(normalizedCode);
                    incoming.setHostId(hostId);
                    eventDao.insert(incoming);
                } else {
                    eventDao.updateFtcConfig(incoming.getId(), incoming.getFtcYear(), incoming.getFtcEventCode());
                    handle.execute("UPDATE events SET invite_code = ?, name = ?, host_id = ? WHERE id = ?",
                            normalizedCode, incoming.getName(), hostId, incoming.getId());
                }

                // Migrate any records and cleanup stub if existingByCode was a different event/stub
                if (existingByCode != null && !existingByCode.getId().equals(incoming.getId())) {
                    handle.execute("UPDATE scouting_records SET event_id = ? WHERE event_id = ?", incoming.getId(), existingByCode.getId());
                    eventDao.delete(existingByCode.getId());
                }

                // Also check if there was a stub by deterministic ID "ext_" + normalizedCode
                String stubId = "ext_" + normalizedCode;
                if (!stubId.equals(incoming.getId())) {
                    ScoutingEvent stub = eventDao.findById(stubId);
                    if (stub != null) {
                        handle.execute("UPDATE scouting_records SET event_id = ? WHERE event_id = ?", incoming.getId(), stubId);
                        eventDao.delete(stubId);
                    }
                }

                eventDao.joinEvent(incoming.getId(), userId);
                return eventDao.findById(incoming.getId());
            });

            ctx.status(200).result(gson.toJson(synced)).contentType("application/json");
        });

        routes.put("/api/events/{id}/ftc-config", ctx -> {
            String eventId = ctx.pathParam("id");
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            Integer year = body.get("ftcYear") != null ? Double.valueOf(String.valueOf(body.get("ftcYear"))).intValue() : null;
            String code = asString(body.get("ftcEventCode"));
            
            String userId = ctx.attribute("userId");
            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent e = dao.findById(eventId);
                if (e == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }
                if (!userId.equals(e.getHostId())) {
                    throw new io.javalin.http.ForbiddenResponse("Only the host can configure the event");
                }
                dao.updateFtcConfig(eventId, year, code);
            });
            ctx.status(200).result("OK");
        });

        routes.get("/api/events/{id}/banned-teams", ctx -> {
            String eventId = ctx.pathParam("id");
            List<Integer> bannedTeams = jdbi.withExtension(BannedTeamDao.class, dao -> dao.getBannedTeams(eventId));
            ctx.result(gson.toJson(bannedTeams)).contentType("application/json");
        });

        routes.post("/api/events/{id}/banned-teams", ctx -> {
            String eventId = ctx.pathParam("id");
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null || body.get("teamNumber") == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            int teamNumber;
            try {
                teamNumber = Double.valueOf(String.valueOf(body.get("teamNumber"))).intValue();
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid teamNumber format");
                return;
            }
            String userId = ctx.attribute("userId");
            jdbi.useTransaction(handle -> {
                EventDao eventDao = handle.attach(EventDao.class);
                ScoutingEvent e = eventDao.findById(eventId);
                if (e == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }
                if (!userId.equals(e.getHostId())) {
                    throw new io.javalin.http.ForbiddenResponse("Only the host can ban teams");
                }
                BannedTeamDao bannedDao = handle.attach(BannedTeamDao.class);
                bannedDao.banTeam(eventId, teamNumber);
            });
            ctx.status(200).result("OK");
        });

        routes.get("/api/events/{id}/members", ctx -> {
            String eventId = ctx.pathParam("id");
            List<EventMember> members = jdbi.withExtension(EventDao.class, dao -> dao.findMembersByEvent(eventId));
            ctx.result(gson.toJson(members)).contentType("application/json");
        });
    }

    private String generateInviteCode(EventDao dao) {
        String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        while (true) {
            StringBuilder sb = new StringBuilder(6);
            for (int i = 0; i < 6; i++) {
                sb.append(chars.charAt(ThreadLocalRandom.current().nextInt(chars.length())));
            }
            String code = sb.toString();
            if (dao.findByInviteCode(code) == null) {
                return code;
            }
        }
    }
}
