package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.ScheduleDao;
import com.bear27570.app.model.MatchScheduleItem;
import com.bear27570.app.model.ScoutAssignment;
import com.bear27570.app.model.ScoutingEvent;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class ScheduleRoutes {

    private static final Logger logger = LoggerFactory.getLogger(ScheduleRoutes.class);
    private final Jdbi jdbi;
    private final Gson gson;

    public ScheduleRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        // 1. 获取赛事的完整赛程与排班
        routes.get("/api/events/{id}/schedule", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            if (userId != null) {
                boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
                if (!isMember) {
                    throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
                }
            }
            List<MatchScheduleItem> schedules = jdbi.withExtension(ScheduleDao.class, dao -> dao.findSchedulesByEvent(eventId));
            List<ScoutAssignment> assignments = jdbi.withExtension(ScheduleDao.class, dao -> dao.findAssignmentsByEvent(eventId));

            Map<String, Object> result = new HashMap<>();
            result.put("schedules", schedules);
            result.put("assignments", assignments);
            ctx.result(gson.toJson(result)).contentType("application/json");
        });

        // 2. 批量导入/保存赛程
        routes.post("/api/events/{id}/schedule/batch", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new io.javalin.http.NotFoundResponse("Event not found");
            }
            if (userId == null || !userId.equals(event.getHostId())) {
                throw new io.javalin.http.ForbiddenResponse("Only the event host can modify match schedule or assignments");
            }

            JsonObject body;
            try {
                body = gson.fromJson(ctx.body(), JsonObject.class);
            } catch (com.google.gson.JsonSyntaxException e) {
                ctx.status(400).result("Invalid JSON payload");
                return;
            }
            if (body == null || !body.has("items") || !body.get("items").isJsonArray()) {
                ctx.status(400).result("items array required");
                return;
            }

            boolean replace = getBoolOrDefault(body, "replace", false);
            JsonArray itemsArray = body.getAsJsonArray("items");
            List<MatchScheduleItem> items = new ArrayList<>();

            for (JsonElement el : itemsArray) {
                if (!el.isJsonObject()) continue;
                JsonObject obj = el.getAsJsonObject();
                int matchNumber = getIntOrDefault(obj, "matchNumber", 0);
                if (matchNumber <= 0) continue;

                String tournamentLevel = getStrOrDefault(obj, "tournamentLevel", "QUALIFICATION");
                int red1 = getIntOrDefault(obj, "red1", 0);
                int red2 = getIntOrDefault(obj, "red2", 0);
                int blue1 = getIntOrDefault(obj, "blue1", 0);
                int blue2 = getIntOrDefault(obj, "blue2", 0);

                String rawId = getStrOrDefault(obj, "id", "");
                String id = !rawId.isBlank() ? rawId : UUID.randomUUID().toString();

                items.add(new MatchScheduleItem(id, eventId, matchNumber, tournamentLevel, red1, red2, blue1, blue2));
            }

            List<ScoutAssignment> explicitAssignments = new ArrayList<>();
            if (body.has("assignments") && body.get("assignments").isJsonArray()) {
                JsonArray arr = body.getAsJsonArray("assignments");
                for (JsonElement el : arr) {
                    if (!el.isJsonObject()) continue;
                    ScoutAssignment parsed = parseAssignmentObject(eventId, el.getAsJsonObject());
                    if (parsed != null) {
                        explicitAssignments.add(parsed);
                    }
                }
            }

            jdbi.useTransaction(handle -> {
                ScheduleDao dao = handle.attach(ScheduleDao.class);
                if (replace) {
                    dao.clearSchedulesByEvent(eventId);
                    // 若覆盖赛程，现有排班也一并清空重建
                    dao.clearAssignmentsByEvent(eventId);
                }
                for (MatchScheduleItem item : items) {
                    dao.upsertSchedule(item);

                    // 自动初始化 4 个工位的留空排班（若尚不存在）
                    initStationAssignment(dao, eventId, item.getMatchNumber(), item.getTournamentLevel(), "red1", item.getRed1());
                    initStationAssignment(dao, eventId, item.getMatchNumber(), item.getTournamentLevel(), "red2", item.getRed2());
                    initStationAssignment(dao, eventId, item.getMatchNumber(), item.getTournamentLevel(), "blue1", item.getBlue1());
                    initStationAssignment(dao, eventId, item.getMatchNumber(), item.getTournamentLevel(), "blue2", item.getBlue2());
                }

                for (ScoutAssignment a : explicitAssignments) {
                    dao.upsertAssignment(a);
                }
            });

            ctx.status(200).result(gson.toJson(Map.of("success", true, "count", items.size()))).contentType("application/json");
        });

        // 3. 清空赛程与排班
        routes.delete("/api/events/{id}/schedule", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new io.javalin.http.NotFoundResponse("Event not found");
            }
            if (userId == null || !userId.equals(event.getHostId())) {
                throw new io.javalin.http.ForbiddenResponse("Only the event host can modify match schedule or assignments");
            }

            jdbi.useTransaction(handle -> {
                ScheduleDao dao = handle.attach(ScheduleDao.class);
                dao.clearAssignmentsByEvent(eventId);
                dao.clearSchedulesByEvent(eventId);
            });
            ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
        });

        // 4. 批量更新排班 (支持留空)
        routes.put("/api/events/{id}/assignments", ctx -> {
            String eventId = ctx.pathParam("id");
            String userId = ctx.attribute("userId");
            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new io.javalin.http.NotFoundResponse("Event not found");
            }
            if (userId == null || !userId.equals(event.getHostId())) {
                throw new io.javalin.http.ForbiddenResponse("Only the event host can modify match schedule or assignments");
            }

            JsonObject body;
            try {
                body = gson.fromJson(ctx.body(), JsonObject.class);
            } catch (com.google.gson.JsonSyntaxException e) {
                ctx.status(400).result("Invalid JSON payload");
                return;
            }
            if (body == null || !body.has("assignments") || !body.get("assignments").isJsonArray()) {
                ctx.status(400).result("assignments array required");
                return;
            }

            JsonArray arr = body.getAsJsonArray("assignments");
            List<ScoutAssignment> list = new ArrayList<>();

            for (JsonElement el : arr) {
                if (!el.isJsonObject()) continue;
                ScoutAssignment parsed = parseAssignmentObject(eventId, el.getAsJsonObject());
                if (parsed != null) {
                    list.add(parsed);
                }
            }

            jdbi.useTransaction(handle -> {
                ScheduleDao dao = handle.attach(ScheduleDao.class);
                for (ScoutAssignment a : list) {
                    dao.upsertAssignment(a);
                }
            });

            ctx.status(200).result(gson.toJson(Map.of("success", true, "count", list.size()))).contentType("application/json");
        });
    }

    private void initStationAssignment(ScheduleDao dao, String eventId, int matchNumber, String level, String station, int teamNumber) {
        String tournamentLevel = (level != null && !level.isBlank()) ? level : "QUALIFICATION";
        String id = eventId + "_" + tournamentLevel + "_" + matchNumber + "_" + station;
        ScoutAssignment existing = dao.findAssignment(eventId, matchNumber, tournamentLevel, station);
        if (existing == null) {
            // 初始工位保持 scoutId 和 scoutName 为 null（永远支持留空）
            ScoutAssignment a = new ScoutAssignment(id, eventId, matchNumber, tournamentLevel, station, teamNumber, null, null);
            dao.upsertAssignment(a);
        } else if (existing.getTeamNumber() != teamNumber) {
            // 已有工位排班：仅更新队伍编号，严格保留原有已排班人员 scoutId 和 scoutName
            ScoutAssignment updated = new ScoutAssignment(
                    existing.getId() != null ? existing.getId() : id,
                    eventId,
                    matchNumber,
                    tournamentLevel,
                    station,
                    teamNumber,
                    existing.getScoutId(),
                    existing.getScoutName()
            );
            dao.upsertAssignment(updated);
        }
    }

    private static ScoutAssignment parseAssignmentObject(String eventId, JsonObject obj) {
        int matchNumber = getIntOrDefault(obj, "matchNumber", 0);
        String station = getStrOrDefault(obj, "station", "");
        if (matchNumber <= 0 || station.isBlank()) {
            return null;
        }
        String tournamentLevel = getStrOrDefault(obj, "tournamentLevel", "QUALIFICATION");
        int teamNumber = getIntOrDefault(obj, "teamNumber", 0);
        String scoutId = getStrOrDefault(obj, "scoutId", null);
        String scoutName = getStrOrDefault(obj, "scoutName", null);
        if (scoutId != null && scoutId.isBlank()) scoutId = null;
        if (scoutName != null && scoutName.isBlank()) scoutName = null;

        String rawId = getStrOrDefault(obj, "id", "");
        String id = !rawId.isBlank() ? rawId : eventId + "_" + tournamentLevel + "_" + matchNumber + "_" + station;
        return new ScoutAssignment(id, eventId, matchNumber, tournamentLevel, station, teamNumber, scoutId, scoutName);
    }

    private static int getIntOrDefault(JsonObject obj, String key, int fallback) {
        if (!obj.has(key) || obj.get(key).isJsonNull()) {
            return fallback;
        }
        JsonElement el = obj.get(key);
        if (!el.isJsonPrimitive()) {
            throw new io.javalin.http.BadRequestResponse("Invalid integer field: " + key);
        }
        try {
            return el.getAsInt();
        } catch (RuntimeException e) {
            throw new io.javalin.http.BadRequestResponse("Invalid integer field: " + key);
        }
    }

    private static boolean getBoolOrDefault(JsonObject obj, String key, boolean fallback) {
        if (!obj.has(key) || obj.get(key).isJsonNull()) {
            return fallback;
        }
        JsonElement el = obj.get(key);
        if (!el.isJsonPrimitive()) {
            throw new io.javalin.http.BadRequestResponse("Invalid boolean field: " + key);
        }
        if (el.getAsJsonPrimitive().isBoolean()) {
            return el.getAsBoolean();
        }
        if (el.getAsJsonPrimitive().isString()) {
            String raw = el.getAsString().trim().toLowerCase(java.util.Locale.ROOT);
            if ("true".equals(raw)) return true;
            if ("false".equals(raw)) return false;
        }
        throw new io.javalin.http.BadRequestResponse("Invalid boolean field: " + key);
    }

    private static String getStrOrDefault(JsonObject obj, String key, String fallback) {
        if (!obj.has(key) || obj.get(key).isJsonNull()) {
            return fallback;
        }
        JsonElement el = obj.get(key);
        if (!el.isJsonPrimitive()) {
            throw new io.javalin.http.BadRequestResponse("Invalid string field: " + key);
        }
        return el.getAsString();
    }
}
