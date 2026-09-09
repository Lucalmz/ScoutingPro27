package com.bear27570.app.routes;

import com.bear27570.app.dao.BannedTeamDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.EventMember;
import com.bear27570.app.model.ScoutingEvent;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import com.bear27570.app.db.AppConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class EventRoutes {

    private static final Logger logger = LoggerFactory.getLogger(EventRoutes.class);
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
                    reparentEventData(handle, existingByCode.getId(), incoming.getId());
                    eventDao.delete(existingByCode.getId());
                }

                // Also check if there was a stub by deterministic ID "ext_" + normalizedCode
                String stubId = "ext_" + normalizedCode;
                if (!stubId.equals(incoming.getId())) {
                    ScoutingEvent stub = eventDao.findById(stubId);
                    if (stub != null) {
                        reparentEventData(handle, stubId, incoming.getId());
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
            Integer parsedYear = null;
            if (body.get("ftcYear") != null) {
                try {
                    parsedYear = Double.valueOf(String.valueOf(body.get("ftcYear"))).intValue();
                } catch (NumberFormatException e) {
                    ctx.status(400).result("Invalid ftcYear format");
                    return;
                }
            }
            final Integer year = parsedYear;
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

    private void reparentEventData(org.jdbi.v3.core.Handle handle, String oldEventId, String newEventId) {
        if (oldEventId == null || newEventId == null || oldEventId.equals(newEventId)) {
            return;
        }
        // 1. scouting_records
        handle.execute("UPDATE scouting_records SET event_id = ? WHERE event_id = ?", newEventId, oldEventId);

        // 2. pit_scouting_records: reparent non-conflicting teams, delete duplicates
        handle.execute("""
            UPDATE pit_scouting_records
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM pit_scouting_records target
                  WHERE target.event_id = ?
                    AND target.team_number = pit_scouting_records.team_number
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM pit_scouting_records WHERE event_id = ?", oldEventId);

        // 3. event_official_teams: reparent non-conflicting teams, delete duplicates
        handle.execute("""
            UPDATE event_official_teams
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM event_official_teams target
                  WHERE target.event_id = ?
                    AND target.team_number = event_official_teams.team_number
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM event_official_teams WHERE event_id = ?", oldEventId);

        // 4. match_schedules
        handle.execute("""
            UPDATE match_schedules
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM match_schedules target
                  WHERE target.event_id = ?
                    AND target.match_number = match_schedules.match_number
                    AND target.tournament_level = match_schedules.tournament_level
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM match_schedules WHERE event_id = ?", oldEventId);

        // 5. scout_assignments
        handle.execute("""
            UPDATE scout_assignments
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM scout_assignments target
                  WHERE target.event_id = ?
                    AND target.match_number = scout_assignments.match_number
                    AND target.tournament_level = scout_assignments.tournament_level
                    AND target.station = scout_assignments.station
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM scout_assignments WHERE event_id = ?", oldEventId);

        // 6. team_tags
        handle.execute("""
            UPDATE team_tags
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM team_tags target
                  WHERE target.event_id = ?
                    AND target.team_number = team_tags.team_number
                    AND target.tag = team_tags.tag
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM team_tags WHERE event_id = ?", oldEventId);

        // 7. banned_teams
        handle.execute("""
            UPDATE banned_teams
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM banned_teams target
                  WHERE target.event_id = ?
                    AND target.team_number = banned_teams.team_number
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM banned_teams WHERE event_id = ?", oldEventId);

        // 8. event_users
        handle.execute("""
            UPDATE event_users
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM event_users target
                  WHERE target.event_id = ?
                    AND target.user_id = event_users.user_id
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM event_users WHERE event_id = ?", oldEventId);

        // 9. ai_chat_sessions
        handle.execute("""
            UPDATE ai_chat_sessions
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM ai_chat_sessions target
                  WHERE target.user_id = ai_chat_sessions.user_id
                    AND target.event_id = ?
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM ai_chat_sessions WHERE event_id = ?", oldEventId);

        // 10. Physically migrate pit photos directory
        try {
            File oldDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + oldEventId);
            File newDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + newEventId);
            if (oldDir.exists() && oldDir.isDirectory()) {
                if (!newDir.exists()) {
                    newDir.mkdirs();
                }
                File[] oldFiles = oldDir.listFiles();
                if (oldFiles != null) {
                    for (File f : oldFiles) {
                        File targetFile = new File(newDir, f.getName());
                        if (!targetFile.exists()) {
                            try {
                                Files.move(f.toPath(), targetFile.toPath(), StandardCopyOption.REPLACE_EXISTING);
                            } catch (IOException e) {
                                logger.error("Failed to move pit photo {} during reparent: {}", f.getName(), e.getMessage());
                            }
                        }
                    }
                }
                oldDir.delete();
            }
        } catch (Exception e) {
            logger.error("Error migrating pit photos from {} to {}: {}", oldEventId, newEventId, e.getMessage());
        }
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
