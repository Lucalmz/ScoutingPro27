package com.bear27570.app.service;

import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.util.DbUtil;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jdbi.v3.core.Handle;
import org.jdbi.v3.core.Jdbi;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * Persists TinyBase MergeableStore snapshots (`event_crdt_state`) and performs
 * transactional, incremental dirty-row projection into relational H2 tables
 * (`pit_scouting_records`, `team_tags`, `event_custom_fields`, `match_schedules`,
 * `scout_assignments`, `scouting_records`).
 */
public class CrdtProjectionService {

    public record LoadResult(
            boolean exists,
            String eventId,
            int hostEpoch,
            long snapshotRevision,
            JsonElement snapshot,
            String updatedAt
    ) {}

    public record SaveResult(
            boolean saved,
            boolean stale,
            String reason,
            String eventId,
            int hostEpoch,
            long snapshotRevision,
            Map<String, Integer> projectedCounts
    ) {}

    private record ExistingStateMeta(int hostEpoch, long snapshotRevision) {}

    private final Jdbi jdbi;
    private final Gson gson;

    public CrdtProjectionService(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    /**
     * Idempotently ensures CRDT snapshot & signature columns exist when upgrading
     * an existing local development H2 database whose Flyway history recorded prior V8.
     */
    public static void ensureCrdtSchema(Jdbi jdbi) {
        jdbi.useHandle(handle -> {
            handle.execute("ALTER TABLE events ADD COLUMN IF NOT EXISTS turn_config_encrypted TEXT");
            handle.execute("""
                    CREATE TABLE IF NOT EXISTS event_crdt_state (
                        event_id           VARCHAR(2048) PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                        host_epoch         INT           NOT NULL DEFAULT 1,
                        snapshot_revision  BIGINT        NOT NULL DEFAULT 0,
                        crdt_snapshot_json CLOB          NOT NULL,
                        updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
                    )
                    """);
            handle.execute("ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_pub_key VARCHAR(256)");
            handle.execute("ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_sig     VARCHAR(256)");
            handle.execute("ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS host_sig       VARCHAR(256)");
        });
    }

    public LoadResult loadState(String eventId) {
        return jdbi.withHandle(handle -> handle.createQuery(
                        "SELECT host_epoch, snapshot_revision, crdt_snapshot_json, updated_at " +
                        "FROM event_crdt_state WHERE event_id = :eventId")
                .bind("eventId", eventId)
                .map((rs, ctx) -> {
                    String json = rs.getString("crdt_snapshot_json");
                    JsonElement parsed = (json != null && !json.isBlank()) ? JsonParser.parseString(json) : null;
                    return new LoadResult(
                            true,
                            eventId,
                            rs.getInt("host_epoch"),
                            rs.getLong("snapshot_revision"),
                            parsed,
                            rs.getString("updated_at")
                    );
                })
                .findFirst()
                .orElse(new LoadResult(false, eventId, 1, 0L, null, null)));
    }

    public SaveResult saveAndProject(
            String eventId,
            int hostEpoch,
            long snapshotRevision,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean fullProjection
    ) throws Exception {
        return saveAndProject(eventId, null, true, hostEpoch, snapshotRevision, snapshotEl, dirtyRows, fullProjection);
    }

    public SaveResult saveAndProject(
            String eventId,
            String callerUserId,
            boolean isHost,
            int hostEpoch,
            long snapshotRevision,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean fullProjection
    ) throws Exception {
        if (snapshotEl == null || !snapshotEl.isJsonArray()) {
            throw new IllegalArgumentException("CRDT snapshot must be a TinyBase MergeableContent JSON array");
        }
        final String snapshotJson = gson.toJson(snapshotEl);

        synchronized (DbUtil.RECORD_WRITE_LOCK) {
            return DbUtil.withDeadlockRetry(() -> jdbi.inTransaction(handle -> {
                ExistingStateMeta existing = handle.createQuery(
                                "SELECT host_epoch, snapshot_revision FROM event_crdt_state WHERE event_id = :eventId")
                        .bind("eventId", eventId)
                        .map((rs, ctx) -> new ExistingStateMeta(
                                rs.getInt("host_epoch"),
                                rs.getLong("snapshot_revision")
                        ))
                        .findFirst()
                        .orElse(null);

                int requestedEpoch = Math.max(1, hostEpoch);
                if (existing != null) {
                    if (requestedEpoch < existing.hostEpoch()) {
                        return new SaveResult(
                                false,
                                true,
                                "stale_epoch",
                                eventId,
                                existing.hostEpoch(),
                                existing.snapshotRevision(),
                                Map.of()
                        );
                    }
                    if (requestedEpoch == existing.hostEpoch()
                            && snapshotRevision > 0
                            && snapshotRevision < existing.snapshotRevision()) {
                        return new SaveResult(
                                false,
                                true,
                                "stale_revision",
                                eventId,
                                existing.hostEpoch(),
                                existing.snapshotRevision(),
                                Map.of()
                        );
                    }
                }

                int effectiveEpoch = existing != null ? Math.max(requestedEpoch, existing.hostEpoch()) : requestedEpoch;
                long effectiveRev;
                if (existing != null && requestedEpoch > existing.hostEpoch()) {
                    effectiveRev = Math.max(snapshotRevision, existing.snapshotRevision() + 1);
                } else if (existing != null) {
                    effectiveRev = Math.max(snapshotRevision, existing.snapshotRevision());
                } else {
                    effectiveRev = Math.max(1L, snapshotRevision);
                }

                boolean noDirtyMap = dirtyRows == null || dirtyRows.isEmpty();
                boolean projectAll = fullProjection || (existing == null && noDirtyMap);

                // Validate and project scouting_records before overwriting event_crdt_state so
                // key-binding verification reads previously persisted trusted state.
                int projectedScoutingCount = projectScoutingRecords(
                        handle, eventId, callerUserId, isHost, snapshotEl, dirtyRows, projectAll);

                handle.createUpdate("""
                        MERGE INTO event_crdt_state (event_id, host_epoch, snapshot_revision, crdt_snapshot_json, updated_at)
                        KEY (event_id)
                        VALUES (:eventId, :hostEpoch, :snapshotRevision, :snapshotJson, CURRENT_TIMESTAMP)
                        """)
                        .bind("eventId", eventId)
                        .bind("hostEpoch", effectiveEpoch)
                        .bind("snapshotRevision", effectiveRev)
                        .bind("snapshotJson", snapshotJson)
                        .execute();

                Map<String, Integer> counts = new LinkedHashMap<>();
                counts.put("pit_records", projectPitAndPhotos(handle, eventId, snapshotEl, dirtyRows, projectAll));
                counts.put("team_tags", projectTeamTags(handle, eventId, snapshotEl, dirtyRows, projectAll));
                counts.put("custom_fields", projectCustomFields(handle, eventId, snapshotEl, dirtyRows, projectAll));
                counts.put("schedules", projectSchedules(handle, eventId, snapshotEl, dirtyRows, projectAll));
                counts.put("assignments", projectAssignments(handle, eventId, snapshotEl, dirtyRows, projectAll));
                counts.put("scouting_records", projectedScoutingCount);

                return new SaveResult(true, false, null, eventId, effectiveEpoch, effectiveRev, counts);
            }));
        }
    }

    /**
     * Unwraps TinyBase MergeableContent JSON for a given tableId into plain { rowId -> { cellId: primitive } }.
     * TinyBase format: [ [ { tableId: [ { rowId: [ { cellId: [val, hlc?, hash?] }, ... ] }, ... ] }, ... ], values ]
     */
    public static Map<String, JsonObject> extractTableRows(JsonElement snapshotEl, String tableId) {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        if (snapshotEl == null || !snapshotEl.isJsonArray()) return out;
        JsonArray root = snapshotEl.getAsJsonArray();
        if (root.size() < 1 || !root.get(0).isJsonArray()) return out;

        JsonArray tablesStamp = root.get(0).getAsJsonArray();
        if (tablesStamp.size() < 1 || !tablesStamp.get(0).isJsonObject()) return out;

        JsonObject tablesObj = tablesStamp.get(0).getAsJsonObject();
        JsonElement tableEl = tablesObj.get(tableId);
        if (tableEl == null || !tableEl.isJsonArray()) return out;

        JsonArray tableStamp = tableEl.getAsJsonArray();
        if (tableStamp.size() < 1 || !tableStamp.get(0).isJsonObject()) return out;

        JsonObject rowsObj = tableStamp.get(0).getAsJsonObject();
        for (Map.Entry<String, JsonElement> rowEntry : rowsObj.entrySet()) {
            if (!rowEntry.getValue().isJsonArray()) continue;
            JsonArray rowStamp = rowEntry.getValue().getAsJsonArray();
            if (rowStamp.size() < 1 || !rowStamp.get(0).isJsonObject()) continue;

            JsonObject cellsRaw = rowStamp.get(0).getAsJsonObject();
            JsonObject plainRow = new JsonObject();
            for (Map.Entry<String, JsonElement> cellEntry : cellsRaw.entrySet()) {
                JsonElement cellValEl = cellEntry.getValue();
                if (cellValEl != null && cellValEl.isJsonArray()) {
                    JsonArray cellStamp = cellValEl.getAsJsonArray();
                    if (cellStamp.size() >= 1 && !cellStamp.get(0).isJsonNull()) {
                        plainRow.add(cellEntry.getKey(), cellStamp.get(0));
                    }
                } else if (cellValEl != null && cellValEl.isJsonPrimitive()) {
                    plainRow.add(cellEntry.getKey(), cellValEl);
                }
            }
            out.put(rowEntry.getKey(), plainRow);
        }
        return out;
    }

    private int projectPitAndPhotos(
            Handle handle,
            String eventId,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> pitRows = extractTableRows(snapshotEl, "pit_records");
        Map<String, JsonObject> photoRows = extractTableRows(snapshotEl, "pit_photo_keys");

        Map<Integer, TreeSet<String>> activePhotoKeysByTeam = new HashMap<>();
        for (Map.Entry<String, JsonObject> entry : photoRows.entrySet()) {
            JsonObject row = entry.getValue();
            if (!getBool(row, "active", false)) continue;
            int teamNum = getInt(row, "teamNumber", parseTeamPrefix(entry.getKey()));
            String photoKey = getStr(row, "photoKey", "");
            if (teamNum > 0 && !photoKey.isEmpty()) {
                activePhotoKeysByTeam.computeIfAbsent(teamNum, k -> new TreeSet<>()).add(photoKey);
            }
        }

        Set<Integer> targetTeams = new LinkedHashSet<>();
        if (projectAll) {
            for (Map.Entry<String, JsonObject> entry : pitRows.entrySet()) {
                int teamNum = getInt(entry.getValue(), "teamNumber", parseIntSafe(entry.getKey(), 0));
                if (teamNum > 0) targetTeams.add(teamNum);
            }
            for (Integer teamNum : activePhotoKeysByTeam.keySet()) {
                if (teamNum > 0) targetTeams.add(teamNum);
            }
        } else if (dirtyRows != null) {
            List<String> dirtyPitIds = dirtyRows.get("pit_records");
            if (dirtyPitIds != null) {
                for (String rid : dirtyPitIds) {
                    JsonObject row = pitRows.get(rid);
                    int teamNum = row != null ? getInt(row, "teamNumber", parseIntSafe(rid, 0)) : parseIntSafe(rid, 0);
                    if (teamNum > 0) targetTeams.add(teamNum);
                }
            }
            List<String> dirtyPhotoIds = dirtyRows.get("pit_photo_keys");
            if (dirtyPhotoIds != null) {
                for (String rid : dirtyPhotoIds) {
                    JsonObject row = photoRows.get(rid);
                    int teamNum = row != null ? getInt(row, "teamNumber", parseTeamPrefix(rid)) : parseTeamPrefix(rid);
                    if (teamNum > 0) targetTeams.add(teamNum);
                }
            }
        }

        int count = 0;
        for (int teamNum : targetTeams) {
            JsonObject row = pitRows.get(String.valueOf(teamNum));
            if (row == null) {
                for (JsonObject candidate : pitRows.values()) {
                    if (getInt(candidate, "teamNumber", 0) == teamNum) {
                        row = candidate;
                        break;
                    }
                }
            }

            List<String> photoKeys = new ArrayList<>(
                    activePhotoKeysByTeam.getOrDefault(teamNum, new TreeSet<>()));
            String photoKeysJson = gson.toJson(photoKeys);

            if (row != null) {
                String rowEventId = getStr(row, "eventId", eventId);
                if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

                String id = nonBlankOr(getStr(row, "id", ""), eventId + "_pit_" + teamNum);
                String scoutId = nonBlankOr(getStr(row, "scoutId", ""), "crdt_sync");
                String scoutName = truncate(nonBlankOr(getStr(row, "scoutName", ""), "Scout"), 50);
                String robotName = truncateNullable(getStrOrNull(row, "robotName"), 100);
                String drivetrain = truncate(nonBlankOr(getStr(row, "drivetrainType", ""), "mecanum"), 30);

                handle.createUpdate("""
                        MERGE INTO pit_scouting_records (
                            id, event_id, team_number, scout_id, scout_name, robot_name,
                            drivetrain_type, weight_lbs, chassis_size, odometry_type,
                            ball_compatibility, launcher_type, flower_mechanism, has_color_sensor,
                            has_descore_mech, has_apriltag_vision,
                            claimed_auto_strategy, claimed_auto_score, claimed_teleop_cycles, claimed_teleop_score,
                            claimed_teleop_park, claimed_flower_nectars, claimed_flower_bottom_bonus,
                            claimed_flower_pollens, claimed_garden_balls,
                            claimed_endgame_score, claimed_total_score,
                            photo_keys, version, is_deleted, raw_data, updated_at
                        ) KEY (event_id, team_number)
                        VALUES (
                            :id, :eventId, :teamNumber, :scoutId, :scoutName, :robotName,
                            :drivetrainType, :weightLbs, :chassisSize, :odometryType,
                            :ballCompatibility, :launcherType, :flowerMechanism, :hasColorSensor,
                            :hasDescoreMech, :hasApriltagVision,
                            :claimedAutoStrategy, :claimedAutoScore, :claimedTeleopCycles, :claimedTeleopScore,
                            :claimedTeleopPark, :claimedFlowerNectars, :claimedFlowerBottomBonus,
                            :claimedFlowerPollens, :claimedGardenBalls,
                            :claimedEndgameScore, :claimedTotalScore,
                            :photoKeys, :version, :isDeleted, :rawData, CURRENT_TIMESTAMP
                        )
                        """)
                        .bind("id", id)
                        .bind("eventId", eventId)
                        .bind("teamNumber", teamNum)
                        .bind("scoutId", scoutId)
                        .bind("scoutName", scoutName)
                        .bind("robotName", robotName)
                        .bind("drivetrainType", drivetrain)
                        .bind("weightLbs", getDouble(row, "weightLbs", 0.0))
                        .bind("chassisSize", truncate(getStr(row, "chassisSize", ""), 64))
                        .bind("odometryType", truncate(nonBlankOr(getStr(row, "odometryType", ""), "none"), 30))
                        .bind("ballCompatibility", truncate(nonBlankOr(getStr(row, "ballCompatibility", ""), "universal"), 30))
                        .bind("launcherType", truncate(getStr(row, "launcherType", ""), 100))
                        .bind("flowerMechanism", truncate(getStr(row, "flowerMechanism", ""), 100))
                        .bind("hasColorSensor", getBool(row, "hasColorSensor", false))
                        .bind("hasDescoreMech", getBool(row, "hasDescoreMech", false))
                        .bind("hasApriltagVision", getBool(row, "hasApriltagVision", false))
                        .bind("claimedAutoStrategy", getStr(row, "claimedAutoStrategy", ""))
                        .bind("claimedAutoScore", getInt(row, "claimedAutoScore", 0))
                        .bind("claimedTeleopCycles", getInt(row, "claimedTeleopCycles", 0))
                        .bind("claimedTeleopScore", getInt(row, "claimedTeleopScore", 0))
                        .bind("claimedTeleopPark", getBool(row, "claimedTeleopPark", false))
                        .bind("claimedFlowerNectars", getInt(row, "claimedFlowerNectars", 0))
                        .bind("claimedFlowerBottomBonus", getInt(row, "claimedFlowerBottomBonus", 0))
                        .bind("claimedFlowerPollens", getInt(row, "claimedFlowerPollens", 0))
                        .bind("claimedGardenBalls", getInt(row, "claimedGardenBalls", 0))
                        .bind("claimedEndgameScore", getInt(row, "claimedEndgameScore", 0))
                        .bind("claimedTotalScore", getInt(row, "claimedTotalScore", 0))
                        .bind("photoKeys", photoKeysJson)
                        .bind("version", Math.max(1, getInt(row, "version", 1)))
                        .bind("isDeleted", getBool(row, "isDeleted", false))
                        .bind("rawData", getStrOrNull(row, "rawDataJson"))
                        .execute();
                count++;
            } else {
                int updated = handle.createUpdate(
                                "UPDATE pit_scouting_records SET photo_keys = :photoKeys, updated_at = CURRENT_TIMESTAMP " +
                                "WHERE event_id = :eventId AND team_number = :teamNumber")
                        .bind("photoKeys", photoKeysJson)
                        .bind("eventId", eventId)
                        .bind("teamNumber", teamNum)
                        .execute();
                if (updated > 0) count++;
            }
        }
        return count;
    }

    private int projectTeamTags(
            Handle handle,
            String eventId,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "team_tags");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "team_tags", projectAll);
        int count = 0;

        for (String rowId : targetRowIds) {
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            int teamNumber = getInt(row, "teamNumber", parseTeamPrefix(rowId));
            String rawTag = getStr(row, "tag", "");
            if (rawTag.isEmpty()) {
                int idx = rowId.indexOf("::");
                if (idx >= 0 && idx + 2 < rowId.length()) {
                    rawTag = rowId.substring(idx + 2);
                }
            }
            if (teamNumber <= 0 || rawTag.isEmpty()) continue;

            String normalizedTag = truncate(normalizeTag(rawTag), 30);
            String id = nonBlankOr(getStr(row, "id", ""), eventId + "_tag_" + teamNumber + "_" + normalizedTag);
            boolean active = getBool(row, "active", true);

            if (!active) {
                handle.createUpdate(
                                "DELETE FROM team_tags WHERE event_id = :eventId AND " +
                                "((team_number = :teamNumber AND LOWER(tag) = LOWER(:tag)) OR id = :id)")
                        .bind("eventId", eventId)
                        .bind("teamNumber", teamNumber)
                        .bind("tag", normalizedTag)
                        .bind("id", id)
                        .execute();
                count++;
                continue;
            }

            String color = truncate(nonBlankOr(getStr(row, "color", ""), "blue"), 16);
            boolean isPreset = getBool(row, "isPreset", false);
            String createdBy = getStrOrNull(row, "createdBy");

            handle.createUpdate("""
                    MERGE INTO team_tags (id, event_id, team_number, tag, color, is_preset, created_by, updated_at)
                    KEY (event_id, team_number, tag)
                    VALUES (:id, :eventId, :teamNumber, :tag, :color, :isPreset, :createdBy, CURRENT_TIMESTAMP)
                    """)
                    .bind("id", id)
                    .bind("eventId", eventId)
                    .bind("teamNumber", teamNumber)
                    .bind("tag", normalizedTag)
                    .bind("color", color)
                    .bind("isPreset", isPreset)
                    .bind("createdBy", createdBy)
                    .execute();
            count++;
        }
        return count;
    }

    private int projectCustomFields(
            Handle handle,
            String eventId,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "custom_fields");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "custom_fields", projectAll);
        if (targetRowIds.isEmpty()) return 0;

        // Compute dense integer order_seq sorted deterministically by orderKey across active rows
        List<Map.Entry<String, JsonObject>> sortedAll = new ArrayList<>(rows.entrySet());
        sortedAll.sort((a, b) -> {
            String ka = getStr(a.getValue(), "orderKey", String.format("%06d", getInt(a.getValue(), "orderSeq", 0)));
            String kb = getStr(b.getValue(), "orderKey", String.format("%06d", getInt(b.getValue(), "orderSeq", 0)));
            int cmp = ka.compareTo(kb);
            return cmp != 0 ? cmp : a.getKey().compareTo(b.getKey());
        });
        Map<String, Integer> computedOrderSeq = new HashMap<>();
        int seq = 1;
        for (Map.Entry<String, JsonObject> e : sortedAll) {
            int explicit = getInt(e.getValue(), "orderSeq", 0);
            computedOrderSeq.put(e.getKey(), explicit > 0 ? explicit : seq);
            seq++;
        }

        int count = 0;
        for (String rowId : targetRowIds) {
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            String id = nonBlankOr(getStr(row, "id", ""), rowId);
            boolean isDeleted = getBool(row, "isDeleted", false);

            if (isDeleted) {
                handle.createUpdate("DELETE FROM event_custom_fields WHERE id = :id AND event_id = :eventId")
                        .bind("id", id)
                        .bind("eventId", eventId)
                        .execute();
                count++;
                continue;
            }

            String target = truncate(nonBlankOr(getStr(row, "target", ""), "MATCH").toUpperCase(Locale.ROOT), 30);
            String phase = truncate(nonBlankOr(getStr(row, "phase", ""), "overall").toLowerCase(Locale.ROOT), 30);
            String name = truncate(nonBlankOr(getStr(row, "name", ""), "Field"), 100);
            String fieldKey = truncate(nonBlankOr(getStr(row, "fieldKey", ""), "field_" + Math.abs(id.hashCode())).toLowerCase(Locale.ROOT), 100);
            String fieldType = truncate(nonBlankOr(getStr(row, "fieldType", ""), "text").toLowerCase(Locale.ROOT), 30);

            handle.createUpdate(
                            "DELETE FROM event_custom_fields WHERE event_id = :eventId AND target = :target AND field_key = :fieldKey AND id <> :id")
                    .bind("eventId", eventId)
                    .bind("target", target)
                    .bind("fieldKey", fieldKey)
                    .bind("id", id)
                    .execute();

            handle.createUpdate("""
                    MERGE INTO event_custom_fields (
                        id, event_id, target, phase, name, field_key, field_type,
                        required, default_val, options_json, min_val, max_val, step_val,
                        unit, order_seq, is_active, updated_at
                    ) KEY (id)
                    VALUES (
                        :id, :eventId, :target, :phase, :name, :fieldKey, :fieldType,
                        :required, :defaultVal, :optionsJson, :minVal, :maxVal, :stepVal,
                        :unit, :orderSeq, :isActive, CURRENT_TIMESTAMP
                    )
                    """)
                    .bind("id", id)
                    .bind("eventId", eventId)
                    .bind("target", target)
                    .bind("phase", phase)
                    .bind("name", name)
                    .bind("fieldKey", fieldKey)
                    .bind("fieldType", fieldType)
                    .bind("required", getBool(row, "required", false))
                    .bind("defaultVal", getStrOrNull(row, "defaultVal"))
                    .bind("optionsJson", getStrOrNull(row, "optionsJson"))
                    .bind("minVal", getNullableDouble(row, "minVal"))
                    .bind("maxVal", getNullableDouble(row, "maxVal"))
                    .bind("stepVal", getNullableDouble(row, "stepVal"))
                    .bind("unit", truncateNullable(getStrOrNull(row, "unit"), 30))
                    .bind("orderSeq", computedOrderSeq.getOrDefault(rowId, getInt(row, "orderSeq", 1)))
                    .bind("isActive", getBool(row, "isActive", true))
                    .execute();
            count++;
        }
        return count;
    }

    private int projectSchedules(
            Handle handle,
            String eventId,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "schedules");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "schedules", projectAll);
        int count = 0;

        for (String rowId : targetRowIds) {
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            int matchNumber = getInt(row, "matchNumber", 0);
            if (matchNumber <= 0) continue;
            String level = truncate(nonBlankOr(getStr(row, "tournamentLevel", ""), "QUALIFICATION").toUpperCase(Locale.ROOT), 20);
            boolean isDeleted = getBool(row, "isDeleted", false);

            if (isDeleted) {
                handle.createUpdate(
                                "DELETE FROM match_schedules WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel")
                        .bind("eventId", eventId)
                        .bind("matchNumber", matchNumber)
                        .bind("tournamentLevel", level)
                        .execute();
                count++;
                continue;
            }

            String id = nonBlankOr(getStr(row, "id", ""), eventId + "_" + level + "_M" + matchNumber);
            handle.createUpdate("""
                    MERGE INTO match_schedules (id, event_id, match_number, tournament_level, red1, red2, blue1, blue2, created_at)
                    KEY (event_id, match_number, tournament_level)
                    VALUES (:id, :eventId, :matchNumber, :tournamentLevel, :red1, :red2, :blue1, :blue2, CURRENT_TIMESTAMP)
                    """)
                    .bind("id", id)
                    .bind("eventId", eventId)
                    .bind("matchNumber", matchNumber)
                    .bind("tournamentLevel", level)
                    .bind("red1", getInt(row, "red1", 0))
                    .bind("red2", getInt(row, "red2", 0))
                    .bind("blue1", getInt(row, "blue1", 0))
                    .bind("blue2", getInt(row, "blue2", 0))
                    .execute();
            count++;
        }
        return count;
    }

    private int projectAssignments(
            Handle handle,
            String eventId,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "assignments");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "assignments", projectAll);
        int count = 0;

        for (String rowId : targetRowIds) {
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            int matchNumber = getInt(row, "matchNumber", 0);
            String station = truncate(getStr(row, "station", ""), 10);
            if (matchNumber <= 0 || station.isEmpty()) continue;

            String level = truncate(nonBlankOr(getStr(row, "tournamentLevel", ""), "QUALIFICATION").toUpperCase(Locale.ROOT), 20);
            boolean isDeleted = getBool(row, "isDeleted", false);

            if (isDeleted) {
                handle.createUpdate(
                                "DELETE FROM scout_assignments WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel AND station = :station")
                        .bind("eventId", eventId)
                        .bind("matchNumber", matchNumber)
                        .bind("tournamentLevel", level)
                        .bind("station", station)
                        .execute();
                count++;
                continue;
            }

            String id = nonBlankOr(getStr(row, "id", ""), eventId + "_" + level + "_" + matchNumber + "_" + station);
            String scoutId = getStrOrNull(row, "scoutId");
            if (scoutId != null && scoutId.isBlank()) scoutId = null;
            String scoutName = truncateNullable(getStrOrNull(row, "scoutName"), 50);
            if (scoutName != null && scoutName.isBlank()) scoutName = null;

            handle.createUpdate("""
                    MERGE INTO scout_assignments (
                        id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name, updated_at
                    ) KEY (event_id, match_number, tournament_level, station)
                    VALUES (:id, :eventId, :matchNumber, :tournamentLevel, :station, :teamNumber, :scoutId, :scoutName, CURRENT_TIMESTAMP)
                    """)
                    .bind("id", id)
                    .bind("eventId", eventId)
                    .bind("matchNumber", matchNumber)
                    .bind("tournamentLevel", level)
                    .bind("station", station)
                    .bind("teamNumber", getInt(row, "teamNumber", 0))
                    .bind("scoutId", scoutId)
                    .bind("scoutName", scoutName)
                    .execute();
            count++;
        }
        return count;
    }

    private int projectScoutingRecords(
            Handle handle,
            String eventId,
            String callerUserId,
            boolean isHost,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "scouting_records");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "scouting_records", projectAll);
        String eventHostId = null;
        if (!isHost) {
            eventHostId = handle.createQuery("SELECT host_id FROM events WHERE id = :eventId")
                    .bind("eventId", eventId)
                    .mapTo(String.class)
                    .findFirst()
                    .orElse(null);
        }
        int count = 0;

        for (String rowId : targetRowIds) {
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            String id = nonBlankOr(getStr(row, "id", ""), rowId);
            int matchNumber = getInt(row, "matchNumber", 0);
            int teamNumber = getInt(row, "teamNumber", 0);
            if (id.isEmpty() || matchNumber <= 0 || teamNumber <= 0) continue;

            String rawScoutId = getStr(row, "scoutId", "").trim();
            int autoScore = getInt(row, "autoScore", 0);
            int teleopScore = getInt(row, "teleopScore", 0);
            int endgameScore = getInt(row, "endgameScore", 0);
            int totalScore = getInt(row, "totalScore", 0);
            String notes = getStr(row, "notes", "");
            String rawDataJson = getStr(row, "rawDataJson", "{}");
            boolean isBroken = getBool(row, "isBroken", false);
            boolean isDeleted = getBool(row, "isDeleted", false);
            String authorPubKey = truncateNullable(getStrOrNull(row, "authorPubKey"), 256);
            String authorSig = truncateNullable(getStrOrNull(row, "authorSig"), 256);
            String hostSig = truncateNullable(getStrOrNull(row, "hostSig"), 256);

            if (!isHost) {
                ScoutingRecord existing = handle.createQuery(
                                "SELECT id, event_id, scout_id, author_pub_key, author_sig FROM scouting_records WHERE id = :id")
                        .bind("id", id)
                        .map((rs, ctx) -> {
                            ScoutingRecord ex = new ScoutingRecord();
                            ex.setId(rs.getString("id"));
                            ex.setEventId(rs.getString("event_id"));
                            ex.setScoutId(rs.getString("scout_id"));
                            ex.setAuthorPubKey(rs.getString("author_pub_key"));
                            ex.setAuthorSig(rs.getString("author_sig"));
                            return ex;
                        })
                        .findFirst()
                        .orElse(null);

                if (Objects.equals(rawScoutId, callerUserId)) {
                    if (existing != null && !Objects.equals(existing.getScoutId(), callerUserId)) {
                        continue;
                    }
                } else {
                    ScoutingRecord candidate = new ScoutingRecord();
                    candidate.setId(id);
                    candidate.setEventId(eventId);
                    candidate.setScoutId(rawScoutId);
                    candidate.setMatchNumber(matchNumber);
                    candidate.setTeamNumber(teamNumber);
                    candidate.setAutoScore(autoScore);
                    candidate.setTeleopScore(teleopScore);
                    candidate.setEndgameScore(endgameScore);
                    candidate.setTotalScore(totalScore);
                    candidate.setNotes(notes);
                    candidate.setRawData(rawDataJson);
                    candidate.setIsBroken(isBroken);
                    candidate.setIsDeleted(isDeleted);
                    candidate.setAuthorPubKey(authorPubKey);
                    candidate.setAuthorSig(authorSig);
                    candidate.setHostSig(hostSig);

                    if (!EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                            handle, eventId, eventHostId, callerUserId, candidate, existing).allowed()) {
                        continue;
                    }
                }
            }

            String scoutId = nonBlankOr(rawScoutId, "crdt_sync");
            String scoutName = truncate(nonBlankOr(getStr(row, "scoutName", ""), "Scout"), 50);

            handle.createUpdate("""
                    MERGE INTO scouting_records (
                        id, event_id, scout_id, scout_name, match_number, team_number,
                        auto_score, teleop_score, endgame_score, total_score,
                        notes, raw_data, sync_status, is_broken, version, is_deleted,
                        author_pub_key, author_sig, host_sig, updated_at
                    ) KEY (id)
                    VALUES (
                        :id, :eventId, :scoutId, :scoutName, :matchNumber, :teamNumber,
                        :autoScore, :teleopScore, :endgameScore, :totalScore,
                        :notes, :rawData, 'SYNCED', :isBroken, :version, :isDeleted,
                        :authorPubKey, :authorSig, :hostSig, CURRENT_TIMESTAMP
                    )
                    """)
                    .bind("id", id)
                    .bind("eventId", eventId)
                    .bind("scoutId", scoutId)
                    .bind("scoutName", scoutName)
                    .bind("matchNumber", matchNumber)
                    .bind("teamNumber", teamNumber)
                    .bind("autoScore", autoScore)
                    .bind("teleopScore", teleopScore)
                    .bind("endgameScore", endgameScore)
                    .bind("totalScore", totalScore)
                    .bind("notes", notes)
                    .bind("rawData", rawDataJson)
                    .bind("isBroken", isBroken)
                    .bind("version", Math.max(1, getInt(row, "version", 1)))
                    .bind("isDeleted", isDeleted)
                    .bind("authorPubKey", authorPubKey)
                    .bind("authorSig", authorSig)
                    .bind("hostSig", hostSig)
                    .execute();
            count++;
        }
        return count;
    }

    private static Set<String> collectTargetRowIds(
            Map<String, JsonObject> rows,
            Map<String, List<String>> dirtyRows,
            String tableId,
            boolean projectAll
    ) {
        if (projectAll) {
            return new LinkedHashSet<>(rows.keySet());
        }
        if (dirtyRows == null) {
            return Collections.emptySet();
        }
        List<String> ids = dirtyRows.get(tableId);
        if (ids == null || ids.isEmpty()) {
            return Collections.emptySet();
        }
        return new HashSet<>(ids);
    }

    private static int parseTeamPrefix(String compositeRowId) {
        if (compositeRowId == null) return 0;
        int sep = compositeRowId.indexOf("::");
        String prefix = sep >= 0 ? compositeRowId.substring(0, sep) : compositeRowId;
        return parseIntSafe(prefix, 0);
    }

    private static int parseIntSafe(String raw, int fallback) {
        if (raw == null || raw.isBlank()) return fallback;
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String normalizeTag(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.matches("^[A-Za-z0-9 _#-]+$")) {
            return trimmed.toLowerCase(Locale.ROOT);
        }
        return trimmed;
    }

    private static String getStr(JsonObject obj, String key, String fallback) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull()) return fallback;
        if (el.isJsonPrimitive()) return el.getAsString();
        return fallback;
    }

    private static String getStrOrNull(JsonObject obj, String key) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull()) return null;
        if (el.isJsonPrimitive()) return el.getAsString();
        return null;
    }

    private static int getInt(JsonObject obj, String key, int fallback) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            return (int) Math.round(el.getAsDouble());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static double getDouble(JsonObject obj, String key, double fallback) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            return el.getAsDouble();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static Double getNullableDouble(JsonObject obj, String key) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return null;
        try {
            return el.getAsDouble();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean getBool(JsonObject obj, String key, boolean fallback) {
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return fallback;
        try {
            if (el.getAsJsonPrimitive().isBoolean()) return el.getAsBoolean();
            if (el.getAsJsonPrimitive().isNumber()) return el.getAsInt() != 0;
            return Boolean.parseBoolean(el.getAsString());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String nonBlankOr(String candidate, String fallback) {
        return (candidate != null && !candidate.isBlank()) ? candidate.trim() : fallback;
    }

    private static String truncate(String val, int maxLen) {
        if (val == null) return "";
        return val.length() <= maxLen ? val : val.substring(0, maxLen);
    }

    private static String truncateNullable(String val, int maxLen) {
        if (val == null) return null;
        return val.length() <= maxLen ? val : val.substring(0, maxLen);
    }
}
