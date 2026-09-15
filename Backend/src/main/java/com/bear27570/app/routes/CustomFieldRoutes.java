package com.bear27570.app.routes;

import com.bear27570.app.dao.CustomFieldDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.model.CustomFieldDefinition;
import com.bear27570.app.model.ScoutingEvent;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.NotFoundResponse;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class CustomFieldRoutes {

    private static final Logger logger = LoggerFactory.getLogger(CustomFieldRoutes.class);
    private final Jdbi jdbi;
    private final Gson gson;

    private static final Set<String> ALLOWED_TARGETS = Set.of("MATCH", "PIT");
    private static final Set<String> ALLOWED_TYPES = Set.of(
            "boolean", "number", "level", "select", "multi_select", "text"
    );
    private static final Set<String> ALLOWED_PHASES = Set.of(
            "auto", "teleop", "endgame", "overall", "hardware", "strategy"
    );

    public CustomFieldRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        // 1. 查询赛事所有自定义字段 (成员可查)
        routes.get("/api/events/{eventId}/custom-fields", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String userId = ctx.attribute("userId");

            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new ForbiddenResponse("Not a member of this event");
            }

            List<CustomFieldDefinition> fields = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findByEvent(eventId));
            ctx.result(gson.toJson(fields)).contentType("application/json");
        });

        // 2. 新增自定义字段 (仅 Host 可操作)
        routes.post("/api/events/{eventId}/custom-fields", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String userId = ctx.attribute("userId");

            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new NotFoundResponse("Event not found");
            }
            if (!userId.equals(event.getHostId())) {
                throw new ForbiddenResponse("Only event host can manage custom fields");
            }

            CustomFieldDefinition incoming = gson.fromJson(ctx.body(), CustomFieldDefinition.class);
            if (incoming == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }

            if (incoming.getName() == null || incoming.getName().trim().isEmpty()) {
                ctx.status(400).result("Field name is required");
                return;
            }
            incoming.setName(incoming.getName().trim());
            if (incoming.getName().length() > 100) {
                ctx.status(400).result("Field name cannot exceed 100 characters");
                return;
            }

            // Target 校验 (MATCH / PIT)
            String target = incoming.getTarget() != null ? incoming.getTarget().trim().toUpperCase() : "MATCH";
            if (!ALLOWED_TARGETS.contains(target)) {
                ctx.status(400).result("Invalid target: must be 'MATCH' or 'PIT'");
                return;
            }
            incoming.setTarget(target);

            // Phase 校验
            String phase = incoming.getPhase() != null ? incoming.getPhase().trim().toLowerCase() : "overall";
            if (!ALLOWED_PHASES.contains(phase)) {
                phase = "overall";
            }
            incoming.setPhase(phase);

            // Field Type 校验
            String type = incoming.getFieldType() != null ? incoming.getFieldType().trim().toLowerCase() : "text";
            if (!ALLOWED_TYPES.contains(type)) {
                ctx.status(400).result("Invalid fieldType: " + type);
                return;
            }
            incoming.setFieldType(type);

            // Field Key 处理
            String rawKey = incoming.getFieldKey();
            if (rawKey == null || rawKey.trim().isEmpty()) {
                // 默认生成 field_uuid
                rawKey = "field_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
            } else {
                rawKey = rawKey.trim().toLowerCase();
            }

            if (!rawKey.matches("^[a-z0-9_]{1,100}$")) {
                ctx.status(400).result("Field key must contain only letters, numbers, and underscores (max 100 chars)");
                return;
            }
            incoming.setFieldKey(rawKey);

            // 唯一性检查
            final String finalKey = rawKey;
            CustomFieldDefinition existing = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findByKey(eventId, target, finalKey));
            if (existing != null) {
                ctx.status(400).result("Field key '" + finalKey + "' already exists for target " + target);
                return;
            }

            if (incoming.getId() == null || incoming.getId().trim().isEmpty()) {
                incoming.setId(UUID.randomUUID().toString());
            }
            incoming.setEventId(eventId);

            // 计算 orderSeq
            int maxSeq = jdbi.withExtension(CustomFieldDao.class, dao -> dao.getMaxOrderSeq(eventId, target));
            if (incoming.getOrderSeq() <= 0) {
                incoming.setOrderSeq(maxSeq + 1);
            }

            jdbi.useExtension(CustomFieldDao.class, dao -> dao.insert(incoming));
            ctx.status(201).result(gson.toJson(incoming)).contentType("application/json");
        });

        // 3. 修改自定义字段 (仅 Host 可操作)
        routes.put("/api/events/{eventId}/custom-fields/{id}", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String id = ctx.pathParam("id");
            String userId = ctx.attribute("userId");

            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new NotFoundResponse("Event not found");
            }
            if (!userId.equals(event.getHostId())) {
                throw new ForbiddenResponse("Only event host can manage custom fields");
            }

            CustomFieldDefinition existing = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findById(id));
            if (existing == null || !eventId.equals(existing.getEventId())) {
                throw new NotFoundResponse("Custom field not found");
            }

            CustomFieldDefinition incoming = gson.fromJson(ctx.body(), CustomFieldDefinition.class);
            if (incoming == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }

            if (incoming.getName() != null && !incoming.getName().trim().isEmpty()) {
                existing.setName(incoming.getName().trim());
            }
            if (incoming.getPhase() != null && ALLOWED_PHASES.contains(incoming.getPhase().trim().toLowerCase())) {
                existing.setPhase(incoming.getPhase().trim().toLowerCase());
            }
            if (incoming.getFieldType() != null && ALLOWED_TYPES.contains(incoming.getFieldType().trim().toLowerCase())) {
                existing.setFieldType(incoming.getFieldType().trim().toLowerCase());
            }
            existing.setRequired(incoming.isRequired());
            existing.setDefaultVal(incoming.getDefaultVal());
            existing.setOptionsJson(incoming.getOptionsJson());
            existing.setMinVal(incoming.getMinVal());
            existing.setMaxVal(incoming.getMaxVal());
            existing.setStepVal(incoming.getStepVal());
            existing.setUnit(incoming.getUnit());
            if (incoming.getOrderSeq() > 0) {
                existing.setOrderSeq(incoming.getOrderSeq());
            }
            existing.setIsActive(incoming.isActive());

            jdbi.useExtension(CustomFieldDao.class, dao -> dao.update(existing));
            ctx.result(gson.toJson(existing)).contentType("application/json");
        });

        // 4. 删除自定义字段 (仅 Host 可操作)
        routes.delete("/api/events/{eventId}/custom-fields/{id}", ctx -> {
            String eventId = ctx.pathParam("eventId");
            String id = ctx.pathParam("id");
            String userId = ctx.attribute("userId");

            ScoutingEvent event = jdbi.withExtension(EventDao.class, dao -> dao.findById(eventId));
            if (event == null) {
                throw new NotFoundResponse("Event not found");
            }
            if (!userId.equals(event.getHostId())) {
                throw new ForbiddenResponse("Only event host can manage custom fields");
            }

            CustomFieldDefinition existing = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findById(id));
            if (existing == null || !eventId.equals(existing.getEventId())) {
                throw new NotFoundResponse("Custom field not found");
            }

            jdbi.useExtension(CustomFieldDao.class, dao -> dao.delete(id));
            ctx.result(gson.toJson(Map.of("success", true, "id", id))).contentType("application/json");
        });
    }
}
