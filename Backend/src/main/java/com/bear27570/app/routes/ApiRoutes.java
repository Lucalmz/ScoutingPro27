package com.bear27570.app.routes;

import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.AiSettings;
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
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/**
 * REST API 路由注册。
 * Javalin 7：通过 config.routes 注册，在 start() 之前完成。
 */
public class ApiRoutes {

    private final Jdbi jdbi;
    private final Gson gson = new com.google.gson.GsonBuilder().setDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ").create();
    private final ScheduledExecutorService gcScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "tombstone-gc-thread");
        t.setDaemon(true);
        return t;
    });

    public ApiRoutes(Jdbi jdbi) {
        this.jdbi = jdbi;
        // 自动注册并启动 14 天过期墓碑后台周期性清理任务：服务启动后立即执行一次，随后每 24 小时自动巡检清理
        gcScheduler.scheduleAtFixedRate(() -> {
            try {
                jdbi.useExtension(RecordDao.class, dao -> {
                    int purged = dao.purgeExpiredTombstones();
                    if (purged > 0) {
                        System.out.println("[Tombstone GC] Cleaned up " + purged + " expired tombstones older than 14 days.");
                    }
                });
            } catch (Exception e) {
                System.err.println("[Tombstone GC] Periodic cleanup error: " + e.getMessage());
            }
        }, 0, 24, TimeUnit.HOURS);
    }

    public void shutdown() {
        gcScheduler.shutdownNow();
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
            if (path.equals("/api/user/login") || path.equals("/api/user/register") || path.equals("/api/user/check") || path.equals("/api/user/verify-token") || path.equals("/api/test/cleanup")) return; // skip user routes
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

        routes.post("/api/user/verify-token", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, String> body = gson.fromJson(ctx.body(), Map.class);
            String tokenToVerify = body != null ? body.get("token") : null;
            if (tokenToVerify == null || tokenToVerify.isBlank()) {
                ctx.status(400).result("token required");
                return;
            }
            String userId = com.bear27570.app.util.JwtUtil.verifyToken(tokenToVerify);
            if (userId == null) {
                ctx.status(401).result("Invalid token signature");
                return;
            }
            User user = jdbi.withExtension(UserDao.class, dao -> dao.findById(userId));
            if (user == null) {
                ctx.status(404).result("User not found");
                return;
            }
            ctx.result(gson.toJson(Map.of(
                    "valid", true,
                    "userId", user.getId(),
                    "username", user.getUsername()
            ))).contentType("application/json");
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
            if (eventId == null || eventId.isBlank()) {
                ctx.status(400).result("eventId required");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
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
                String userId = ctx.attribute("userId");
                
                jdbi.useTransaction(handle -> {
                    EventDao eventDao = handle.attach(EventDao.class);
                    RecordDao recordDao = handle.attach(RecordDao.class);
                    
                    if (!eventDao.isMember(record.getEventId(), userId)) {
                        throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
                    }
                    
                    ScoutingRecord existing = recordDao.findById(record.getId());
                    if (existing == null) {
                        // New record: forcefully bind scoutId to authenticated user
                        record.setScoutId(userId);
                        if (record.getScoutName() == null || record.getScoutName().isBlank()) {
                            record.setScoutName(userId);
                        }
                    } else {
                        // Existing record: only original author or event host can update
                        boolean isHost = eventDao.isHost(record.getEventId(), userId);
                        if (!existing.getScoutId().equals(userId) && !isHost) {
                            throw new io.javalin.http.ForbiddenResponse("Cannot modify another scout's record");
                        }
                        if (!isHost) {
                            // Non-host author cannot transfer record ownership to someone else
                            record.setScoutId(userId);
                        }
                        if (record.getScoutName() == null || record.getScoutName().isBlank()) {
                            record.setScoutName(existing.getScoutName() != null ? existing.getScoutName() : userId);
                        }
                    }
                    
                    recordDao.upsert(record);
                });
                ctx.status(200).result("OK");
            } catch (io.javalin.http.HttpResponseException e) {
                throw e;
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
                    EventDao eventDao = handle.attach(EventDao.class);
                    RecordDao recordDao = handle.attach(RecordDao.class);
                    
                    for (ScoutingRecord r : records) {
                        if (r.getMatchNumber() <= 0 || r.getTeamNumber() <= 0 || r.getEventId() == null || r.getEventId().isBlank()) {
                            throw new IllegalArgumentException("Invalid record detected in batch sync");
                        }
                        if (!eventDao.isMember(r.getEventId(), userId)) {
                            throw new io.javalin.http.ForbiddenResponse("Not a member of event: " + r.getEventId());
                        }
                        
                        boolean isHost = eventDao.isHost(r.getEventId(), userId);
                        ScoutingRecord existing = recordDao.findById(r.getId());
                        
                        if (!isHost) {
                            // Ordinary scouts can only sync their own records
                            if (r.getScoutId() == null || r.getScoutId().isBlank()) {
                                r.setScoutId(userId);
                            } else if (!r.getScoutId().equals(userId)) {
                                throw new io.javalin.http.ForbiddenResponse("Cannot sync records belonging to another scout");
                            }
                            
                            if (existing != null && !existing.getScoutId().equals(userId)) {
                                throw new io.javalin.http.ForbiddenResponse("Cannot modify another scout's record");
                            }
                        } else {
                            if (r.getScoutId() == null || r.getScoutId().isBlank()) {
                                r.setScoutId(userId);
                            }
                        }
                        
                        if (r.getScoutName() == null || r.getScoutName().isBlank()) {
                            r.setScoutName(existing != null && existing.getScoutName() != null ? existing.getScoutName() : (r.getScoutId() != null ? r.getScoutId() : userId));
                        }
                        
                        r.setSyncStatus("SYNCED");
                        recordDao.upsert(r);
                    }
                });
                ctx.status(200).result("OK");
            } catch (io.javalin.http.HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                ctx.status(400).result("Sync failed: " + e.getMessage());
            }
        });

        routes.get("/api/records/pending", ctx -> {
            String eventId = ctx.queryParam("eventId");
            if (eventId == null || eventId.isBlank()) {
                ctx.status(400).result("eventId required");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findPendingByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        // ==================== AI Settings ====================

        routes.get("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot access settings of another user");
            }

            List<com.bear27570.app.model.AiSettings> settings = jdbi.withExtension(
                com.bear27570.app.dao.AiSettingsDao.class, 
                dao -> dao.findByUserId(sessionUserId)
            );

            // Mask the API keys before sending to frontend
            for (com.bear27570.app.model.AiSettings s : settings) {
                try {
                    String raw = com.bear27570.app.util.AESUtil.decrypt(s.getApiKeyEncrypted());
                    if (raw != null && raw.length() > 6) {
                        s.setApiKeyEncrypted(raw.substring(0, 2) + "****************" + raw.substring(raw.length() - 4));
                    } else if (raw != null && !raw.isEmpty()) {
                        s.setApiKeyEncrypted("****");
                    }
                } catch (com.bear27570.app.util.KeyDecryptionException e) {
                    s.setApiKeyEncrypted("ERR_KEY_LOST");
                }
            }

            ctx.result(gson.toJson(settings)).contentType("application/json");
        });

        routes.post("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify settings of another user");
            }

            com.bear27570.app.model.AiSettings newSettings;
            try {
                newSettings = gson.fromJson(ctx.body(), com.bear27570.app.model.AiSettings.class);
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body: " + e.getMessage()))).contentType("application/json");
                return;
            }

            if (newSettings == null || newSettings.getProvider() == null || newSettings.getProvider().isBlank()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body or missing provider"))).contentType("application/json");
                return;
            }
            newSettings.setUserId(sessionUserId);

            try {
                jdbi.useExtension(com.bear27570.app.dao.AiSettingsDao.class, dao -> {
                    com.bear27570.app.model.AiSettings existing = dao.findByUserIdAndProvider(sessionUserId, newSettings.getProvider());
                    
                    String submittedKey = newSettings.getApiKeyEncrypted();
                    if (submittedKey == null || submittedKey.trim().isEmpty() || submittedKey.contains("***")) {
                        if (existing != null && existing.getApiKeyEncrypted() != null && !existing.getApiKeyEncrypted().isBlank()) {
                            // Keep existing encrypted key
                            newSettings.setApiKeyEncrypted(existing.getApiKeyEncrypted());
                        } else {
                            throw new IllegalArgumentException("API Key is required for new provider configuration");
                        }
                    } else {
                        // Encrypt new raw key
                        newSettings.setApiKeyEncrypted(com.bear27570.app.util.AESUtil.encrypt(submittedKey.trim()));
                    }

                    dao.upsert(newSettings);
                });

                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (IllegalArgumentException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save settings: " + e.getMessage()))).contentType("application/json");
            }
        });

        routes.get("/api/ai/test-connection", ctx -> {
            String sessionUserId = ctx.attribute("userId");
            String provider = ctx.queryParam("provider");
            String proxyHost = ctx.queryParam("proxyHost");
            String proxyPortStr = ctx.queryParam("proxyPort");
            String customBaseUrl = ctx.queryParam("baseUrl");
            String queryApiKey = ctx.queryParam("apiKey");
            
            if (provider == null || provider.isEmpty()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider"))).contentType("application/json");
                return;
            }

            // Determine API Key: passed in query (if not masked) OR decrypt from DB for current user
            String rawApiKey = null;
            if (queryApiKey != null && !queryApiKey.isBlank() && !queryApiKey.contains("***") && !queryApiKey.equals("****")) {
                rawApiKey = queryApiKey.trim();
            } else if (sessionUserId != null) {
                try {
                    AiSettings saved = jdbi.withExtension(AiSettingsDao.class, dao -> dao.findByUserIdAndProvider(sessionUserId, provider.toUpperCase()));
                    if (saved != null && saved.getApiKeyEncrypted() != null && !saved.getApiKeyEncrypted().isBlank()) {
                        rawApiKey = com.bear27570.app.util.AESUtil.decrypt(saved.getApiKeyEncrypted());
                    }
                } catch (Exception e) {
                    // Ignore DB/decryption error, will fallback to anonymous ping
                }
            }

            String testUrl;
            if ("OPENAI".equalsIgnoreCase(provider)) {
                if (customBaseUrl != null && !customBaseUrl.isBlank()) {
                    String bUrl = customBaseUrl.trim();
                    if (bUrl.endsWith("/")) bUrl = bUrl.substring(0, bUrl.length() - 1);
                    testUrl = bUrl.endsWith("/models") ? bUrl : (bUrl.endsWith("/v1") ? bUrl + "/models" : bUrl + "/v1/models");
                } else {
                    testUrl = "https://api.openai.com/v1/models";
                }
            } else if ("GEMINI".equalsIgnoreCase(provider)) {
                testUrl = "https://generativelanguage.googleapis.com/v1beta/models";
            } else {
                ctx.status(400).result(gson.toJson(Map.of("error", "Unsupported provider: " + provider))).contentType("application/json");
                return;
            }

            java.net.Proxy proxy = java.net.Proxy.NO_PROXY;
            if (proxyPortStr != null && !proxyPortStr.isEmpty()) {
                try {
                    int port = Integer.parseInt(proxyPortStr);
                    String host = (proxyHost != null && !proxyHost.isEmpty()) ? proxyHost : "127.0.0.1";
                    proxy = new java.net.Proxy(java.net.Proxy.Type.HTTP, new java.net.InetSocketAddress(host, port));
                } catch (NumberFormatException e) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Invalid proxy port"))).contentType("application/json");
                    return;
                }
            }

            long start = System.currentTimeMillis();
            try {
                java.net.URL url = new java.net.URL(testUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection(proxy);
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                
                boolean hasKey = (rawApiKey != null && !rawApiKey.isBlank());
                if (hasKey) {
                    if ("GEMINI".equalsIgnoreCase(provider)) {
                        conn.setRequestProperty("x-goog-api-key", rawApiKey);
                    } else {
                        conn.setRequestProperty("Authorization", "Bearer " + rawApiKey);
                    }
                }
                
                int code = conn.getResponseCode();
                long latency = System.currentTimeMillis() - start;
                
                boolean success;
                String message;
                if (code == 200) {
                    success = true;
                    message = hasKey ? "API Key and endpoint authenticated successfully! (200 OK)" : "Endpoint reached successfully! (200 OK)";
                } else if (!hasKey && (code == 401 || code == 403)) {
                    // Anonymous ping reached the server
                    success = true;
                    message = "Network connection is reachable (HTTP " + code + "). Please enter and save your API key to authenticate.";
                } else {
                    success = false;
                    if (code == 401 || code == 403 || code == 400) {
                        message = "Authentication failed (HTTP " + code + "): Invalid or unauthorized API key.";
                    } else {
                        message = "Endpoint returned HTTP " + code;
                    }
                }
                
                ctx.result(gson.toJson(Map.of("success", success, "statusCode", code, "latencyMs", latency, "message", message))).contentType("application/json");
            } catch (Exception e) {
                long latency = System.currentTimeMillis() - start;
                ctx.result(gson.toJson(Map.of("success", false, "error", e.getMessage() != null ? e.getMessage() : e.toString(), "latencyMs", latency))).contentType("application/json");
            }
        });

        routes.post("/api/ai/chat", ctx -> {
            String sessionUserId = ctx.attribute("userId");
            if (sessionUserId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }

            com.google.gson.JsonObject body;
            try {
                com.google.gson.JsonElement parsed = com.google.gson.JsonParser.parseString(ctx.body());
                if (!parsed.isJsonObject()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                    return;
                }
                body = parsed.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON format: " + e.getMessage()))).contentType("application/json");
                return;
            }

            String provider = body.has("provider") && !body.get("provider").isJsonNull() ? body.get("provider").getAsString() : null;
            if (provider == null || provider.isEmpty()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing provider"))).contentType("application/json");
                return;
            }

            com.bear27570.app.model.AiSettings settings = jdbi.withExtension(
                com.bear27570.app.dao.AiSettingsDao.class,
                dao -> dao.findByUserIdAndProvider(sessionUserId, provider)
            );

            if (settings == null) {
                ctx.status(400).result(gson.toJson(Map.of("error", "AI Settings not configured for provider: " + provider))).contentType("application/json");
                return;
            }

            String sysPrompt = body.has("systemPrompt") && !body.get("systemPrompt").isJsonNull() ? body.get("systemPrompt").getAsString() : settings.getSystemPrompt();

            java.util.List<java.util.Map<String, String>> msgList = new java.util.ArrayList<>();
            if (body.has("messages") && body.get("messages").isJsonArray()) {
                com.google.gson.JsonArray arr = body.getAsJsonArray("messages");
                for (com.google.gson.JsonElement e : arr) {
                    if (e.isJsonObject()) {
                        com.google.gson.JsonObject msgObj = e.getAsJsonObject();
                        java.util.Map<String, String> m = new java.util.HashMap<>();
                        m.put("role", msgObj.has("role") && !msgObj.get("role").isJsonNull() ? msgObj.get("role").getAsString() : "user");
                        m.put("content", msgObj.has("content") && !msgObj.get("content").isJsonNull() ? msgObj.get("content").getAsString() : "");
                        msgList.add(m);
                    }
                }
            }

            try {
                String reply = com.bear27570.app.util.AiClient.chat(settings, sysPrompt, msgList);
                ctx.result(gson.toJson(java.util.Map.of("reply", reply))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(java.util.Map.of("error", e.getMessage()))).contentType("application/json");
            }
        });

        routes.get("/api/events/{id}/ai-chat", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }
            com.bear27570.app.model.AiChatSession session = jdbi.withExtension(
                com.bear27570.app.dao.AiChatSessionDao.class,
                dao -> dao.findSession(userId, eventId)
            );
            if (session != null && session.getChatHistoryJson() != null) {
                ctx.result(session.getChatHistoryJson()).contentType("application/json");
            } else {
                ctx.result("[]").contentType("application/json");
            }
        });

        routes.put("/api/events/{id}/ai-chat", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Not logged in");
            }
            
            // Validate JSON format roughly
            String jsonBody = ctx.body();
            try {
                com.google.gson.JsonElement el = com.google.gson.JsonParser.parseString(jsonBody);
                if (!el.isJsonArray()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Body must be a JSON array"))).contentType("application/json");
                    return;
                }
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON"))).contentType("application/json");
                return;
            }

            try {
                com.bear27570.app.model.AiChatSession session = new com.bear27570.app.model.AiChatSession();
                session.setUserId(userId);
                session.setEventId(eventId);
                session.setChatHistoryJson(jsonBody);

                jdbi.useExtension(com.bear27570.app.dao.AiChatSessionDao.class, dao -> {
                    dao.saveSession(session);
                });
                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save session: " + e.getMessage()))).contentType("application/json");
            }
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
