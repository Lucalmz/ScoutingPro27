package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.service.CrdtProjectionService;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import io.javalin.http.ForbiddenResponse;
import org.jdbi.v3.core.Jdbi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * REST endpoints for event CRDT MergeableStore snapshots and incremental
 * dirty-row relational projection (`GET/PUT /api/events/{eventId}/crdt-state`).
 */
public class CrdtRoutes {

    private final Jdbi jdbi;
    private final Gson gson;
    private final CrdtProjectionService projectionService;

    public CrdtRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
        this.projectionService = new CrdtProjectionService(jdbi, gson);
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/events/{eventId}/crdt-state", ctx -> {
            String eventId = ctx.pathParam("eventId");
            if (eventId.isBlank()) {
                ctx.status(400).result("{\"error\":\"Invalid eventId\"}").contentType("application/json");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            CrdtProjectionService.LoadResult loaded = projectionService.loadState(eventId);
            JsonObject out = new JsonObject();
            out.addProperty("exists", loaded.exists());
            out.addProperty("eventId", loaded.eventId());
            out.addProperty("hostEpoch", loaded.hostEpoch());
            out.addProperty("snapshotRevision", loaded.snapshotRevision());
            out.add("snapshot", loaded.snapshot() != null ? loaded.snapshot() : JsonNull.INSTANCE);
            if (loaded.updatedAt() != null) {
                out.addProperty("updatedAt", loaded.updatedAt());
            } else {
                out.add("updatedAt", JsonNull.INSTANCE);
            }
            ctx.status(200).result(out.toString()).contentType("application/json");
        });

        routes.put("/api/events/{eventId}/crdt-state", ctx -> {
            String eventId = ctx.pathParam("eventId");
            if (eventId.isBlank()) {
                ctx.status(400).result("{\"error\":\"Invalid eventId\"}").contentType("application/json");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            JsonObject body;
            try {
                JsonElement parsedBody = JsonParser.parseString(ctx.body());
                if (parsedBody == null || !parsedBody.isJsonObject()) {
                    ctx.status(400).result("{\"error\":\"Request body must be a JSON object\"}").contentType("application/json");
                    return;
                }
                body = parsedBody.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result("{\"error\":\"Invalid JSON body\"}").contentType("application/json");
                return;
            }

            int hostEpoch = parseInt(body.get("hostEpoch"), 1);
            long snapshotRevision = parseLong(body.get("snapshotRevision"), 0L);
            boolean fullProjection = parseBoolean(body.get("fullProjection"), false);

            JsonElement snapshotEl = extractSnapshotElement(body);
            if (snapshotEl == null || !snapshotEl.isJsonArray()) {
                ctx.status(400).result("{\"error\":\"snapshot array is required\"}").contentType("application/json");
                return;
            }

            Map<String, List<String>> dirtyRows = parseDirtyRows(body.get("dirtyRows"));

            CrdtProjectionService.SaveResult res = projectionService.saveAndProject(
                    eventId,
                    hostEpoch,
                    snapshotRevision,
                    snapshotEl,
                    dirtyRows,
                    fullProjection
            );

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("saved", res.saved());
            payload.put("stale", res.stale());
            payload.put("eventId", res.eventId());
            payload.put("hostEpoch", res.hostEpoch());
            payload.put("snapshotRevision", res.snapshotRevision());
            if (res.reason() != null) {
                payload.put("error", res.reason());
            }
            if (res.projectedCounts() != null && !res.projectedCounts().isEmpty()) {
                payload.put("projectedCounts", res.projectedCounts());
            }

            if (res.stale()) {
                ctx.status(409).result(gson.toJson(payload)).contentType("application/json");
                return;
            }
            ctx.status(200).result(gson.toJson(payload)).contentType("application/json");
        });
    }

    private static JsonElement extractSnapshotElement(JsonObject body) {
        JsonElement snap = body.get("snapshot");
        if (snap != null && !snap.isJsonNull()) {
            if (snap.isJsonArray()) {
                return snap;
            }
            if (snap.isJsonPrimitive() && snap.getAsJsonPrimitive().isString()) {
                try {
                    return JsonParser.parseString(snap.getAsString());
                } catch (Exception ignored) {
                    return null;
                }
            }
        }
        JsonElement rawStr = body.get("crdtSnapshotJson");
        if (rawStr != null && !rawStr.isJsonNull()) {
            if (rawStr.isJsonArray()) {
                return rawStr;
            }
            if (rawStr.isJsonPrimitive() && rawStr.getAsJsonPrimitive().isString()) {
                try {
                    return JsonParser.parseString(rawStr.getAsString());
                } catch (Exception ignored) {
                    return null;
                }
            }
        }
        return null;
    }

    private static Map<String, List<String>> parseDirtyRows(JsonElement el) {
        Map<String, List<String>> map = new LinkedHashMap<>();
        if (el == null || !el.isJsonObject()) {
            return map;
        }
        JsonObject obj = el.getAsJsonObject();
        for (Map.Entry<String, JsonElement> entry : obj.entrySet()) {
            if (!entry.getValue().isJsonArray()) continue;
            JsonArray arr = entry.getValue().getAsJsonArray();
            List<String> ids = new ArrayList<>();
            for (JsonElement idEl : arr) {
                if (idEl != null && idEl.isJsonPrimitive()) {
                    ids.add(idEl.getAsString());
                }
            }
            map.put(entry.getKey(), ids);
        }
        return map;
    }

    private static int parseInt(JsonElement el, int fallback) {
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            return (int) Math.round(el.getAsDouble());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long parseLong(JsonElement el, long fallback) {
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            return el.getAsLong();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static boolean parseBoolean(JsonElement el, boolean fallback) {
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            if (el.getAsJsonPrimitive().isBoolean()) return el.getAsBoolean();
            return Boolean.parseBoolean(el.getAsString());
        } catch (Exception e) {
            return fallback;
        }
    }
}
