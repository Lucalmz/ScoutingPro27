package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.model.OfficialTeam;
import com.bear27570.app.model.PitScoutingRecord;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.javalin.config.RoutesConfig;
import io.javalin.http.ForbiddenResponse;
import org.jdbi.v3.core.Jdbi;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.util.DbUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class PitScoutRoutes {

    private static final Logger logger = LoggerFactory.getLogger(PitScoutRoutes.class);
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
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
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
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            PitScoutingRecord record = gson.fromJson(ctx.body(), PitScoutingRecord.class);
            if (record == null) {
                ctx.status(400).result("Invalid PitScoutingRecord payload");
                return;
            }

            if (record.getId() == null || record.getId().isBlank()) {
                record.setId(UUID.randomUUID().toString());
            }
            if (record.getScoutId() == null || record.getScoutId().isBlank()) {
                record.setScoutId(userId);
            }
            record.setEventId(eventId);

            try {
                synchronized (DbUtil.RECORD_WRITE_LOCK) {
                    DbUtil.withDeadlockRetry(() -> {
                        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));
                    });
                }
            } catch (Exception e) {
                ctx.status(500).result("Save pit record failed: " + e.getMessage());
                return;
            }

            ctx.result(gson.toJson(Map.of("success", true, "record", record))).contentType("application/json");
        });

        // 3. 批量同步 Pit 侦察记录 (用于对账与重连持久化)
        routes.post("/api/events/{eventId}/pit-records/batch", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            Type listType = new TypeToken<List<PitScoutingRecord>>() {}.getType();
            List<PitScoutingRecord> records = gson.fromJson(ctx.body(), listType);
            if (records == null || records.isEmpty()) {
                ctx.result(gson.toJson(Map.of("success", true, "count", 0))).contentType("application/json");
                return;
            }

            records.sort(Comparator.comparing(r -> r.getId() != null ? r.getId() : ""));
            try {
                synchronized (DbUtil.RECORD_WRITE_LOCK) {
                    DbUtil.withDeadlockRetry(() -> {
                        jdbi.useTransaction(handle -> {
                            PitScoutDao dao = handle.attach(PitScoutDao.class);
                            for (PitScoutingRecord r : records) {
                                if (r.getId() == null || r.getId().isBlank()) {
                                    r.setId(UUID.randomUUID().toString());
                                }
                                if (r.getScoutId() == null || r.getScoutId().isBlank()) {
                                    r.setScoutId(userId);
                                }
                                r.setEventId(eventId);
                                dao.upsertPitRecord(r);
                            }
                        });
                    });
                }
            } catch (Exception e) {
                ctx.status(500).result("Batch pit sync failed: " + e.getMessage());
                return;
            }

            ctx.result(gson.toJson(Map.of("success", true, "count", records.size()))).contentType("application/json");
        });

        // 4. 批量保存 / 同步 FTC 官方参赛战队名录底册
        routes.post("/api/events/{eventId}/official-teams/sync", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            Type listType = new TypeToken<List<OfficialTeam>>() {}.getType();
            List<OfficialTeam> teams = gson.fromJson(ctx.body(), listType);
            if (teams == null || teams.isEmpty()) {
                ctx.result(gson.toJson(Map.of("success", true, "count", 0))).contentType("application/json");
                return;
            }

            teams.sort(Comparator.comparing(OfficialTeam::getTeamNumber));
            try {
                DbUtil.withDeadlockRetry(() -> {
                    jdbi.useTransaction(handle -> {
                        PitScoutDao dao = handle.attach(PitScoutDao.class);
                        for (OfficialTeam t : teams) {
                            t.setEventId(eventId);
                            dao.upsertOfficialTeam(t);
                        }
                    });
                });
            } catch (Exception e) {
                ctx.status(500).result("Official teams sync failed: " + e.getMessage());
                return;
            }

            ctx.result(gson.toJson(Map.of("success", true, "count", teams.size()))).contentType("application/json");
        });

        // 5. 单独获取官方参赛名录
        routes.get("/api/events/{eventId}/official-teams", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

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
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
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
            Path basePath = baseDir.toPath().toAbsolutePath().normalize();
            Path targetPath = targetFile.toPath().toAbsolutePath().normalize();
            // 路径穿越安全防护 (Path Traversal Guard)
            if (!targetPath.startsWith(basePath)) {
                ctx.status(400).result("Illegal path traversal detected");
                return;
            }

            try {
                // 原子写入：先写入临时文件，再原子重命名替换，防止损坏残留
                File tempFile = File.createTempFile("pit_", ".tmp", baseDir);
                Files.write(tempFile.toPath(), imageBytes);
                try {
                    Files.move(tempFile.toPath(), targetPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(tempFile.toPath(), targetPath, StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) {
                logger.error("Failed to write pit photo to disk: {}", e.getMessage(), e);
                ctx.status(500).result("Failed to save photo to disk");
                return;
            }

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
            Path basePath = baseDir.toPath().toAbsolutePath().normalize();
            Path targetPath = targetFile.toPath().toAbsolutePath().normalize();

            if (!targetPath.startsWith(basePath)) {
                ctx.status(400).result("Illegal path traversal detected");
                return;
            }

            if (!targetFile.exists() || !targetFile.isFile()) {
                ctx.status(404).result("Photo not found");
                return;
            }

            try {
                byte[] bytes = Files.readAllBytes(targetPath);
                ctx.contentType("image/webp");
                ctx.header("Cache-Control", "public, max-age=31536000, immutable");
                ctx.result(bytes);
            } catch (IOException e) {
                logger.error("Failed to read photo {}: {}", key, e.getMessage());
                ctx.status(500).result("Failed to read photo file");
            }
        });

        // 8. 删除废弃展位特写照片
        routes.delete("/api/events/{eventId}/pit/photos/{key}", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String key = ctx.pathParam("key");

            if (eventId.isBlank() || !eventId.matches("^[a-zA-Z0-9_\\-]+$") ||
                key.isBlank() || !key.matches("^[a-zA-Z0-9_\\-]+$")) {
                ctx.status(400).result("Invalid eventId or key");
                return;
            }

            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            File baseDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + eventId);
            File targetFile = new File(baseDir, key + ".webp");
            Path basePath = baseDir.toPath().toAbsolutePath().normalize();
            Path targetPath = targetFile.toPath().toAbsolutePath().normalize();

            if (!targetPath.startsWith(basePath)) {
                ctx.status(400).result("Illegal path traversal detected");
                return;
            }

            if (targetFile.exists() && targetFile.isFile()) {
                try {
                    Files.delete(targetPath);
                } catch (IOException e) {
                    logger.error("Failed to delete photo {}: {}", key, e.getMessage());
                    ctx.status(500).result("Failed to delete photo file");
                    return;
                }
            }
            ctx.status(200).result(gson.toJson(Map.of("success", true, "key", key))).contentType("application/json");
        });
    }
}
