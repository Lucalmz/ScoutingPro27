package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.model.User;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.lang.reflect.Type;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * REST API 路由注册。
 * Javalin 7：通过 config.routes 注册，在 start() 之前完成。
 */
public class ApiRoutes {

    private final Jdbi jdbi;
    private final Gson gson = new Gson();

    public ApiRoutes(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    public void register(RoutesConfig routes) {

        // ==================== User ====================

        routes.get("/api/user/check", ctx -> {
            String username = ctx.queryParam("username");
            if (username == null || username.isBlank()) {
                ctx.status(400).result("username required");
                return;
            }
            boolean exists = jdbi.withExtension(UserDao.class, dao -> {
                return dao.findByUsername(username) != null;
            });
            ctx.result(gson.toJson(Map.of("exists", exists))).contentType("application/json");
        });

        // Global Authentication Interceptor
        routes.before("/api/*", ctx -> {
            String path = ctx.path();
            if (path.equals("/api/user/login") || path.equals("/api/user/register") || path.equals("/api/user/check") || path.equals("/api/test/cleanup")) return; // skip user routes
            if (ctx.method().name().equals("OPTIONS")) return; // skip CORS preflight
            
            String authHeader = ctx.header("Authorization");
            if (authHeader == null || !authHeader.startsWith("Bearer ")) {
                throw new io.javalin.http.UnauthorizedResponse("Missing or invalid token");
            }
            String token = authHeader.substring(7);
            String userId = com.bear27570.app.util.JwtUtil.verifyToken(token);
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Invalid or expired token");
            }
            ctx.attribute("userId", userId);
        });

        routes.post("/api/user/register", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String username = body.get("username");
            String password = body.get("password");
            
            if (username == null || username.isBlank() || password == null || password.isBlank()) {
                ctx.status(400).result("username and password required");
                return;
            }
            if (username.length() > 50 || password.length() > 72) {
                ctx.status(400).result("username or password too long");
                return;
            }
            try {
                User user = jdbi.withExtension(UserDao.class, dao -> {
                    User existing = dao.findByUsername(username);
                    if (existing != null) {
                        throw new RuntimeException("User already exists");
                    }
                    User u = new User(UUID.randomUUID().toString(), username);
                    u.setPassword(org.mindrot.jbcrypt.BCrypt.hashpw(password, org.mindrot.jbcrypt.BCrypt.gensalt()));
                    dao.upsert(u);
                    return u;
                });
                
                String token = com.bear27570.app.util.JwtUtil.generateToken(user.getId(), user.getUsername());
                ctx.result(gson.toJson(Map.of(
                        "id", user.getId(),
                        "username", user.getUsername(),
                        "token", token
                ))).contentType("application/json");
            } catch (RuntimeException e) {
                if ("User already exists".equals(e.getMessage())) {
                    ctx.status(409).result("User already exists");
                } else {
                    System.err.println("Register error: " + e.getMessage());
                    ctx.status(500).result("Internal Server Error");
                }
            }
        });

        routes.post("/api/user/login", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String username = body.get("username");
            String password = body.get("password");
            
            if (username == null || username.isBlank() || password == null || password.isBlank()) {
                ctx.status(400).result("username and password required");
                return;
            }
            try {
                User user = jdbi.withExtension(UserDao.class, dao -> {
                    User existing = dao.findByUsername(username);
                    if (existing == null) {
                        throw new RuntimeException("Invalid credentials");
                    }
                    String storedPassword = existing.getPassword();
                    if (storedPassword == null || storedPassword.isBlank() || 
                        !org.mindrot.jbcrypt.BCrypt.checkpw(password, storedPassword)) {
                        throw new RuntimeException("Invalid credentials");
                    }
                    return existing;
                });
                
                String token = com.bear27570.app.util.JwtUtil.generateToken(user.getId(), user.getUsername());
                ctx.result(gson.toJson(Map.of(
                        "id", user.getId(),
                        "username", user.getUsername(),
                        "token", token
                ))).contentType("application/json");
            } catch (RuntimeException e) {
                if ("Invalid credentials".equals(e.getMessage())) {
                    ctx.status(401).result("Invalid credentials");
                } else {
                    System.err.println("Login error: " + e.getMessage());
                    ctx.status(500).result("Internal Server Error");
                }
            }
        });

        // ==================== Events ====================

        routes.get("/api/events", ctx -> {
            String userId = ctx.attribute("userId");
            List<ScoutingEvent> events = jdbi.withExtension(EventDao.class, dao -> dao.findForUser(userId));
            ctx.result(gson.toJson(events)).contentType("application/json");
        });

        routes.post("/api/events", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String userId = ctx.attribute("userId");
            ScoutingEvent event = new ScoutingEvent();
            event.setId(UUID.randomUUID().toString());
            event.setName(body.get("name"));
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
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String inviteCode = body.get("inviteCode");
            
            if (inviteCode == null || inviteCode.isBlank()) {
                ctx.status(400).result("Missing inviteCode");
                return;
            }

            ScoutingEvent evt = jdbi.withExtension(EventDao.class, dao -> {
                ScoutingEvent e = dao.findByInviteCode(inviteCode);
                if (e != null) {
                    dao.joinEvent(e.getId(), ctx.attribute("userId"));
                }
                return e;
            });
            if (evt == null) {
                ctx.status(404).result("Event not found");
                return;
            }
            
            ctx.status(200).result(gson.toJson(evt)).contentType("application/json");
        });

        routes.put("/api/events/{id}/ftc-config", ctx -> {
            String eventId = ctx.pathParam("id");
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            Integer year = body.get("ftcYear") != null ? ((Number) body.get("ftcYear")).intValue() : null;
            String code = (String) body.get("ftcEventCode");
            
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
            List<Integer> bannedTeams = jdbi.withExtension(com.bear27570.app.dao.BannedTeamDao.class, dao -> dao.getBannedTeams(eventId));
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
            int teamNumber = ((Number) body.get("teamNumber")).intValue();
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
                com.bear27570.app.dao.BannedTeamDao bannedDao = handle.attach(com.bear27570.app.dao.BannedTeamDao.class);
                bannedDao.banTeam(eventId, teamNumber);
            });
            ctx.status(200).result("OK");
        });

        // ==================== Records ====================

        routes.get("/api/records", ctx -> {
            String eventId = ctx.queryParam("eventId");
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        routes.post("/api/records", ctx -> {
            try {
                ScoutingRecord record = gson.fromJson(ctx.body(), ScoutingRecord.class);
                if (record == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                if (record.getMatchNumber() <= 0 || record.getTeamNumber() <= 0) {
                    ctx.status(400).result("Invalid matchNumber or teamNumber");
                    return;
                }
                if (record.getEventId() == null || record.getEventId().isBlank()) {
                    ctx.status(400).result("Event ID cannot be blank");
                    return;
                }
                record.setScoutId(ctx.attribute("userId"));
                jdbi.useExtension(RecordDao.class, dao -> dao.upsert(record));
                ctx.status(200).result("OK");
            } catch (Exception e) {
                ctx.status(400).result("Invalid data: " + e.getMessage());
            }
        });

        routes.post("/api/records/sync", ctx -> {
            try {
                Type t = new TypeToken<List<ScoutingRecord>>() {}.getType();
                List<ScoutingRecord> records = gson.fromJson(ctx.body(), t);
                if (records == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                String userId = ctx.attribute("userId");
                
                // Wrap in a transaction to prevent partial failure corruption
                jdbi.useTransaction(handle -> {
                    RecordDao dao = handle.attach(RecordDao.class);
                    for (ScoutingRecord r : records) {
                        if (r.getMatchNumber() <= 0 || r.getTeamNumber() <= 0 || r.getEventId() == null) {
                            throw new IllegalArgumentException("Invalid record detected in batch sync");
                        }
                        if (r.getScoutId() == null || r.getScoutId().isBlank()) {
                            r.setScoutId(userId); // only fallback to host ID if missing
                        }
                        r.setSyncStatus("SYNCED");
                        dao.upsert(r);
                    }
                });
                ctx.status(200).result("OK");
            } catch (Exception e) {
                ctx.status(400).result("Sync failed: " + e.getMessage());
            }
        });

        routes.get("/api/records/pending", ctx -> {
            String eventId = ctx.queryParam("eventId");
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findPendingByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        routes.post("/api/records/mark-synced", ctx -> {
            try {
                Type t = new TypeToken<List<String>>() {}.getType();
                List<String> ids = gson.fromJson(ctx.body(), t);
                if (ids == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                String userId = ctx.attribute("userId");
                jdbi.useExtension(RecordDao.class, dao -> {
                    for (String id : ids) {
                        dao.markSynced(id, userId);
                    }
                });
                ctx.status(200).result("OK");
            } catch (Exception e) {
                ctx.status(400).result("Invalid data");
            }
        });
        if ("true".equals(System.getenv("ENABLE_TEST_CLEANUP")) || "true".equals(System.getProperty("ENABLE_TEST_CLEANUP"))) {
            routes.post("/api/test/cleanup", ctx -> {
                try {
                    Type t = new TypeToken<List<String>>() {}.getType();
                    List<String> usernames = gson.fromJson(ctx.body(), t);
                    if (usernames != null && !usernames.isEmpty()) {
                        jdbi.useTransaction(handle -> {
                            for (String username : usernames) {
                                handle.execute("DELETE FROM events WHERE host_id IN (SELECT id FROM users WHERE username = ?)", username);
                                handle.execute("DELETE FROM users WHERE username = ?", username);
                            }
                        });
                    }
                    ctx.status(200).result("Cleanup OK");
                } catch (Exception e) {
                    ctx.status(500).result("Cleanup Failed: " + e.getMessage());
                }
            });
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
