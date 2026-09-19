package com.bear27570.app.routes;

import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.bear27570.app.model.User;
import com.bear27570.app.util.DbUtil;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.UserUtil;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import io.javalin.http.BadRequestResponse;
import io.javalin.http.ConflictResponse;
import io.javalin.http.HttpResponseException;
import io.javalin.http.NotFoundResponse;
import io.javalin.http.UnauthorizedResponse;
import org.jdbi.v3.core.Jdbi;
import org.mindrot.jbcrypt.BCrypt;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class UserRoutes {
    private final Jdbi jdbi;
    private final Gson gson;

    public UserRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/user/check", ctx -> {
            String username = ctx.queryParam("username");
            if (username == null || username.isBlank()) {
                ctx.status(400).result("username required");
                return;
            }
            boolean exists = jdbi.withExtension(UserDao.class, dao -> dao.findRegisteredByUsername(username) != null);
            ctx.result(gson.toJson(Map.of("exists", exists))).contentType("application/json");
        });

        routes.post("/api/user/verify-token", ctx -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            String tokenToVerify = body != null ? asString(body.get("token")) : null;
            if (tokenToVerify == null || tokenToVerify.isBlank()) {
                ctx.status(400).result("token required");
                return;
            }
            JwtUtil.TokenClaims claims = JwtUtil.verifyTokenClaims(tokenToVerify);
            if (claims == null || claims.getUserId() == null) {
                ctx.status(401).result("Invalid token signature");
                return;
            }
            User user = jdbi.withExtension(UserDao.class, dao -> dao.findById(claims.getUserId()));
            if (user == null) {
                if (claims.getUsername() != null && !claims.getUsername().isBlank()) {
                    User migrated = jdbi.withExtension(UserDao.class, dao -> dao.findRegisteredByUsername(claims.getUsername()));
                    if (migrated != null) {
                        String refreshed = JwtUtil.generateToken(migrated.getId(), migrated.getUsername());
                        ctx.header("X-Refreshed-Token", refreshed);
                        ctx.result(gson.toJson(Map.of(
                                "valid", true,
                                "userId", migrated.getId(),
                                "username", migrated.getUsername(),
                                "token", refreshed
                        ))).contentType("application/json");
                        return;
                    }
                }
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
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String username = asString(body.get("username"));
            String password = asString(body.get("password"));
            
            if (username == null || username.isBlank() || password == null || password.isBlank()) {
                ctx.status(400).result("username and password required");
                return;
            }
            if (username.length() > 50 || password.length() > 72) {
                ctx.status(400).result("username or password too long");
                return;
            }
            try {
                User user = jdbi.inTransaction(handle -> {
                    UserDao dao = handle.attach(UserDao.class);
                    User existing = dao.findRegisteredByUsername(username);
                    if (existing != null) {
                        throw new RuntimeException("User already exists");
                    }
                    String userId = UserUtil.generateDeterministicUserId(username.trim());
                    User u = new User(userId, username.trim());
                    u.setPassword(BCrypt.hashpw(password, BCrypt.gensalt()));
                    dao.upsert(u);
                    return u;
                });
                
                String token = JwtUtil.generateToken(user.getId(), user.getUsername());
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
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String username = asString(body.get("username"));
            String password = asString(body.get("password"));
            
            if (username == null || username.isBlank() || password == null || password.isBlank()) {
                ctx.status(400).result("username and password required");
                return;
            }
            try {
                String trimmedInputName = username.trim();
                User user = jdbi.inTransaction(handle -> {
                    UserDao dao = handle.attach(UserDao.class);
                    User u = dao.findRegisteredByUsername(trimmedInputName);
                    if (u != null && u.getPassword() != null && !u.getPassword().isBlank() &&
                        BCrypt.checkpw(password, u.getPassword())) {
                        return u;
                    }
                    throw new RuntimeException("Invalid credentials");
                });
                
                String token = JwtUtil.generateToken(user.getId(), user.getUsername());
                Map<String, Object> resp = new HashMap<>();
                resp.put("id", user.getId());
                resp.put("username", user.getUsername());
                resp.put("token", token);
                ctx.result(gson.toJson(resp)).contentType("application/json");
            } catch (RuntimeException e) {
                if ("Invalid credentials".equals(e.getMessage())) {
                    ctx.status(401).result("Invalid credentials");
                } else {
                    System.err.println("Login error: " + e.getMessage());
                    ctx.status(500).result("Internal Server Error");
                }
            }
        });

        routes.post("/api/user/rename", ctx -> {
            String oldId = ctx.attribute("userId");
            if (oldId == null || oldId.isBlank()) {
                throw new UnauthorizedResponse("Unauthorized");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String newUsername = asString(body.get("newUsername"));
            String oldPassword = asString(body.get("oldPassword"));
            String newPassword = asString(body.get("newPassword"));

            try {
                User updated = DbUtil.withDeadlockRetry(() -> {
                    synchronized (DbUtil.RECORD_WRITE_LOCK) {
                        return jdbi.inTransaction(handle -> {
                            UserDao dao = handle.attach(UserDao.class);
                            User existing = dao.findById(oldId);
                            if (existing == null) {
                                throw new NotFoundResponse("User not found");
                            }

                            String targetUsername = (newUsername != null && !newUsername.isBlank()) ? newUsername.trim() : existing.getUsername();
                            if (targetUsername.length() > 50) {
                                throw new BadRequestResponse("newUsername too long");
                            }

                            // Check username conflict if username changed
                            if (!targetUsername.equalsIgnoreCase(existing.getUsername())) {
                                User conflict = dao.findRegisteredByUsername(targetUsername);
                                if (conflict != null && !conflict.getId().equals(oldId)) {
                                    throw new ConflictResponse("Username already taken");
                                }
                            }

                            // If changing password, verify old password
                            String newHashedPassword = null;
                            if (newPassword != null && !newPassword.isBlank()) {
                                if (existing.getPassword() != null && !existing.getPassword().isBlank()) {
                                    if (oldPassword == null || oldPassword.isBlank() || !BCrypt.checkpw(oldPassword, existing.getPassword())) {
                                        throw new UnauthorizedResponse("Incorrect old password");
                                    }
                                }
                                newHashedPassword = BCrypt.hashpw(newPassword, BCrypt.gensalt(12));
                            }

                            // User ID is IMMUTABLE: do not change ID or cascade migrate ID across tables
                            if (newHashedPassword != null) {
                                handle.execute("UPDATE users SET username = ?, password = ? WHERE id = ?", targetUsername, newHashedPassword, oldId);
                            } else {
                                handle.execute("UPDATE users SET username = ? WHERE id = ?", targetUsername, oldId);
                            }

                            // Update scout_name in local records for UI consistency, bumping version & updated_at so synced peers receive updates
                            handle.execute("UPDATE scouting_records SET scout_name = ?, version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?", targetUsername, oldId);
                            handle.execute("UPDATE scout_assignments SET scout_name = ?, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?", targetUsername, oldId);
                            handle.execute("UPDATE pit_scouting_records SET scout_name = ?, version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?", targetUsername, oldId);
                            User u = dao.findById(oldId);
                            return u != null ? u : new User(oldId, targetUsername);
                        });
                    }
                });

                String newToken = JwtUtil.generateToken(updated.getId(), updated.getUsername());
                ctx.result(gson.toJson(Map.of(
                        "id", updated.getId(),
                        "username", updated.getUsername(),
                        "token", newToken
                ))).contentType("application/json");
            } catch (HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                System.err.println("Rename/profile update error: " + e.getMessage());
                ctx.status(500).result("Internal Server Error: " + e.getMessage());
            }
        });

        io.javalin.http.Handler mergeHandler = ctx -> {
            String sourceId = ctx.attribute("userId");
            if (sourceId == null || sourceId.isBlank()) {
                throw new UnauthorizedResponse("Unauthorized");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String targetUsername = asString(body.get("targetUsername"));
            String targetPassword = asString(body.get("targetPassword"));

            if (targetUsername == null || targetUsername.isBlank() || targetPassword == null || targetPassword.isBlank()) {
                throw new BadRequestResponse("targetUsername and targetPassword required");
            }

            try {
                User targetUser = DbUtil.withDeadlockRetry(() -> {
                    synchronized (DbUtil.RECORD_WRITE_LOCK) {
                        return jdbi.inTransaction(handle -> {
                            UserDao dao = handle.attach(UserDao.class);
                            User target = dao.findRegisteredByUsername(targetUsername.trim());
                            if (target == null) {
                                throw new NotFoundResponse("Target user not found");
                            }
                            String cleanTargetPwd = targetPassword.trim();
                            if (target.getPassword() == null || target.getPassword().isBlank() || !BCrypt.checkpw(cleanTargetPwd, target.getPassword())) {
                                throw new UnauthorizedResponse("Invalid target account password");
                            }
                            if (target.getId().equals(sourceId)) {
                                // Already target user and password is verified! Return target user directly.
                                return target;
                            }

                            // Perform atomic cascade migration from sourceId to target.getId()
                            UserDeterministicIdMigrator.mergeUserInto(handle, sourceId, target.getId(), target.getUsername());
                            return target;
                        });
                    }
                });

                String newToken = JwtUtil.generateToken(targetUser.getId(), targetUser.getUsername());
                ctx.result(gson.toJson(Map.of(
                        "id", targetUser.getId(),
                        "username", targetUser.getUsername(),
                        "token", newToken
                ))).contentType("application/json");
            } catch (HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                System.err.println("User merge error: " + e.getMessage());
                ctx.status(500).result("Internal Server Error: " + e.getMessage());
            }
        };

        routes.post("/api/user/merge", mergeHandler);
        routes.post("/api/users/merge", mergeHandler);
    }
}
