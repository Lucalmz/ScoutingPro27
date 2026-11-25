package com.bear27570.app.routes;

import com.bear27570.app.dao.CustomFieldDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.model.CustomFieldDefinition;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.util.FormulaValidator;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.NotFoundResponse;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.*;

public class CustomFieldRoutes {

    private static final Logger logger = LoggerFactory.getLogger(CustomFieldRoutes.class);
    private static final int MAX_DESCRIPTION_LENGTH = 300;
    private static final int MAX_CONFIG_JSON_BYTES = 8192;

    private final Jdbi jdbi;
    private final Gson gson;

    private static final Set<String> ALLOWED_TARGETS = Set.of("MATCH", "PIT", "TEAM");
    private static final Set<String> ALLOWED_TYPES = Set.of(
            "boolean", "number", "timer", "level", "select", "multi_select", "text", "formula"
    );
    private static final Set<String> ALLOWED_PHASES = Set.of(
            "auto", "teleop", "endgame", "overall", "hardware", "strategy"
    );
    private static final Set<String> ALLOWED_AGGREGATIONS = Set.of(
            "avg", "median", "max", "min", "sum", "last3", "trimmed_avg", "stddev", "rate"
    );
    private static final Set<String> ALLOWED_FORMATS = Set.of(
            "number", "integer", "percent", "boolean", "tier"
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

            // Target 校验 (MATCH / PIT / TEAM)
            String target = incoming.getTarget() != null ? incoming.getTarget().trim().toUpperCase(Locale.ROOT) : "MATCH";
            if (!ALLOWED_TARGETS.contains(target)) {
                ctx.status(400).result("Invalid target: must be 'MATCH', 'PIT', or 'TEAM'");
                return;
            }
            incoming.setTarget(target);

            // Phase 校验
            String phase = incoming.getPhase() != null ? incoming.getPhase().trim().toLowerCase(Locale.ROOT) : "overall";
            if (!ALLOWED_PHASES.contains(phase)) {
                phase = "overall";
            }
            incoming.setPhase(phase);

            // Field Type 校验
            String type = incoming.getFieldType() != null ? incoming.getFieldType().trim().toLowerCase(Locale.ROOT) : "text";
            if (!ALLOWED_TYPES.contains(type)) {
                ctx.status(400).result("Invalid fieldType: " + type);
                return;
            }
            if ("TEAM".equals(target) && !"formula".equals(type)) {
                ctx.status(400).result("TEAM custom fields must have fieldType 'formula'");
                return;
            }
            incoming.setFieldType(type);

            // Field Key 处理
            String rawKey = incoming.getFieldKey();
            if (rawKey == null || rawKey.trim().isEmpty()) {
                rawKey = "field_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
            } else {
                rawKey = rawKey.trim().toLowerCase(Locale.ROOT);
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

            if (!validateAndNormalizeExtendedFields(incoming, eventId, ctx)) {
                return;
            }

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

            if (incoming.getName() != null) {
                String trimmedName = incoming.getName().trim();
                if (trimmedName.isEmpty()) {
                    ctx.status(400).result("Field name is required");
                    return;
                }
                if (trimmedName.length() > 100) {
                    ctx.status(400).result("Field name cannot exceed 100 characters");
                    return;
                }
                existing.setName(trimmedName);
            }
            if (incoming.getPhase() != null && ALLOWED_PHASES.contains(incoming.getPhase().trim().toLowerCase(Locale.ROOT))) {
                existing.setPhase(incoming.getPhase().trim().toLowerCase(Locale.ROOT));
            }
            if (incoming.getFieldType() != null) {
                String type = incoming.getFieldType().trim().toLowerCase(Locale.ROOT);
                if (!ALLOWED_TYPES.contains(type)) {
                    ctx.status(400).result("Invalid fieldType: " + type);
                    return;
                }
                existing.setFieldType(type);
            }
            if ("TEAM".equals(existing.getTarget()) && !"formula".equals(existing.getFieldType())) {
                ctx.status(400).result("TEAM custom fields must have fieldType 'formula'");
                return;
            }

            existing.setRequired(incoming.isRequired());
            existing.setDefaultVal(incoming.getDefaultVal());
            existing.setOptionsJson(incoming.getOptionsJson());
            existing.setMinVal(incoming.getMinVal());
            existing.setMaxVal(incoming.getMaxVal());
            existing.setStepVal(incoming.getStepVal());
            existing.setUnit(incoming.getUnit());
            existing.setDescription(incoming.getDescription());
            existing.setConfigJson(incoming.getConfigJson());
            existing.setFormulaExpr(incoming.getFormulaExpr());
            existing.setAggregationMode(incoming.getAggregationMode());
            existing.setDisplayFormat(incoming.getDisplayFormat());

            if (incoming.getOrderSeq() > 0) {
                existing.setOrderSeq(incoming.getOrderSeq());
            }
            existing.setIsActive(incoming.isActive());

            if (!validateAndNormalizeExtendedFields(existing, eventId, ctx)) {
                return;
            }

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

    private boolean validateAndNormalizeExtendedFields(CustomFieldDefinition def, String eventId, Context ctx) {
        if (def.getDescription() != null) {
            String desc = def.getDescription().trim();
            if (desc.length() > MAX_DESCRIPTION_LENGTH) {
                ctx.status(400).result("Description cannot exceed " + MAX_DESCRIPTION_LENGTH + " characters");
                return false;
            }
            def.setDescription(desc.isEmpty() ? null : desc);
        }

        if (def.getConfigJson() != null) {
            String cfg = def.getConfigJson().trim();
            if (cfg.isEmpty()) {
                def.setConfigJson(null);
            } else {
                if (cfg.getBytes(StandardCharsets.UTF_8).length > MAX_CONFIG_JSON_BYTES) {
                    ctx.status(400).result("configJson cannot exceed " + MAX_CONFIG_JSON_BYTES + " bytes");
                    return false;
                }
                try {
                    JsonElement parsed = JsonParser.parseString(cfg);
                    if (!parsed.isJsonObject()) {
                        ctx.status(400).result("configJson must be a valid JSON object");
                        return false;
                    }
                } catch (Exception e) {
                    ctx.status(400).result("configJson must be a valid JSON object");
                    return false;
                }
                def.setConfigJson(cfg);
            }
        }

        String aggMode = def.getAggregationMode() != null ? def.getAggregationMode().trim().toLowerCase(Locale.ROOT) : "avg";
        if (aggMode.isEmpty()) {
            aggMode = "avg";
        }
        if (!ALLOWED_AGGREGATIONS.contains(aggMode)) {
            ctx.status(400).result("Invalid aggregationMode: " + aggMode);
            return false;
        }
        def.setAggregationMode(aggMode);

        String dispFormat = def.getDisplayFormat() != null ? def.getDisplayFormat().trim().toLowerCase(Locale.ROOT) : "number";
        if (dispFormat.isEmpty()) {
            dispFormat = "number";
        }
        if (!ALLOWED_FORMATS.contains(dispFormat)) {
            ctx.status(400).result("Invalid displayFormat: " + dispFormat);
            return false;
        }
        def.setDisplayFormat(dispFormat);

        if ("formula".equals(def.getFieldType())) {
            List<CustomFieldDefinition> eventFields = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findByEvent(eventId));
            FormulaValidator.ValidationResult valRes = FormulaValidator.validateWithGraph(def, eventFields);
            if (!valRes.isValid()) {
                ctx.status(400)
                        .result(gson.toJson(valRes.toErrorResponseMap()))
                        .contentType("application/json");
                return false;
            }
            def.setDependenciesJson(gson.toJson(valRes.getDependencies()));
        } else {
            def.setFormulaExpr(null);
            def.setDependenciesJson(null);
        }

        return true;
    }
}
