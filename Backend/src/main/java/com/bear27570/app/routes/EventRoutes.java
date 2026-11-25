package com.bear27570.app.routes;

import com.bear27570.app.dao.BannedTeamDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.EventMember;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.TurnServerConfig;
import com.bear27570.app.model.User;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.KeyDecryptionException;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import com.bear27570.app.db.AppConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.bear27570.app.util.FtcApiClient;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class EventRoutes {

    private static final Logger logger = LoggerFactory.getLogger(EventRoutes.class);
    private final Jdbi jdbi;
    private final Gson gson;
    private final FtcApiClient ftcApiClient;

    public EventRoutes(Jdbi jdbi, Gson gson) {
        this(jdbi, gson, new FtcApiClient());
    }

    public EventRoutes(Jdbi jdbi, Gson gson, FtcApiClient ftcApiClient) {
        this.jdbi = jdbi;
        this.gson = gson;
        this.ftcApiClient = ftcApiClient != null ? ftcApiClient : new FtcApiClient();
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/events", ctx -> {
            String userId = ctx.attribute("userId");
            List<ScoutingEvent> events = jdbi.withExtension(EventDao.class, dao -> dao.findForUser(userId));
            events.forEach(this::hydrateTurnConfig);
            ctx.result(gson.toJson(events)).contentType("application/json");
        });

        routes.post("/api/events", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String rawName = asString(body.get("name"));
            if (rawName == null || rawName.isBlank()) {
                ctx.status(400).result("Event name is required");
                return;
            }
            String trimmedName = rawName.trim();
            if (trimmedName.length() > 100) {
                ctx.status(400).result("Event name cannot exceed 100 characters");
                return;
            }
            String userId = ctx.attribute("userId");
            ScoutingEvent event = new ScoutingEvent();
            event.setId(UUID.randomUUID().toString());
            event.setName(trimmedName);
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

            hydrateTurnConfig(evt);
            ctx.status(200).result(gson.toJson(evt)).contentType("application/json");
        });

        routes.delete("/api/events/{id}", ctx -> {
            String userId = ctx.attribute("userId");
            if (userId == null || userId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            String eventId = ctx.pathParam("id");
            if (eventId == null || eventId.isBlank()) {
                ctx.status(400).result("Event ID required");
                return;
            }

            jdbi.useTransaction(handle -> {
                EventDao dao = handle.attach(EventDao.class);
                ScoutingEvent event = dao.findById(eventId);
                if (event == null) {
                    return;
                }
                if (userId.equals(event.getHostId())) {
                    dao.delete(eventId);
                } else {
                    handle.createUpdate("DELETE FROM event_users WHERE event_id = :eventId AND user_id = :userId")
                          .bind("eventId", eventId)
                          .bind("userId", userId)
                          .execute();
                }
            });

            ctx.status(204);
        });

        routes.post("/api/events/external-sync", ctx -> {
            String userId = ctx.attribute("userId");
            if (userId == null || userId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            ScoutingEvent incoming = gson.fromJson(ctx.body(), ScoutingEvent.class);
            if (incoming == null
                    || incoming.getId() == null || incoming.getId().isBlank()
                    || incoming.getInviteCode() == null || incoming.getInviteCode().isBlank()) {
                ctx.status(400).result("Invalid event payload");
                return;
            }

            ScoutingEvent synced = jdbi.inTransaction(handle -> {
                UserDao userDao = handle.attach(UserDao.class);
                EventDao eventDao = handle.attach(EventDao.class);

                String normalizedCode = incoming.getInviteCode().trim().toUpperCase(Locale.ROOT);
                String rawIncomingName = incoming.getName() != null ? incoming.getName().trim() : "";
                String safeName = rawIncomingName.isEmpty()
                        ? ("Event " + normalizedCode)
                        : (rawIncomingName.length() > 100 ? rawIncomingName.substring(0, 100) : rawIncomingName);
                incoming.setName(safeName);

                String hostId = incoming.getHostId() != null && !incoming.getHostId().isBlank()
                        ? incoming.getHostId().trim()
                        : userId;

                ScoutingEvent existing = eventDao.findById(incoming.getId());
                String existingCode = "";
                if (existing != null) {
                    existingCode = existing.getInviteCode() != null
                            ? existing.getInviteCode().trim().toUpperCase(Locale.ROOT)
                            : "";
                    if (!existingCode.isEmpty() && !existingCode.equals(normalizedCode)) {
                        throw new io.javalin.http.BadRequestResponse("Event inviteCode is immutable and cannot be changed");
                    }
                    String existingHostId = existing.getHostId();
                    boolean isPlaceholderHost = existingHostId == null
                            || existingHostId.isBlank()
                            || "external_host".equals(existingHostId);
                    if (!isPlaceholderHost && !userId.equals(existingHostId)) {
                        if (!hostId.equals(existingHostId)) {
                            throw new io.javalin.http.ForbiddenResponse("Cannot hijack host ownership of an existing event");
                        }
                        User localHostUser = userDao.findById(existingHostId);
                        if (localHostUser != null
                                && localHostUser.getPassword() != null
                                && !localHostUser.getPassword().isBlank()) {
                            throw new io.javalin.http.ForbiddenResponse("Only the event host can modify an authoritative local event");
                        }
                    }
                }

                // Only temporary distributed stubs ('ext_...', 'evt-...', or 'external_host') may unbind & reparent
                // their inviteCode into the authoritative event UUID; an authoritative event's inviteCode is immutable for everyone.
                ScoutingEvent existingByCode = eventDao.findByInviteCode(normalizedCode);
                if (existingByCode != null && !existingByCode.getId().equals(incoming.getId())) {
                    String codeId = existingByCode.getId();
                    boolean isDistributedStub = codeId.startsWith("ext_")
                            || codeId.toLowerCase(Locale.ROOT).startsWith("evt-")
                            || "external_host".equals(existingByCode.getHostId());
                    if (!isDistributedStub) {
                        throw new io.javalin.http.ForbiddenResponse("Event inviteCode is immutable; cannot overwrite invite code of an existing event");
                    }
                    handle.execute("UPDATE events SET invite_code = NULL WHERE id = ?", existingByCode.getId());
                }

                userDao.ensureScoutUserPlaceholder(hostId, "Host " + hostId.substring(0, Math.min(6, hostId.length())));

                String encryptedTurnConfig = null;
                boolean shouldClearTurnConfig = false;
                if (incoming.getCustomTurnConfig() != null
                        && incoming.getCustomTurnConfig().getUrls() != null
                        && !incoming.getCustomTurnConfig().getUrls().isEmpty()) {
                    encryptedTurnConfig = AESUtil.encrypt(gson.toJson(incoming.getCustomTurnConfig()));
                } else if (incoming.getCustomTurnConfig() == null && Boolean.FALSE.equals(incoming.getHasCustomTurn())) {
                    shouldClearTurnConfig = true;
                }

                if (existing == null) {
                    incoming.setInviteCode(normalizedCode);
                    incoming.setHostId(hostId);
                    if (encryptedTurnConfig != null) {
                        incoming.setTurnConfigEncrypted(encryptedTurnConfig);
                    } else if (shouldClearTurnConfig) {
                        incoming.setTurnConfigEncrypted(null);
                    }
                    eventDao.insert(incoming);
                } else {
                    eventDao.updateFtcConfig(incoming.getId(), incoming.getFtcYear(), incoming.getFtcEventCode());
                    if (existingCode.isEmpty()) {
                        handle.execute("UPDATE events SET invite_code = ?, name = ?, host_id = ? WHERE id = ?",
                                normalizedCode, safeName, hostId, incoming.getId());
                    } else {
                        handle.execute("UPDATE events SET name = ?, host_id = ? WHERE id = ?",
                                safeName, hostId, incoming.getId());
                    }
                    if (encryptedTurnConfig != null) {
                        eventDao.updateTurnConfig(incoming.getId(), encryptedTurnConfig);
                    } else if (shouldClearTurnConfig) {
                        eventDao.updateTurnConfig(incoming.getId(), null);
                    }
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
                    if (stub != null && ("external_host".equals(stub.getHostId()) || userId.equals(stub.getHostId()))) {
                        reparentEventData(handle, stubId, incoming.getId());
                        eventDao.delete(stubId);
                    }
                }

                eventDao.joinEvent(incoming.getId(), userId);
                return eventDao.findById(incoming.getId());
            });

            hydrateTurnConfig(synced);
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
            if (body.get("ftcYear") != null && !String.valueOf(body.get("ftcYear")).isBlank()) {
                try {
                    parsedYear = Double.valueOf(String.valueOf(body.get("ftcYear"))).intValue();
                } catch (NumberFormatException e) {
                    ctx.status(400).result("Invalid ftcYear format");
                    return;
                }
            }
            final Integer year = parsedYear;
            String rawCode = asString(body.get("ftcEventCode"));
            final String code = (rawCode != null && !rawCode.isBlank()) ? rawCode.trim().toUpperCase() : null;

            String userId = ctx.attribute("userId");
            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent e = dao.findById(eventId);
                if (e == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }
                if (!userId.equals(e.getHostId())) {
                    throw new io.javalin.http.ForbiddenResponse("Only the host can configure the event");
                }
            });

            if (code != null) {
                if (year == null || year < 2000 || year > 2100) {
                    ctx.status(400).result("Invalid ftcYear");
                    return;
                }
                if (!code.matches("^[A-Za-z0-9_-]{1,32}$")) {
                    ctx.status(400).result("Invalid ftcEventCode format");
                    return;
                }
                try {
                    boolean exists = ftcApiClient.eventExists(year, code);
                    if (!exists) {
                        ctx.status(400).result("FTC 官方赛事代码不存在: " + code + " (赛季 " + year + ")");
                        return;
                    }
                } catch (Exception e) {
                    logger.error("Failed to verify FTC event code '{}' for season {}: {}", code, year, e.getMessage(), e);
                    ctx.status(502).result("FTC 官方 API 校验失败: " + e.getMessage());
                    return;
                }
            }

            jdbi.useExtension(EventDao.class, dao -> {
                dao.updateFtcConfig(eventId, code != null ? year : null, code);
            });
            ctx.status(200).result("OK");
        });

        routes.put("/api/events/{id}/turn-config", ctx -> {
            String userId = ctx.attribute("userId");
            if (userId == null || userId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            String eventId = ctx.pathParam("id");
            ScoutingEvent e = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (e == null) {
                throw new io.javalin.http.NotFoundResponse("Event not found");
            }
            if (!userId.equals(e.getHostId())) {
                throw new io.javalin.http.ForbiddenResponse("Only the host can configure the event");
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }

            boolean clear = Boolean.TRUE.equals(body.get("clear"));
            Object rawUrls = body.get("urls");
            if (clear || rawUrls == null || (rawUrls instanceof List<?> rawList && rawList.isEmpty())) {
                jdbi.useExtension(EventDao.class, dao -> dao.updateTurnConfig(eventId, null));
                ctx.status(200)
                        .result("{\"hasCustomTurn\":false,\"customTurnConfig\":null}")
                        .contentType("application/json");
                return;
            }

            if (!(rawUrls instanceof List<?> rawUrlsList)) {
                ctx.status(400).result("urls must be a list of strings");
                return;
            }
            if (rawUrlsList.size() > 10) {
                ctx.status(400).result("Too many TURN URLs (max 10)");
                return;
            }

            List<String> cleanUrls = new ArrayList<>();
            for (Object item : rawUrlsList) {
                String trimmed = item == null ? "" : String.valueOf(item).trim();
                String lower = trimmed.toLowerCase(Locale.ROOT);
                if (trimmed.isEmpty() || (!lower.startsWith("turn:") && !lower.startsWith("turns:"))) {
                    ctx.status(400).result("Invalid TURN URL: must start with turn: or turns:");
                    return;
                }
                cleanUrls.add(trimmed);
            }

            String rawUsername = asString(body.get("username"));
            if (rawUsername == null || rawUsername.isBlank()) {
                ctx.status(400).result("TURN username is required");
                return;
            }

            String rawCredential = asString(body.get("credential"));
            String resolvedCredential = null;
            boolean isMaskedOrBlank = rawCredential == null
                    || rawCredential.isBlank()
                    || "****".equals(rawCredential.trim())
                    || rawCredential.contains("***");
            if (isMaskedOrBlank) {
                String existingEncrypted = e.getTurnConfigEncrypted();
                if (existingEncrypted != null && !existingEncrypted.isBlank()) {
                    try {
                        TurnServerConfig existingCfg = gson.fromJson(AESUtil.decrypt(existingEncrypted), TurnServerConfig.class);
                        if (existingCfg != null && existingCfg.getCredential() != null && !existingCfg.getCredential().isBlank()) {
                            resolvedCredential = existingCfg.getCredential();
                        }
                    } catch (Exception ex) {
                        logger.warn("Failed to decrypt existing TURN config while resolving masked credential for event {}: {}", eventId, ex.getMessage());
                    }
                }
                if (resolvedCredential == null) {
                    ctx.status(400).result("TURN credential is required");
                    return;
                }
            } else {
                resolvedCredential = rawCredential;
            }

            TurnServerConfig config = new TurnServerConfig(cleanUrls, rawUsername.trim(), resolvedCredential);
            String encrypted = AESUtil.encrypt(gson.toJson(config));
            jdbi.useExtension(EventDao.class, dao -> dao.updateTurnConfig(eventId, encrypted));

            ctx.status(200)
                    .result(gson.toJson(Map.of("hasCustomTurn", true, "customTurnConfig", config)))
                    .contentType("application/json");
        });

        routes.get("/api/events/{id}/banned-teams", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
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

        routes.delete("/api/events/{id}/banned-teams/{teamNumber}", ctx -> {
            String eventId = ctx.pathParam("id");
            int teamNumber;
            try {
                teamNumber = Integer.parseInt(ctx.pathParam("teamNumber"));
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
                    throw new io.javalin.http.ForbiddenResponse("Only the host can unban teams");
                }
                BannedTeamDao bannedDao = handle.attach(BannedTeamDao.class);
                bannedDao.unbanTeam(eventId, teamNumber);
            });
            ctx.status(200).result("OK");
        });

        routes.get("/api/events/{id}/members", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
            List<EventMember> members = jdbi.withExtension(EventDao.class, dao -> dao.findMembersByEvent(eventId));
            ctx.result(gson.toJson(members)).contentType("application/json");
        });

        routes.post("/api/events/{id}/members", ctx -> {
            String eventId = ctx.pathParam("id");
            String callerUserId = ctx.attribute("userId");
            if (callerUserId == null || callerUserId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String memberUserId = asString(body.get("userId"));
            String memberUsername = asString(body.get("username"));
            if (memberUserId == null || memberUserId.isBlank()) {
                ctx.status(400).result("Missing userId");
                return;
            }
            if (memberUsername == null || memberUsername.isBlank()) {
                memberUsername = memberUserId;
            }
            final String finalMemberUsername = memberUsername;

            jdbi.useTransaction(handle -> {
                EventDao eventDao = handle.attach(EventDao.class);
                UserDao userDao = handle.attach(UserDao.class);

                ScoutingEvent e = eventDao.findById(eventId);
                if (e == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }
                // Host-Only Authorization: Only event host can proxy-register members
                if (!callerUserId.equals(e.getHostId())) {
                    throw new io.javalin.http.ForbiddenResponse("Only the event host can register members");
                }

                User existingUser = userDao.findById(memberUserId);
                if (existingUser == null) {
                    // Safe creation of placeholder scout user
                    userDao.ensureScoutUserPlaceholder(memberUserId, finalMemberUsername);
                } else {
                    // Anti-hijacking: If user already has a password, never overwrite their username
                    if (existingUser.getPassword() == null || existingUser.getPassword().isBlank()) {
                        handle.execute("UPDATE users SET username = ? WHERE id = ? AND (password = '' OR password IS NULL)", finalMemberUsername, memberUserId);
                    }
                }
                eventDao.joinEvent(eventId, memberUserId);
            });
            ctx.status(200).result("OK");
        });

        routes.delete("/api/events/{id}/members/{userId}", ctx -> {
            String eventId = ctx.pathParam("id");
            String targetUserId = ctx.pathParam("userId");
            String callerUserId = ctx.attribute("userId");
            if (callerUserId == null || callerUserId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            jdbi.useTransaction(handle -> {
                EventDao eventDao = handle.attach(EventDao.class);
                ScoutingEvent e = eventDao.findById(eventId);
                if (e == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }
                // Host-Only Authorization: Only event host can remove members
                if (!callerUserId.equals(e.getHostId())) {
                    throw new io.javalin.http.ForbiddenResponse("Only the event host can remove members");
                }
                // Host cannot remove themselves from their own event
                if (callerUserId.equals(targetUserId)) {
                    throw new io.javalin.http.BadRequestResponse("Host cannot be removed from event");
                }
                handle.execute("DELETE FROM event_users WHERE event_id = ? AND user_id = ?", eventId, targetUserId);
            });
            ctx.status(200).result("OK");
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

        // 9.1 ai_chat_threads
        handle.execute("UPDATE ai_chat_threads SET event_id = ? WHERE event_id = ?", newEventId, oldEventId);

        // 9.5 event_custom_fields
        handle.execute("""
            UPDATE event_custom_fields
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM event_custom_fields target
                  WHERE target.event_id = ?
                    AND target.target = event_custom_fields.target
                    AND target.field_key = event_custom_fields.field_key
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM event_custom_fields WHERE event_id = ?", oldEventId);

        // 9.6 event_crdt_state
        handle.execute("""
            UPDATE event_crdt_state
            SET event_id = ?
            WHERE event_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM event_crdt_state target
                  WHERE target.event_id = ?
              )
        """, newEventId, oldEventId, newEventId);
        handle.execute("DELETE FROM event_crdt_state WHERE event_id = ?", oldEventId);

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

    private void hydrateTurnConfig(ScoutingEvent event) {
        if (event == null) {
            return;
        }
        String encrypted = event.getTurnConfigEncrypted();
        // Always clear encrypted ciphertext before serializing response
        event.setTurnConfigEncrypted(null);
        if (encrypted == null || encrypted.isBlank()) {
            event.setCustomTurnConfig(null);
            event.setHasCustomTurn(false);
            return;
        }
        try {
            String decrypted = AESUtil.decrypt(encrypted);
            TurnServerConfig cfg = gson.fromJson(decrypted, TurnServerConfig.class);
            if (cfg != null && cfg.getUrls() != null && !cfg.getUrls().isEmpty()) {
                event.setCustomTurnConfig(cfg);
                event.setHasCustomTurn(true);
            } else {
                event.setCustomTurnConfig(null);
                event.setHasCustomTurn(false);
            }
        } catch (KeyDecryptionException e) {
            logger.warn("Failed to decrypt custom TURN config for event {}: {}", event.getId(), e.getMessage());
            event.setCustomTurnConfig(null);
            event.setHasCustomTurn(false);
        } catch (Exception e) {
            logger.warn("Failed to parse custom TURN config for event {}: {}", event.getId(), e.getMessage());
            event.setCustomTurnConfig(null);
            event.setHasCustomTurn(false);
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
