package com.bear27570.app.routes.ai;

import com.bear27570.app.dao.AiChatSessionDao;
import com.bear27570.app.dao.AiChatThreadDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.model.AiChatSession;
import com.bear27570.app.model.AiChatThread;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;
import org.jdbi.v3.core.Jdbi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * HTTP routes for multi-thread event Copilot sessions and legacy `/ai-chat` history migration/compatibility.
 */
public final class AiThreadRoutes {
    private static final Pattern TURBO_CLOSED_BLOCK = Pattern.compile("```sp27-action[ \\t]*(?:\\r?\\n)?[\\s\\S]*?```", Pattern.CASE_INSENSITIVE);
    private static final Pattern TURBO_OPEN_BLOCK = Pattern.compile("```sp27-action[\\s\\S]*$", Pattern.CASE_INSENSITIVE);

    private static String stripTurboActionBlocks(String content) {
        if (content == null || content.isEmpty()) return "";
        String cleaned = TURBO_CLOSED_BLOCK.matcher(content).replaceAll("");
        cleaned = TURBO_OPEN_BLOCK.matcher(cleaned).replaceAll("");
        return cleaned.trim();
    }
    private final Jdbi jdbi;
    private final Gson gson;

    public AiThreadRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        // Legacy event chat history endpoints
        routes.get("/api/events/{id}/ai-chat", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = requireEventMember(ctx, eventId);
            AiChatSession session = jdbi.withExtension(
                    AiChatSessionDao.class,
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
            String userId = requireEventMember(ctx, eventId);

            String jsonBody = ctx.body();
            try {
                JsonElement el = JsonParser.parseString(jsonBody);
                if (!el.isJsonArray()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Body must be a JSON array"))).contentType("application/json");
                    return;
                }
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON"))).contentType("application/json");
                return;
            }

            try {
                AiChatSession session = new AiChatSession();
                session.setUserId(userId);
                session.setEventId(eventId);
                session.setChatHistoryJson(jsonBody);

                jdbi.useExtension(AiChatSessionDao.class, dao -> dao.saveSession(session));
                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save session: " + e.getMessage()))).contentType("application/json");
            }
        });

        // Multi-thread Copilot session endpoints
        routes.get("/api/events/{id}/ai-threads", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = requireEventMember(ctx, eventId);

            List<AiChatThread> threads = ensureThreadsMigrated(userId, eventId);
            List<Map<String, Object>> summaries = new ArrayList<>();
            for (AiChatThread t : threads) {
                summaries.add(toThreadSummary(t));
            }
            ctx.result(gson.toJson(summaries)).contentType("application/json");
        });

        routes.post("/api/events/{id}/ai-threads", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = requireEventMember(ctx, eventId);

            JsonObject body = AiUrlGuard.parseOptionalJsonObject(ctx.body());
            if (body == null && ctx.body() != null && !ctx.body().isBlank()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body"))).contentType("application/json");
                return;
            }

            try {
                AiChatThread thread = new AiChatThread();
                String reqId = body != null ? AiUrlGuard.getOptionalString(body, "id") : null;
                String normalizedId = (reqId != null && !reqId.isBlank()) ? reqId.trim() : ("thr-" + UUID.randomUUID());
                if (normalizedId.length() > 128) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Thread id exceeds 128 characters"))).contentType("application/json");
                    return;
                }
                thread.setId(normalizedId);
                thread.setUserId(userId);
                thread.setEventId(eventId);
                String title = body != null ? AiUrlGuard.getOptionalString(body, "title") : null;
                thread.setTitle((title != null && !title.isBlank()) ? trimTitle(title) : "New Tactical Chat");
                String personaId = body != null ? AiUrlGuard.getOptionalString(body, "personaId") : null;
                thread.setPersonaId((personaId != null && !personaId.isBlank()) ? AiUrlGuard.truncate(personaId.trim(), 48) : "strategist");
                Boolean pinnedVal = body != null ? AiUrlGuard.getOptionalBoolean(body, "pinned") : null;
                thread.setPinned(Boolean.TRUE.equals(pinnedVal));

                if (body != null && body.has("messages") && !body.get("messages").isJsonNull()) {
                    if (!body.get("messages").isJsonArray()) {
                        ctx.status(400).result(gson.toJson(Map.of("error", "messages must be a JSON array"))).contentType("application/json");
                        return;
                    }
                    thread.setMessagesJson(gson.toJson(body.getAsJsonArray("messages")));
                } else {
                    thread.setMessagesJson("[]");
                }
                if (body != null && body.has("contextConfig") && !body.get("contextConfig").isJsonNull()) {
                    if (!body.get("contextConfig").isJsonObject()) {
                        ctx.status(400).result(gson.toJson(Map.of("error", "contextConfig must be a JSON object"))).contentType("application/json");
                        return;
                    }
                    thread.setContextConfigJson(gson.toJson(body.getAsJsonObject("contextConfig")));
                } else {
                    thread.setContextConfigJson("{\"enabled\":true}");
                }

                AiChatThread saved = jdbi.inTransaction(handle -> {
                    AiChatThreadDao dao = handle.attach(AiChatThreadDao.class);
                    AiChatThread globalExisting = dao.findById(thread.getId());
                    if (globalExisting != null) {
                        if (!userId.equals(globalExisting.getUserId())) {
                            throw new io.javalin.http.ForbiddenResponse("Cannot overwrite AI thread of another user");
                        }
                        if (!eventId.equals(globalExisting.getEventId())) {
                            throw new io.javalin.http.ConflictResponse("Thread id belongs to another event");
                        }
                        dao.updateScoped(thread);
                    } else {
                        dao.insert(thread);
                    }
                    return dao.findByIdUserAndEvent(thread.getId(), userId, eventId);
                });

                ctx.status(200).result(gson.toJson(toThreadPayload(saved))).contentType("application/json");
            } catch (IllegalArgumentException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            }
        });

        routes.get("/api/events/{id}/ai-threads/{threadId}", ctx -> {
            String eventId = ctx.pathParam("id");
            String threadId = ctx.pathParam("threadId").trim();
            String userId = requireEventMember(ctx, eventId);

            AiChatThread globalExisting = jdbi.withExtension(AiChatThreadDao.class, dao -> dao.findById(threadId));
            if (globalExisting == null) {
                ctx.status(404).result(gson.toJson(Map.of("error", "Thread not found"))).contentType("application/json");
                return;
            }
            if (!userId.equals(globalExisting.getUserId())) {
                ctx.status(403).result(gson.toJson(Map.of("error", "Cannot access AI thread of another user"))).contentType("application/json");
                return;
            }
            if (!eventId.equals(globalExisting.getEventId())) {
                ctx.status(404).result(gson.toJson(Map.of("error", "Thread not found"))).contentType("application/json");
                return;
            }
            ctx.result(gson.toJson(toThreadPayload(globalExisting))).contentType("application/json");
        });

        routes.put("/api/events/{id}/ai-threads/{threadId}", ctx -> {
            String eventId = ctx.pathParam("id");
            String threadId = ctx.pathParam("threadId").trim();
            String userId = requireEventMember(ctx, eventId);
            if (threadId.isEmpty() || threadId.length() > 128) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid threadId length"))).contentType("application/json");
                return;
            }

            JsonObject body;
            try {
                JsonElement el = JsonParser.parseString(ctx.body());
                if (!el.isJsonObject()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                    return;
                }
                body = el.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON: " + e.getMessage()))).contentType("application/json");
                return;
            }

            try {
                AiChatThread updated = jdbi.inTransaction(handle -> {
                    AiChatThreadDao dao = handle.attach(AiChatThreadDao.class);
                    AiChatThread globalExisting = dao.findById(threadId);
                    if (globalExisting != null) {
                        if (!userId.equals(globalExisting.getUserId())) {
                            throw new io.javalin.http.ForbiddenResponse("Cannot modify AI thread of another user");
                        }
                        if (!eventId.equals(globalExisting.getEventId())) {
                            throw new io.javalin.http.ConflictResponse("Thread id belongs to another event");
                        }
                    }

                    AiChatThread target = globalExisting != null ? globalExisting : new AiChatThread();
                    target.setId(threadId);
                    target.setUserId(userId);
                    target.setEventId(eventId);

                    String title = AiUrlGuard.getOptionalString(body, "title");
                    if (title != null && !title.trim().isEmpty()) {
                        target.setTitle(trimTitle(title));
                    } else if (globalExisting == null) {
                        target.setTitle("New Tactical Chat");
                    }

                    String personaId = AiUrlGuard.getOptionalString(body, "personaId");
                    if (personaId != null && !personaId.trim().isEmpty()) {
                        target.setPersonaId(AiUrlGuard.truncate(personaId.trim(), 48));
                    } else if (globalExisting == null) {
                        target.setPersonaId("strategist");
                    }

                    Boolean pinnedVal = AiUrlGuard.getOptionalBoolean(body, "pinned");
                    if (pinnedVal != null) {
                        target.setPinned(pinnedVal);
                    }

                    applyMessagesAndContextUpdates(target, body, globalExisting == null);
                    if (globalExisting != null) {
                        dao.updateScoped(target);
                    } else {
                        dao.insert(target);
                    }
                    return dao.findByIdUserAndEvent(threadId, userId, eventId);
                });

                ctx.status(200).result(gson.toJson(toThreadPayload(updated))).contentType("application/json");
            } catch (IllegalArgumentException | com.google.gson.JsonParseException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            }
        });

        routes.delete("/api/events/{id}/ai-threads/{threadId}", ctx -> {
            String eventId = ctx.pathParam("id");
            String threadId = ctx.pathParam("threadId").trim();
            String userId = requireEventMember(ctx, eventId);

            int deleted = jdbi.inTransaction(handle -> {
                AiChatThreadDao dao = handle.attach(AiChatThreadDao.class);
                AiChatThread globalExisting = dao.findById(threadId);
                if (globalExisting == null) return 0;
                if (!userId.equals(globalExisting.getUserId())) {
                    throw new io.javalin.http.ForbiddenResponse("Cannot delete AI thread of another user");
                }
                if (!eventId.equals(globalExisting.getEventId())) {
                    return 0;
                }
                return dao.deleteByIdUserAndEvent(threadId, userId, eventId);
            });
            if (deleted == 0) {
                ctx.status(404).result(gson.toJson(Map.of("error", "Thread not found"))).contentType("application/json");
                return;
            }
            ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
        });
    }

    private void applyMessagesAndContextUpdates(AiChatThread target, JsonObject body, boolean isNew) {
        if (body.has("messages")) {
            if (!body.get("messages").isJsonArray()) {
                throw new IllegalArgumentException("messages must be a JSON array");
            }
            target.setMessagesJson(gson.toJson(body.getAsJsonArray("messages")));
        } else if (body.has("messagesJson") && body.get("messagesJson").isJsonPrimitive()) {
            String mj = body.get("messagesJson").getAsString();
            JsonElement parsedMj = JsonParser.parseString(mj);
            if (!parsedMj.isJsonArray()) {
                throw new IllegalArgumentException("messagesJson must be a JSON array string");
            }
            target.setMessagesJson(mj);
        } else if (isNew) {
            target.setMessagesJson("[]");
        }

        if (body.has("contextConfig")) {
            if (!body.get("contextConfig").isJsonObject()) {
                throw new IllegalArgumentException("contextConfig must be a JSON object");
            }
            target.setContextConfigJson(gson.toJson(body.getAsJsonObject("contextConfig")));
        } else if (body.has("contextConfigJson") && body.get("contextConfigJson").isJsonPrimitive()) {
            String cj = body.get("contextConfigJson").getAsString();
            JsonElement parsedCj = JsonParser.parseString(cj);
            if (!parsedCj.isJsonObject()) {
                throw new IllegalArgumentException("contextConfigJson must be a JSON object string");
            }
            target.setContextConfigJson(cj);
        } else if (isNew) {
            target.setContextConfigJson("{\"enabled\":true}");
        }
    }

    private List<AiChatThread> ensureThreadsMigrated(String userId, String eventId) {
        return jdbi.inTransaction(handle -> {
            AiChatThreadDao threadDao = handle.attach(AiChatThreadDao.class);
            List<AiChatThread> existing = threadDao.findByUserAndEvent(userId, eventId);
            if (!existing.isEmpty()) {
                return existing;
            }

            AiChatSessionDao legacyDao = handle.attach(AiChatSessionDao.class);
            AiChatSession legacy = legacyDao.findSession(userId, eventId);
            if (legacy != null && legacy.getChatHistoryJson() != null && !legacy.getChatHistoryJson().isBlank()) {
                try {
                    JsonElement el = JsonParser.parseString(legacy.getChatHistoryJson());
                    if (el.isJsonArray() && !el.getAsJsonArray().isEmpty()) {
                        JsonArray arr = el.getAsJsonArray();
                        String title = inferTitleFromMessages(arr, "Migrated Tactical Chat");
                        AiChatThread migrated = new AiChatThread();
                        migrated.setId("thr-" + UUID.randomUUID());
                        migrated.setUserId(userId);
                        migrated.setEventId(eventId);
                        migrated.setTitle(title);
                        migrated.setPersonaId("strategist");
                        migrated.setPinned(false);
                        migrated.setMessagesJson(gson.toJson(arr));
                        migrated.setContextConfigJson("{\"enabled\":true}");
                        threadDao.insert(migrated);
                        return threadDao.findByUserAndEvent(userId, eventId);
                    }
                } catch (Exception ignored) {}
            }
            return List.of();
        });
    }

    private String requireEventMember(Context ctx, String eventId) {
        String userId = ctx.attribute("userId");
        if (userId == null) {
            throw new io.javalin.http.UnauthorizedResponse("Not logged in");
        }
        boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
        if (!isMember) {
            throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
        }
        return userId;
    }

    private Map<String, Object> toThreadSummary(AiChatThread t) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", t.getId());
        map.put("eventId", t.getEventId());
        map.put("title", t.getTitle());
        map.put("personaId", t.getPersonaId());
        map.put("pinned", t.getPinned());
        int count = 0;
        String preview = "";
        try {
            JsonElement el = JsonParser.parseString(t.getMessagesJson() != null ? t.getMessagesJson() : "[]");
            if (el.isJsonArray()) {
                JsonArray arr = el.getAsJsonArray();
                count = arr.size();
                if (count > 0 && arr.get(count - 1).isJsonObject()) {
                    JsonObject last = arr.get(count - 1).getAsJsonObject();
                    if (last.has("content") && !last.get("content").isJsonNull()) {
                        String stripped = stripTurboActionBlocks(last.get("content").getAsString())
                                .replaceAll("\\s+", " ")
                                .trim();
                        preview = stripped.length() > 80 ? stripped.substring(0, 80) + "..." : stripped;
                    }
                    if (preview.isEmpty() && last.has("turboActions") && last.get("turboActions").isJsonArray()) {
                        JsonArray actions = last.getAsJsonArray("turboActions");
                        if (!actions.isEmpty() && actions.get(0).isJsonObject()) {
                            JsonObject firstAct = actions.get(0).getAsJsonObject();
                            if (firstAct.has("summary") && !firstAct.get("summary").isJsonNull()) {
                                String rawAction = ("[Turbo] " + firstAct.get("summary").getAsString())
                                        .replaceAll("\\s+", " ")
                                        .trim();
                                preview = rawAction.length() > 80 ? rawAction.substring(0, 80) + "..." : rawAction;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        map.put("messageCount", count);
        map.put("lastMessagePreview", preview);
        map.put("createdAt", t.getCreatedAt());
        map.put("updatedAt", t.getUpdatedAt());
        return map;
    }

    private JsonObject toThreadPayload(AiChatThread t) {
        JsonObject obj = new JsonObject();
        obj.addProperty("id", t.getId());
        obj.addProperty("userId", t.getUserId());
        obj.addProperty("eventId", t.getEventId());
        obj.addProperty("title", t.getTitle());
        obj.addProperty("personaId", t.getPersonaId());
        obj.addProperty("pinned", t.getPinned());
        try {
            JsonElement msgEl = JsonParser.parseString(t.getMessagesJson() != null ? t.getMessagesJson() : "[]");
            obj.add("messages", msgEl.isJsonArray() ? msgEl.getAsJsonArray() : new JsonArray());
        } catch (Exception e) {
            obj.add("messages", new JsonArray());
        }
        try {
            JsonElement cfgEl = JsonParser.parseString(t.getContextConfigJson() != null ? t.getContextConfigJson() : "{}");
            obj.add("contextConfig", cfgEl.isJsonObject() ? cfgEl.getAsJsonObject() : new JsonObject());
        } catch (Exception e) {
            obj.add("contextConfig", new JsonObject());
        }
        if (t.getCreatedAt() != null) obj.add("createdAt", gson.toJsonTree(t.getCreatedAt()));
        if (t.getUpdatedAt() != null) obj.add("updatedAt", gson.toJsonTree(t.getUpdatedAt()));
        return obj;
    }

    private static String inferTitleFromMessages(JsonArray arr, String fallback) {
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) continue;
            JsonObject obj = el.getAsJsonObject();
            String role = obj.has("role") && !obj.get("role").isJsonNull() ? obj.get("role").getAsString() : "";
            if ("user".equalsIgnoreCase(role) && obj.has("content") && !obj.get("content").isJsonNull()) {
                String text = obj.get("content").getAsString().replaceAll("\\s+", " ").trim();
                if (!text.isEmpty()) {
                    return text.length() > 36 ? text.substring(0, 36) + "..." : text;
                }
            }
        }
        return fallback;
    }

    private static String trimTitle(String raw) {
        String clean = raw.replaceAll("\\s+", " ").trim();
        return clean.length() > 180 ? clean.substring(0, 180) : clean;
    }
}
