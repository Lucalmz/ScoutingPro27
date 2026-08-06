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

        routes.post("/api/user/login", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
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
                        String storedPassword = existing.getPassword();
                        if (storedPassword == null || storedPassword.isBlank()) {
                            // Silent upgrade for legacy users with no password
                            existing.setPassword(org.mindrot.jbcrypt.BCrypt.hashpw(password, org.mindrot.jbcrypt.BCrypt.gensalt()));
                            dao.upsert(existing);
                        } else if (!storedPassword.startsWith("$2a$") && !storedPassword.startsWith("$2b$") && !storedPassword.startsWith("$2y$")) {
                            // Legacy plaintext password
                            if (!password.equals(storedPassword)) {
                                throw new RuntimeException("Invalid password");
                            }
                            // Silent upgrade
                            existing.setPassword(org.mindrot.jbcrypt.BCrypt.hashpw(password, org.mindrot.jbcrypt.BCrypt.gensalt()));
                            dao.upsert(existing);
                        } else if (!org.mindrot.jbcrypt.BCrypt.checkpw(password, storedPassword)) {
                            throw new RuntimeException("Invalid password");
                        }
                        return existing;
                    }
                    User u = new User(UUID.randomUUID().toString(), username);
                    u.setPassword(org.mindrot.jbcrypt.BCrypt.hashpw(password, org.mindrot.jbcrypt.BCrypt.gensalt()));
                    dao.upsert(u);
                    return u;
                });
                ctx.result(gson.toJson(Map.of(
                        "id", user.getId(),
                        "username", user.getUsername()
                ))).contentType("application/json");
            } catch (RuntimeException e) {
                if ("Invalid password".equals(e.getMessage())) {
                    ctx.status(401).result("Invalid password");
                } else {
                    System.err.println("Login error: " + e.getMessage());
                    ctx.status(500).result("Internal Server Error");
                }
            }
        });

        // ==================== Events ====================

        routes.get("/api/events", ctx -> {
            List<ScoutingEvent> events = jdbi.withExtension(EventDao.class, EventDao::findAll);
            ctx.result(gson.toJson(events)).contentType("application/json");
        });

        routes.post("/api/events", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            ScoutingEvent event = new ScoutingEvent();
            event.setId(UUID.randomUUID().toString());
            event.setName(body.get("name"));
            event.setInviteCode(generateInviteCode());
            event.setIsHost(true);
            jdbi.useExtension(EventDao.class, dao -> dao.insert(event));
            ctx.result(gson.toJson(Map.of("id", event.getId(), "inviteCode", event.getInviteCode())))
               .contentType("application/json");
        });

        routes.post("/api/events/join", ctx -> {
            ScoutingEvent incoming = gson.fromJson(ctx.body(), ScoutingEvent.class);
            incoming.setIsHost(false);
            jdbi.useExtension(EventDao.class, dao -> dao.insert(incoming));
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
            ScoutingRecord record = gson.fromJson(ctx.body(), ScoutingRecord.class);
            jdbi.useExtension(RecordDao.class, dao -> dao.upsert(record));
            ctx.status(200).result("OK");
        });

        routes.post("/api/records/sync", ctx -> {
            Type t = new TypeToken<List<ScoutingRecord>>() {}.getType();
            List<ScoutingRecord> records = gson.fromJson(ctx.body(), t);
            jdbi.useExtension(RecordDao.class, dao -> {
                for (ScoutingRecord r : records) {
                    r.setSyncStatus("SYNCED");
                    dao.upsert(r);
                }
            });
            ctx.status(200).result("OK");
        });

        routes.get("/api/records/pending", ctx -> {
            String eventId = ctx.queryParam("eventId");
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findPendingByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        routes.post("/api/records/mark-synced", ctx -> {
            Type t = new TypeToken<List<String>>() {}.getType();
            List<String> ids = gson.fromJson(ctx.body(), t);
            jdbi.useExtension(RecordDao.class, dao -> {
                for (String id : ids) {
                    dao.markSynced(id);
                }
            });
            ctx.status(200).result("OK");
        });
    }

    private String generateInviteCode() {
        String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder sb = new StringBuilder(6);
        for (int i = 0; i < 6; i++) {
            sb.append(chars.charAt(ThreadLocalRandom.current().nextInt(chars.length())));
        }
        return sb.toString();
    }
}
