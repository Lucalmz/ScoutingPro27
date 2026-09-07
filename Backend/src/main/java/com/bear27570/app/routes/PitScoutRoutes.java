package com.bear27570.app.routes;

import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.model.OfficialTeam;
import com.bear27570.app.model.PitScoutingRecord;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import com.bear27570.app.db.AppConfig;

import java.io.File;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class PitScoutRoutes {

    private final Jdbi jdbi;
    private final Gson gson;

    public PitScoutRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        // 1. 获取赛事全部 Pit 侦察记录与官方战队名录底册
        routes.get("/api/events/{eventId}/pit-records", ctx -> {
            String eventId = ctx.pathParam("eventId");
            if (eventId.isBlank()) {
                ctx.status(400).result("Invalid eventId");
                return;
            }

            Map<String, Object> result = jdbi.withExtension(PitScoutDao.class, dao -> {
                List<PitScoutingRecord> records = dao.findActivePitRecordsByEvent(eventId);
                List<OfficialTeam> officialTeams = dao.findOfficialTeamsByEvent(eventId);
                return Map.of("records", records, "officialTeams", officialTeams);
            });

            ctx.result(gson.toJson(result)).contentType("application/json");
        });

        // 2. 提交 / 更新单条 Pit 侦察记录
        routes.post("/api/events/{eventId}/pit-records", ctx -> {
            String eventId = ctx.pathParam("eventId");
            PitScoutingRecord record = gson.fromJson(ctx.body(), PitScoutingRecord.class);
            if (record == null) {
                ctx.status(400).result("Invalid PitScoutingRecord payload");
                return;
            }

            if (record.getId() == null || record.getId().isBlank()) {
                record.setId(UUID.randomUUID().toString());
            }
            record.setEventId(eventId);

            jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

            ctx.result(gson.toJson(Map.of("success", true, "record", record))).contentType("application/json");
        });

        // 3. 批量同步 Pit 侦察记录 (用于对账与重连持久化)
        routes.post("/api/events/{eventId}/pit-records/batch", ctx -> {
            String eventId = ctx.pathParam("eventId");
            Type listType = new TypeToken<List<PitScoutingRecord>>() {}.getType();
            List<PitScoutingRecord> records = gson.fromJson(ctx.body(), listType);
            if (records == null || records.isEmpty()) {
                ctx.result(gson.toJson(Map.of("success", true, "count", 0))).contentType("application/json");
                return;
            }

            jdbi.useTransaction(handle -> {
                PitScoutDao dao = handle.attach(PitScoutDao.class);
                for (PitScoutingRecord r : records) {
                    if (r.getId() == null || r.getId().isBlank()) {
                        r.setId(UUID.randomUUID().toString());
                    }
                    r.setEventId(eventId);
                    dao.upsertPitRecord(r);
                }
            });

            ctx.result(gson.toJson(Map.of("success", true, "count", records.size()))).contentType("application/json");
        });

        // 4. 批量保存 / 同步 FTC 官方参赛战队名录底册
        routes.post("/api/events/{eventId}/official-teams/sync", ctx -> {
            String eventId = ctx.pathParam("eventId");
            Type listType = new TypeToken<List<OfficialTeam>>() {}.getType();
            List<OfficialTeam> teams = gson.fromJson(ctx.body(), listType);
            if (teams == null || teams.isEmpty()) {
                ctx.result(gson.toJson(Map.of("success", true, "count", 0))).contentType("application/json");
                return;
            }

            jdbi.useTransaction(handle -> {
                PitScoutDao dao = handle.attach(PitScoutDao.class);
                for (OfficialTeam t : teams) {
                    t.setEventId(eventId);
                    dao.upsertOfficialTeam(t);
                }
            });

            ctx.result(gson.toJson(Map.of("success", true, "count", teams.size()))).contentType("application/json");
        });

        // 5. 单独获取官方参赛名录
        routes.get("/api/events/{eventId}/official-teams", ctx -> {
            String eventId = ctx.pathParam("eventId");
            List<OfficialTeam> teams = jdbi.withExtension(PitScoutDao.class, dao -> dao.findOfficialTeamsByEvent(eventId));
            ctx.result(gson.toJson(teams)).contentType("application/json");
        });

        // 6. 上传展位实物特写高保真压缩图片 (WebP) 并持久化至电脑本地磁盘
        routes.post("/api/events/{eventId}/pit/photos", ctx -> {
            String eventId = ctx.pathParam("eventId");
            if (eventId.isBlank() || !eventId.matches("^[a-zA-Z0-9_\\-]+$")) {
                ctx.status(400).result("Invalid eventId");
                return;
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON payload");
                return;
            }

            String key = ApiRoutes.asString(body.get("key"));
            String dataUrl = ApiRoutes.asString(body.get("dataUrl"));

            if (key == null || key.isBlank() || !key.matches("^[a-zA-Z0-9_\\-]+$")) {
                ctx.status(400).result("Invalid photo key");
                return;
            }
            if (dataUrl == null || dataUrl.isBlank()) {
                ctx.status(400).result("Missing photo data");
                return;
            }

            String base64Content = dataUrl;
            int commaIdx = dataUrl.indexOf(',');
            if (commaIdx >= 0) {
                base64Content = dataUrl.substring(commaIdx + 1);
            }

            byte[] imageBytes;
            try {
                imageBytes = Base64.getDecoder().decode(base64Content.trim());
            } catch (IllegalArgumentException e) {
                ctx.status(400).result("Invalid base64 encoding");
                return;
            }

            File baseDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + eventId);
            if (!baseDir.exists()) {
                baseDir.mkdirs();
            }

            File targetFile = new File(baseDir, key + ".webp");
            // 路径穿越安全防护 (Path Traversal Guard)
            if (!targetFile.getCanonicalPath().startsWith(baseDir.getCanonicalPath())) {
                ctx.status(400).result("Illegal path traversal detected");
                return;
            }

            Files.write(targetFile.toPath(), imageBytes);

            ctx.result(gson.toJson(Map.of(
                    "success", true,
                    "key", key,
                    "url", "/api/events/" + eventId + "/pit/photos/" + key
            ))).contentType("application/json");
        });

        // 7. 流式读取磁盘展位特写图片 (支持原生 <img> 标签与强缓存)
        routes.get("/api/events/{eventId}/pit/photos/{key}", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String key = ctx.pathParam("key");

            if (eventId.isBlank() || !eventId.matches("^[a-zA-Z0-9_\\-]+$") ||
                key.isBlank() || !key.matches("^[a-zA-Z0-9_\\-]+$")) {
                ctx.status(400).result("Invalid eventId or key");
                return;
            }

            File baseDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + eventId);
            File targetFile = new File(baseDir, key + ".webp");

            if (!targetFile.getCanonicalPath().startsWith(baseDir.getCanonicalPath())) {
                ctx.status(400).result("Illegal path traversal detected");
                return;
            }

            if (!targetFile.exists() || !targetFile.isFile()) {
                ctx.status(404).result("Photo not found");
                return;
            }

            byte[] bytes = Files.readAllBytes(targetFile.toPath());
            ctx.contentType("image/webp");
            ctx.header("Cache-Control", "public, max-age=31536000, immutable");
            ctx.result(bytes);
        });
    }
}
