package com.bear27570.app.routes;

import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.User;
import com.bear27570.app.util.JwtUtil;
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
            String userId = JwtUtil.verifyToken(tokenToVerify);
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
                    String userId = UUID.randomUUID().toString();
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
                User user = jdbi.inTransaction(handle -> {
                    UserDao dao = handle.attach(UserDao.class);
                    User registered = dao.findRegisteredByUsername(username.trim());
                    if (registered != null && registered.getPassword() != null &&
                        BCrypt.checkpw(password, registered.getPassword())) {
                        return registered;
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
                User updated = jdbi.inTransaction(handle -> {
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

                    // Update scout_name in local records for UI consistency, but scout_id remains unchanged
                    handle.execute("UPDATE scouting_records SET scout_name = ? WHERE scout_id = ?", targetUsername, oldId);
                    User u = dao.findById(oldId);
                    return u != null ? u : new User(oldId, targetUsername);
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
    }
}
