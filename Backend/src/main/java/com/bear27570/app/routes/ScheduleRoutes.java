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
            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                ctx.status(404).result("Event not found");
                return;
            }

            JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
            if (body == null || !body.has("items") || !body.get("items").isJsonArray()) {
                ctx.status(400).result("items array required");
                return;
            }

            boolean replace = body.has("replace") && body.get("replace").getAsBoolean();
            JsonArray itemsArray = body.getAsJsonArray("items");
            List<MatchScheduleItem> items = new ArrayList<>();

            for (JsonElement el : itemsArray) {
                if (!el.isJsonObject()) continue;
                JsonObject obj = el.getAsJsonObject();
                int matchNumber = obj.has("matchNumber") ? obj.get("matchNumber").getAsInt() : 0;
                if (matchNumber <= 0) continue;

                String tournamentLevel = obj.has("tournamentLevel") && !obj.get("tournamentLevel").isJsonNull()
                        ? obj.get("tournamentLevel").getAsString()
                        : "QUALIFICATION";
                int red1 = obj.has("red1") ? obj.get("red1").getAsInt() : 0;
                int red2 = obj.has("red2") ? obj.get("red2").getAsInt() : 0;
                int blue1 = obj.has("blue1") ? obj.get("blue1").getAsInt() : 0;
                int blue2 = obj.has("blue2") ? obj.get("blue2").getAsInt() : 0;

                String id = obj.has("id") && !obj.get("id").isJsonNull() && !obj.get("id").getAsString().isBlank()
                        ? obj.get("id").getAsString()
                        : UUID.randomUUID().toString();

                items.add(new MatchScheduleItem(id, eventId, matchNumber, tournamentLevel, red1, red2, blue1, blue2));
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
            });

            ctx.status(200).result(gson.toJson(Map.of("success", true, "count", items.size()))).contentType("application/json");
        });

        // 3. 清空赛程与排班
        routes.delete("/api/events/{id}/schedule", ctx -> {
            String eventId = ctx.pathParam("id");
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
            JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
            if (body == null || !body.has("assignments") || !body.get("assignments").isJsonArray()) {
                ctx.status(400).result("assignments array required");
                return;
            }

            JsonArray arr = body.getAsJsonArray("assignments");
            List<ScoutAssignment> list = new ArrayList<>();

            for (JsonElement el : arr) {
                if (!el.isJsonObject()) continue;
                JsonObject obj = el.getAsJsonObject();
                int matchNumber = obj.has("matchNumber") ? obj.get("matchNumber").getAsInt() : 0;
                String station = obj.has("station") ? obj.get("station").getAsString() : "";
                if (matchNumber <= 0 || station.isBlank()) continue;

                String tournamentLevel = obj.has("tournamentLevel") && !obj.get("tournamentLevel").isJsonNull()
                        ? obj.get("tournamentLevel").getAsString()
                        : "QUALIFICATION";
                int teamNumber = obj.has("teamNumber") ? obj.get("teamNumber").getAsInt() : 0;
                String scoutId = obj.has("scoutId") && !obj.get("scoutId").isJsonNull() ? obj.get("scoutId").getAsString() : null;
                String scoutName = obj.has("scoutName") && !obj.get("scoutName").isJsonNull() ? obj.get("scoutName").getAsString() : null;
                if (scoutId != null && scoutId.isBlank()) scoutId = null;
                if (scoutName != null && scoutName.isBlank()) scoutName = null;

                String id = obj.has("id") && !obj.get("id").isJsonNull() && !obj.get("id").getAsString().isBlank()
                        ? obj.get("id").getAsString()
                        : eventId + "_" + matchNumber + "_" + station;

                list.add(new ScoutAssignment(id, eventId, matchNumber, tournamentLevel, station, teamNumber, scoutId, scoutName));
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
        String id = eventId + "_" + matchNumber + "_" + station;
        // 初始工位保持 scoutId 和 scoutName 为 null（永远支持留空）
        ScoutAssignment a = new ScoutAssignment(id, eventId, matchNumber, level, station, teamNumber, null, null);
        dao.upsertAssignment(a);
    }
}
