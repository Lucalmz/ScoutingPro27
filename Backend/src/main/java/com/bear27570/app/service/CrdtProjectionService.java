package com.bear27570.app.service;

import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.routes.PitScoutRoutes;
import com.bear27570.app.util.DbUtil;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.bear27570.app.util.FormulaValidator;
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
            boolean forbidden,
            String reason,
            String eventId,
            int hostEpoch,
            long snapshotRevision,
            Map<String, Integer> projectedCounts
    ) {
        public SaveResult(
                boolean saved,
                boolean stale,
                String reason,
                String eventId,
                int hostEpoch,
                long snapshotRevision,
                Map<String, Integer> projectedCounts
        ) {
            this(saved, stale, false, reason, eventId, hostEpoch, snapshotRevision, projectedCounts);
        }
    }

    private record ExistingStateMeta(int hostEpoch, long snapshotRevision, String crdtSnapshotJson) {}

    private record MutableTableHandle(JsonArray tablesStamp, JsonArray tableStamp, JsonObject rowsObj) {}

    private record NonHostSanitizeResult(Set<String> rejectedRowIds, boolean snapshotMutated) {}

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
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS description       VARCHAR(300)");
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS config_json       TEXT");
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS formula_expr      TEXT");
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS aggregation_mode  VARCHAR(30) DEFAULT 'avg'");
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS display_format    VARCHAR(30) DEFAULT 'number'");
            handle.execute("ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS dependencies_json TEXT");
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

        synchronized (DbUtil.RECORD_WRITE_LOCK) {
            return DbUtil.withDeadlockRetry(() -> jdbi.inTransaction(handle -> {
                ExistingStateMeta existing = handle.createQuery(
                                "SELECT host_epoch, snapshot_revision, crdt_snapshot_json FROM event_crdt_state WHERE event_id = :eventId")
                        .bind("eventId", eventId)
                        .map((rs, ctx) -> new ExistingStateMeta(
                                rs.getInt("host_epoch"),
                                rs.getLong("snapshot_revision"),
                                rs.getString("crdt_snapshot_json")
                        ))
                        .findFirst()
                        .orElse(null);

                int requestedEpoch = Math.max(1, hostEpoch);
                String eventHostId = queryEventHostId(handle, eventId);
                boolean hostIsRegisteredLocalUser = isRegisteredUserWithPassword(handle, eventHostId);
                int currentEpoch = existing != null ? existing.hostEpoch() : 1;
                if (!isHost && hostIsRegisteredLocalUser && requestedEpoch > currentEpoch) {
                    return new SaveResult(
                            false,
                            false,
                            true,
                            "Only the event host can advance hostEpoch",
                            eventId,
                            currentEpoch,
                            existing != null ? existing.snapshotRevision() : 0L,
                            Map.of()
                    );
                }

                if (existing != null) {
                    if (requestedEpoch < existing.hostEpoch()) {
                        return new SaveResult(
                                false,
                                true,
                                false,
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
                                false,
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

                JsonElement persistedSnapshotEl = snapshotEl.deepCopy();
                Set<String> rejectedScoutingRowIds = Collections.emptySet();
                Set<String> rejectedTagRowIds = Collections.emptySet();
                Set<String> rejectedPitRowIds = Collections.emptySet();
                boolean enforceAuthoritativeNonHostGuards = !isHost && hostIsRegisteredLocalUser;
                if (!isHost) {
                    JsonElement previousSnapshotEl = parseNullableJsonArray(existing != null ? existing.crdtSnapshotJson() : null);
                    sanitizeNonHostMemberIdentities(
                            handle, eventId, callerUserId, persistedSnapshotEl, previousSnapshotEl);
                    NonHostSanitizeResult sanitizeResult = sanitizeNonHostScoutingSnapshot(
                            handle, eventId, callerUserId, persistedSnapshotEl, previousSnapshotEl);
                    rejectedScoutingRowIds = sanitizeResult.rejectedRowIds();

                    if (enforceAuthoritativeNonHostGuards) {
                        sanitizeNonHostReadOnlyTable(persistedSnapshotEl, previousSnapshotEl, "custom_fields");
                        sanitizeNonHostReadOnlyTable(persistedSnapshotEl, previousSnapshotEl, "schedules");
                        sanitizeNonHostReadOnlyTable(persistedSnapshotEl, previousSnapshotEl, "assignments");
                        rejectedTagRowIds = sanitizeNonHostTeamTags(
                                handle, eventId, callerUserId, persistedSnapshotEl, previousSnapshotEl);
                        rejectedPitRowIds = sanitizeNonHostPitDeletes(
                                handle, eventId, callerUserId, persistedSnapshotEl, previousSnapshotEl);
                    }
                }

                boolean noDirtyMap = dirtyRows == null || dirtyRows.isEmpty();
                boolean projectAll = fullProjection || (existing == null && noDirtyMap);

                // Validate and project scouting_records before overwriting event_crdt_state so
                // key-binding verification reads previously persisted trusted state.
                int projectedScoutingCount = projectScoutingRecords(
                        handle, eventId, callerUserId, isHost, persistedSnapshotEl, dirtyRows, projectAll, rejectedScoutingRowIds);

                final String snapshotJson = gson.toJson(persistedSnapshotEl);
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
                counts.put("pit_records", projectPitAndPhotos(handle, eventId, persistedSnapshotEl, dirtyRows, projectAll, rejectedPitRowIds));
                counts.put("team_tags", projectTeamTags(handle, eventId, callerUserId, enforceAuthoritativeNonHostGuards, persistedSnapshotEl, dirtyRows, projectAll, rejectedTagRowIds));
                if (enforceAuthoritativeNonHostGuards) {
                    counts.put("custom_fields", 0);
                    counts.put("schedules", 0);
                    counts.put("assignments", 0);
                } else {
                    counts.put("custom_fields", projectCustomFields(handle, eventId, persistedSnapshotEl, dirtyRows, projectAll));
                    counts.put("schedules", projectSchedules(handle, eventId, persistedSnapshotEl, dirtyRows, projectAll));
                    counts.put("assignments", projectAssignments(handle, eventId, persistedSnapshotEl, dirtyRows, projectAll));
                }
                counts.put("scouting_records", projectedScoutingCount);

                return new SaveResult(true, false, false, null, eventId, effectiveEpoch, effectiveRev, counts);
            }));
        }
    }

    private static JsonElement parseNullableJsonArray(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(json);
            return parsed != null && parsed.isJsonArray() ? parsed : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static Map<String, JsonElement> extractRawTableRows(JsonElement snapshotEl, String tableId) {
        Map<String, JsonElement> out = new LinkedHashMap<>();
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
            out.put(rowEntry.getKey(), rowEntry.getValue());
        }
        return out;
    }

    private static MutableTableHandle getOrCreateMutableTable(JsonElement snapshotEl, String tableId) {
        if (snapshotEl == null || !snapshotEl.isJsonArray()) return null;
        JsonArray root = snapshotEl.getAsJsonArray();
        if (root.size() < 1 || !root.get(0).isJsonArray()) return null;

        JsonArray tablesStamp = root.get(0).getAsJsonArray();
        if (tablesStamp.size() < 1 || !tablesStamp.get(0).isJsonObject()) return null;

        JsonObject tablesObj = tablesStamp.get(0).getAsJsonObject();
        JsonElement tableEl = tablesObj.get(tableId);
        JsonArray tableStamp;
        if (tableEl == null || !tableEl.isJsonArray()) {
            tableStamp = new JsonArray();
            tableStamp.add(new JsonObject());
            tableStamp.add("");
            tablesObj.add(tableId, tableStamp);
        } else {
            tableStamp = tableEl.getAsJsonArray();
            if (tableStamp.size() < 1 || !tableStamp.get(0).isJsonObject()) {
                while (tableStamp.size() > 0) {
                    tableStamp.remove(tableStamp.size() - 1);
                }
                tableStamp.add(new JsonObject());
                tableStamp.add("");
            }
        }
        return new MutableTableHandle(tablesStamp, tableStamp, tableStamp.get(0).getAsJsonObject());
    }

    private static void trimStampHash(JsonArray stamp) {
        while (stamp != null && stamp.size() > 2) {
            stamp.remove(stamp.size() - 1);
        }
    }

    private static String queryEventHostId(Handle handle, String eventId) {
        return handle.createQuery("SELECT host_id FROM events WHERE id = :eventId")
                .bind("eventId", eventId)
                .mapTo(String.class)
                .findFirst()
                .orElse(null);
    }

    private static boolean isRegisteredUserWithPassword(Handle handle, String userId) {
        if (handle == null || userId == null || userId.isBlank()) {
            return false;
        }
        Integer count = handle.createQuery(
                        "SELECT COUNT(*) FROM users WHERE id = :id AND password IS NOT NULL AND TRIM(password) <> ''")
                .bind("id", userId)
                .mapTo(Integer.class)
                .findFirst()
                .orElse(0);
        return count != null && count > 0;
    }

    /**
     * Validates `member_identities` rows when a non-Host member calls PUT /crdt-state:
     * - Blocks non-Host callers from injecting a self-signed Host master-key bootstrap anchor
     *   on the authoritative Host database (where eventHostId is a locally registered user with password).
     * - Preserves cold-replica sync (e.g. standby laptop HostB where eventHostId is a passwordless placeholder)
     *   by allowing at most one cryptographically valid self-signed Host anchor when no Host key is pinned yet.
     * - Requires Host countersignature (`hostSig` verified against a trusted Host key) for any third-party
     *   key binding, while allowing a non-Host caller to publish only their own unsigned self-row (`userId == callerUserId`).
     * - Restores previously persisted `member_identities` rows of other users if tampered or omitted.
     */
    private void sanitizeNonHostMemberIdentities(
            Handle handle,
            String eventId,
            String callerUserId,
            JsonElement persistedSnapshotEl,
            JsonElement previousSnapshotEl
    ) {
        Map<String, JsonObject> incomingPlainRows = extractTableRows(persistedSnapshotEl, "member_identities");
        Map<String, JsonElement> incomingRawRows = extractRawTableRows(persistedSnapshotEl, "member_identities");
        Map<String, JsonObject> previousPlainRows = extractTableRows(previousSnapshotEl, "member_identities");
        Map<String, JsonElement> previousRawRows = extractRawTableRows(previousSnapshotEl, "member_identities");

        if (incomingRawRows.isEmpty() && previousRawRows.isEmpty()) {
            return;
        }

        MutableTableHandle tableHandle = getOrCreateMutableTable(persistedSnapshotEl, "member_identities");
        if (tableHandle == null) {
            return;
        }

        String eventHostId = queryEventHostId(handle, eventId);
        boolean hostIsRegisteredLocalUser = isRegisteredUserWithPassword(handle, eventHostId);

        Set<String> trustedHostKeys = new HashSet<>();
        if (eventHostId != null && !eventHostId.isBlank()) {
            List<String> dbHostKeys = handle.createQuery(
                            "SELECT DISTINCT author_pub_key FROM scouting_records " +
                            "WHERE event_id = :eventId AND scout_id = :hostId " +
                            "AND author_pub_key IS NOT NULL AND TRIM(author_pub_key) <> ''")
                    .bind("eventId", eventId)
                    .bind("hostId", eventHostId)
                    .mapTo(String.class)
                    .list();
            for (String k : dbHostKeys) {
                if (k != null && !k.isBlank()) {
                    trustedHostKeys.add(k.trim());
                }
            }

            for (JsonObject prevRow : previousPlainRows.values()) {
                String rowEventId = getStr(prevRow, "eventId", "").trim();
                if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;
                String uId = getStr(prevRow, "userId", "").trim();
                String devId = getStr(prevRow, "deviceId", "").trim();
                String pubKey = getStr(prevRow, "signingPubKeyHex", "").trim();
                String hPub = getStr(prevRow, "hostPubKey", "").trim();
                String hSig = getStr(prevRow, "hostSig", "").trim();
                if (eventHostId.equals(uId)
                        && !pubKey.isEmpty()
                        && pubKey.equals(hPub)
                        && EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                                rowEventId.isEmpty() ? eventId : rowEventId,
                                uId, devId, pubKey, hPub, hSig)) {
                    trustedHostKeys.add(pubKey);
                }
            }

            if (trustedHostKeys.isEmpty() && !hostIsRegisteredLocalUser) {
                for (JsonObject incRow : incomingPlainRows.values()) {
                    String rowEventId = getStr(incRow, "eventId", "").trim();
                    if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;
                    String uId = getStr(incRow, "userId", "").trim();
                    String devId = getStr(incRow, "deviceId", "").trim();
                    String pubKey = getStr(incRow, "signingPubKeyHex", "").trim();
                    String hPub = getStr(incRow, "hostPubKey", "").trim();
                    String hSig = getStr(incRow, "hostSig", "").trim();
                    if (eventHostId.equals(uId)
                            && !pubKey.isEmpty()
                            && pubKey.equals(hPub)
                            && EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                                    rowEventId.isEmpty() ? eventId : rowEventId,
                                    uId, devId, pubKey, hPub, hSig)) {
                        trustedHostKeys.add(pubKey);
                        break;
                    }
                }
            }
        }

        boolean snapshotMutated = false;

        for (String rowId : new ArrayList<>(incomingRawRows.keySet())) {
            JsonElement incomingRaw = incomingRawRows.get(rowId);
            JsonElement previousRaw = previousRawRows.get(rowId);
            if (previousRaw != null && previousRaw.equals(incomingRaw)) {
                continue;
            }
            JsonObject row = incomingPlainRows.get(rowId);
            JsonObject prevPlain = previousPlainRows.get(rowId);
            if (!isNonHostMemberIdentityAuthorized(
                    eventId, callerUserId, trustedHostKeys, row, prevPlain)) {
                if (previousRaw != null) {
                    tableHandle.rowsObj().add(rowId, previousRaw.deepCopy());
                } else {
                    tableHandle.rowsObj().remove(rowId);
                }
                snapshotMutated = true;
            }
        }

        for (Map.Entry<String, JsonElement> prevEntry : previousRawRows.entrySet()) {
            String prevRowId = prevEntry.getKey();
            if (incomingRawRows.containsKey(prevRowId)) {
                continue;
            }
            JsonObject prevPlain = previousPlainRows.get(prevRowId);
            String prevUserId = prevPlain != null ? getStr(prevPlain, "userId", "").trim() : "";
            if (!Objects.equals(prevUserId, callerUserId)) {
                tableHandle.rowsObj().add(prevRowId, prevEntry.getValue().deepCopy());
                snapshotMutated = true;
            }
        }

        if (snapshotMutated) {
            trimStampHash(tableHandle.tableStamp());
            trimStampHash(tableHandle.tablesStamp());
        }
    }

    private static boolean isNonHostMemberIdentityAuthorized(
            String eventId,
            String callerUserId,
            Set<String> trustedHostKeys,
            JsonObject row,
            JsonObject prevPlain
    ) {
        if (row == null) return false;
        String rowEventId = getStr(row, "eventId", "").trim();
        if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) {
            return false;
        }
        String userId = getStr(row, "userId", "").trim();
        String deviceId = getStr(row, "deviceId", "").trim();
        String pubKey = getStr(row, "signingPubKeyHex", "").trim();
        if (userId.isEmpty() || deviceId.isEmpty() || pubKey.isEmpty()) {
            return false;
        }
        if (prevPlain != null) {
            String prevUserId = getStr(prevPlain, "userId", "").trim();
            if (!prevUserId.isEmpty() && !prevUserId.equals(userId)) {
                return false;
            }
        }
        String hostPubKey = getStr(row, "hostPubKey", "").trim();
        String hostSig = getStr(row, "hostSig", "").trim();
        if (hostPubKey.isEmpty() && hostSig.isEmpty()) {
            if (!Objects.equals(userId, callerUserId)) {
                return false;
            }
            if (prevPlain != null && !getStr(prevPlain, "hostSig", "").trim().isEmpty()) {
                return false;
            }
            return true;
        }
        if (hostPubKey.isEmpty() || hostSig.isEmpty() || trustedHostKeys.isEmpty() || !trustedHostKeys.contains(hostPubKey)) {
            return false;
        }
        return EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                rowEventId.isEmpty() ? eventId : rowEventId,
                userId,
                deviceId,
                pubKey,
                hostPubKey,
                hostSig
        );
    }

    private static ScoutingRecord queryExistingScoutingRecord(Handle handle, String id) {
        return handle.createQuery(
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
    }

    private static ScoutingRecord toCandidateScoutingRecord(String id, String eventId, JsonObject row) {
        ScoutingRecord candidate = new ScoutingRecord();
        candidate.setId(id);
        candidate.setEventId(eventId);
        candidate.setScoutId(getStr(row, "scoutId", "").trim());
        candidate.setMatchNumber(getInt(row, "matchNumber", 0));
        candidate.setTeamNumber(getInt(row, "teamNumber", 0));
        candidate.setAutoScore(getInt(row, "autoScore", 0));
        candidate.setTeleopScore(getInt(row, "teleopScore", 0));
        candidate.setEndgameScore(getInt(row, "endgameScore", 0));
        candidate.setTotalScore(getInt(row, "totalScore", 0));
        candidate.setNotes(getStr(row, "notes", ""));
        candidate.setRawData(getStr(row, "rawDataJson", "{}"));
        candidate.setIsBroken(getBool(row, "isBroken", false));
        candidate.setIsDeleted(getBool(row, "isDeleted", false));
        candidate.setAuthorPubKey(truncateNullable(getStrOrNull(row, "authorPubKey"), 256));
        candidate.setAuthorSig(truncateNullable(getStrOrNull(row, "authorSig"), 256));
        candidate.setHostSig(truncateNullable(getStrOrNull(row, "hostSig"), 256));
        return candidate;
    }

    private static boolean isNonHostScoutingRowAuthorized(
            Handle handle,
            String eventId,
            String eventHostId,
            String callerUserId,
            String rowId,
            JsonObject row
    ) {
        if (row == null) return false;
        String rowEventId = getStr(row, "eventId", eventId);
        if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) {
            return false;
        }
        String id = nonBlankOr(getStr(row, "id", ""), rowId);
        int matchNumber = getInt(row, "matchNumber", 0);
        int teamNumber = getInt(row, "teamNumber", 0);
        if (id.isEmpty() || matchNumber <= 0 || teamNumber <= 0) {
            return false;
        }
        ScoutingRecord candidate = toCandidateScoutingRecord(id, eventId, row);
        ScoutingRecord existing = queryExistingScoutingRecord(handle, id);
        if (existing != null && !Objects.equals(existing.getEventId(), eventId)) {
            return false;
        }
        if (Objects.equals(candidate.getScoutId(), callerUserId)) {
            return existing == null || Objects.equals(existing.getScoutId(), callerUserId);
        }
        return EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                handle, eventId, eventHostId, callerUserId, candidate, existing).allowed();
    }

    /**
     * Validates all incoming `scouting_records` rows when a non-Host member calls PUT /crdt-state,
     * stripping forged rows and restoring previously persisted trusted rows if tampered or omitted.
     */
    private NonHostSanitizeResult sanitizeNonHostScoutingSnapshot(
            Handle handle,
            String eventId,
            String callerUserId,
            JsonElement persistedSnapshotEl,
            JsonElement previousSnapshotEl
    ) {
        Map<String, JsonObject> incomingPlainRows = extractTableRows(persistedSnapshotEl, "scouting_records");
        Map<String, JsonElement> incomingRawRows = extractRawTableRows(persistedSnapshotEl, "scouting_records");
        Map<String, JsonObject> previousPlainRows = extractTableRows(previousSnapshotEl, "scouting_records");
        Map<String, JsonElement> previousRawRows = extractRawTableRows(previousSnapshotEl, "scouting_records");

        if (incomingRawRows.isEmpty() && previousRawRows.isEmpty()) {
            return new NonHostSanitizeResult(Collections.emptySet(), false);
        }

        MutableTableHandle tableHandle = getOrCreateMutableTable(persistedSnapshotEl, "scouting_records");
        if (tableHandle == null) {
            return new NonHostSanitizeResult(Collections.emptySet(), false);
        }

        String eventHostId = queryEventHostId(handle, eventId);
        Set<String> rejectedRowIds = new HashSet<>();
        boolean snapshotMutated = false;

        for (String rowId : new ArrayList<>(incomingRawRows.keySet())) {
            JsonElement incomingRaw = incomingRawRows.get(rowId);
            JsonElement previousRaw = previousRawRows.get(rowId);
            if (previousRaw != null && previousRaw.equals(incomingRaw)) {
                continue;
            }
            JsonObject row = incomingPlainRows.get(rowId);
            if (!isNonHostScoutingRowAuthorized(handle, eventId, eventHostId, callerUserId, rowId, row)) {
                rejectedRowIds.add(rowId);
                if (previousRaw != null) {
                    tableHandle.rowsObj().add(rowId, previousRaw.deepCopy());
                } else {
                    tableHandle.rowsObj().remove(rowId);
                }
                snapshotMutated = true;
            }
        }

        for (Map.Entry<String, JsonElement> prevEntry : previousRawRows.entrySet()) {
            String prevRowId = prevEntry.getKey();
            if (incomingRawRows.containsKey(prevRowId)) {
                continue;
            }
            JsonObject prevPlain = previousPlainRows.get(prevRowId);
            String prevScoutId = prevPlain != null ? getStr(prevPlain, "scoutId", "").trim() : "";
            if (!Objects.equals(prevScoutId, callerUserId)) {
                tableHandle.rowsObj().add(prevRowId, prevEntry.getValue().deepCopy());
                rejectedRowIds.add(prevRowId);
                snapshotMutated = true;
            }
        }

        if (snapshotMutated) {
            trimStampHash(tableHandle.tableStamp());
            trimStampHash(tableHandle.tablesStamp());
        }

        return new NonHostSanitizeResult(rejectedRowIds, snapshotMutated);
    }

    /**
     * Restores host-only CRDT tables (`custom_fields`, `schedules`, `assignments`) back to their
     * previously persisted state when a non-Host member calls PUT /crdt-state on an authoritative Host DB.
     */
    private void sanitizeNonHostReadOnlyTable(
            JsonElement persistedSnapshotEl,
            JsonElement previousSnapshotEl,
            String tableId
    ) {
        Map<String, JsonElement> incomingRawRows = extractRawTableRows(persistedSnapshotEl, tableId);
        Map<String, JsonElement> previousRawRows = extractRawTableRows(previousSnapshotEl, tableId);
        if (incomingRawRows.isEmpty() && previousRawRows.isEmpty()) {
            return;
        }
        MutableTableHandle tableHandle = getOrCreateMutableTable(persistedSnapshotEl, tableId);
        if (tableHandle == null) {
            return;
        }
        boolean snapshotMutated = false;
        for (String rowId : new ArrayList<>(incomingRawRows.keySet())) {
            JsonElement incomingRaw = incomingRawRows.get(rowId);
            JsonElement previousRaw = previousRawRows.get(rowId);
            if (previousRaw == null) {
                tableHandle.rowsObj().remove(rowId);
                snapshotMutated = true;
            } else if (!previousRaw.equals(incomingRaw)) {
                tableHandle.rowsObj().add(rowId, previousRaw.deepCopy());
                snapshotMutated = true;
            }
        }
        for (Map.Entry<String, JsonElement> prevEntry : previousRawRows.entrySet()) {
            if (!incomingRawRows.containsKey(prevEntry.getKey())) {
                tableHandle.rowsObj().add(prevEntry.getKey(), prevEntry.getValue().deepCopy());
                snapshotMutated = true;
            }
        }
        if (snapshotMutated) {
            trimStampHash(tableHandle.tableStamp());
            trimStampHash(tableHandle.tablesStamp());
        }
    }

    private static boolean isValidTeamTagName(String normalizedTag) {
        return normalizedTag != null
                && !normalizedTag.isEmpty()
                && normalizedTag.length() <= 30
                && !normalizedTag.contains(".")
                && normalizedTag.matches("^[\\p{L}\\p{N} _#-]+$");
    }

    /**
     * Enforces TeamTagRoutes parity on `team_tags` when a non-Host member pushes CRDT state
     * to an authoritative Host DB: creator-only delete, no creator/preset spoofing, tag char/length
     * whitelist, and <= 15 active tags per team.
     */
    private Set<String> sanitizeNonHostTeamTags(
            Handle handle,
            String eventId,
            String callerUserId,
            JsonElement persistedSnapshotEl,
            JsonElement previousSnapshotEl
    ) {
        Map<String, JsonObject> incomingPlainRows = extractTableRows(persistedSnapshotEl, "team_tags");
        Map<String, JsonElement> incomingRawRows = extractRawTableRows(persistedSnapshotEl, "team_tags");
        Map<String, JsonObject> previousPlainRows = extractTableRows(previousSnapshotEl, "team_tags");
        Map<String, JsonElement> previousRawRows = extractRawTableRows(previousSnapshotEl, "team_tags");
        Set<String> rejectedRowIds = new HashSet<>();

        if (incomingRawRows.isEmpty() && previousRawRows.isEmpty()) {
            return rejectedRowIds;
        }
        MutableTableHandle tableHandle = getOrCreateMutableTable(persistedSnapshotEl, "team_tags");
        if (tableHandle == null) {
            return rejectedRowIds;
        }

        // Load existing DB tag creators & per-team counts for authoritative checks
        Map<String, String> dbCreatorByTeamAndTag = new HashMap<>();
        Map<String, String> dbCreatorById = new HashMap<>();
        Map<Integer, Set<String>> activeTagsByTeam = new HashMap<>();
        handle.createQuery("SELECT id, team_number, LOWER(tag) AS ltag, created_by FROM team_tags WHERE event_id = :eventId")
                .bind("eventId", eventId)
                .map((rs, ctx) -> {
                    String id = rs.getString("id");
                    int teamNum = rs.getInt("team_number");
                    String ltag = rs.getString("ltag");
                    String creator = rs.getString("created_by");
                    if (id != null && creator != null) dbCreatorById.put(id, creator);
                    if (ltag != null) {
                        if (creator != null) dbCreatorByTeamAndTag.put(teamNum + "::" + ltag, creator);
                        activeTagsByTeam.computeIfAbsent(teamNum, k -> new HashSet<>()).add(ltag);
                    }
                    return null;
                })
                .list();

        boolean snapshotMutated = false;
        for (String rowId : new ArrayList<>(incomingRawRows.keySet())) {
            JsonElement incomingRaw = incomingRawRows.get(rowId);
            JsonElement previousRaw = previousRawRows.get(rowId);
            if (previousRaw != null && previousRaw.equals(incomingRaw)) {
                continue;
            }
            JsonObject row = incomingPlainRows.get(rowId);
            JsonObject prevPlain = previousPlainRows.get(rowId);
            boolean reject = false;
            if (row == null) {
                reject = true;
            } else {
                String rowEventId = getStr(row, "eventId", eventId);
                int teamNumber = getInt(row, "teamNumber", parseTeamPrefix(rowId));
                String rawTag = getStr(row, "tag", "");
                if (rawTag.isEmpty()) {
                    int idx = rowId.indexOf("::");
                    if (idx >= 0 && idx + 2 < rowId.length()) {
                        rawTag = rowId.substring(idx + 2);
                    }
                }
                String normalizedTag = normalizeTag(rawTag);
                String rowTagId = nonBlankOr(getStr(row, "id", ""), eventId + "_tag_" + teamNumber + "_" + normalizedTag);
                boolean active = getBool(row, "active", true);
                String existingCreator = prevPlain != null ? getStrOrNull(prevPlain, "createdBy") : null;
                if (existingCreator == null || existingCreator.isBlank()) {
                    existingCreator = dbCreatorByTeamAndTag.get(teamNumber + "::" + normalizedTag.toLowerCase(Locale.ROOT));
                }
                if ((existingCreator == null || existingCreator.isBlank()) && !rowTagId.isBlank()) {
                    existingCreator = dbCreatorById.get(rowTagId);
                }

                if ((!rowEventId.isEmpty() && !eventId.equals(rowEventId))
                        || teamNumber <= 0
                        || !isValidTeamTagName(normalizedTag)) {
                    reject = true;
                } else if (!active) {
                    boolean existedBefore = prevPlain != null
                            || dbCreatorByTeamAndTag.containsKey(teamNumber + "::" + normalizedTag.toLowerCase(Locale.ROOT))
                            || dbCreatorById.containsKey(rowTagId);
                    if (existedBefore) {
                        boolean isCreator = callerUserId != null
                                && existingCreator != null
                                && callerUserId.equals(existingCreator.trim());
                        if (!isCreator) {
                            reject = true;
                        }
                    }
                } else {
                    boolean isPreset = getBool(row, "isPreset", false);
                    String rowCreatedBy = getStr(row, "createdBy", "").trim();
                    if (isPreset) {
                        reject = true;
                    } else if (existingCreator != null && !existingCreator.isBlank()) {
                        if (!Objects.equals(existingCreator.trim(), callerUserId)
                                && !rowCreatedBy.isEmpty()
                                && !Objects.equals(rowCreatedBy, existingCreator.trim())) {
                            reject = true;
                        }
                    } else {
                        if (!rowCreatedBy.isEmpty() && !Objects.equals(rowCreatedBy, callerUserId)) {
                            reject = true;
                        } else {
                            Set<String> teamTags = activeTagsByTeam.computeIfAbsent(teamNumber, k -> new HashSet<>());
                            String lowerTag = normalizedTag.toLowerCase(Locale.ROOT);
                            if (!teamTags.contains(lowerTag) && teamTags.size() >= 15) {
                                reject = true;
                            } else {
                                teamTags.add(lowerTag);
                            }
                        }
                    }
                }
            }

            if (reject) {
                rejectedRowIds.add(rowId);
                if (previousRaw != null) {
                    tableHandle.rowsObj().add(rowId, previousRaw.deepCopy());
                } else {
                    tableHandle.rowsObj().remove(rowId);
                }
                snapshotMutated = true;
            }
        }

        for (Map.Entry<String, JsonElement> prevEntry : previousRawRows.entrySet()) {
            String prevRowId = prevEntry.getKey();
            if (incomingRawRows.containsKey(prevRowId)) {
                continue;
            }
            JsonObject prevPlain = previousPlainRows.get(prevRowId);
            String prevCreator = prevPlain != null ? getStr(prevPlain, "createdBy", "").trim() : "";
            if (!Objects.equals(prevCreator, callerUserId)) {
                tableHandle.rowsObj().add(prevRowId, prevEntry.getValue().deepCopy());
                rejectedRowIds.add(prevRowId);
                snapshotMutated = true;
            }
        }

        if (snapshotMutated) {
            trimStampHash(tableHandle.tableStamp());
            trimStampHash(tableHandle.tablesStamp());
        }
        return rejectedRowIds;
    }

    /**
     * Allows collaborative pit edits by non-host members, while blocking non-host soft-deletion
     * (`isDeleted = true`) of pit records authored by another user on an authoritative Host DB.
     */
    private Set<String> sanitizeNonHostPitDeletes(
            Handle handle,
            String eventId,
            String callerUserId,
            JsonElement persistedSnapshotEl,
            JsonElement previousSnapshotEl
    ) {
        Map<String, JsonObject> incomingPlainRows = extractTableRows(persistedSnapshotEl, "pit_records");
        Map<String, JsonElement> incomingRawRows = extractRawTableRows(persistedSnapshotEl, "pit_records");
        Map<String, JsonObject> previousPlainRows = extractTableRows(previousSnapshotEl, "pit_records");
        Map<String, JsonElement> previousRawRows = extractRawTableRows(previousSnapshotEl, "pit_records");
        Set<String> rejectedRowIds = new HashSet<>();

        if (incomingRawRows.isEmpty() && previousRawRows.isEmpty()) {
            return rejectedRowIds;
        }
        MutableTableHandle tableHandle = getOrCreateMutableTable(persistedSnapshotEl, "pit_records");
        if (tableHandle == null) {
            return rejectedRowIds;
        }

        Map<Integer, String> dbScoutByTeam = new HashMap<>();
        handle.createQuery("SELECT team_number, scout_id FROM pit_scouting_records WHERE event_id = :eventId")
                .bind("eventId", eventId)
                .map((rs, ctx) -> {
                    String sId = rs.getString("scout_id");
                    if (sId != null) dbScoutByTeam.put(rs.getInt("team_number"), sId);
                    return null;
                })
                .list();

        boolean snapshotMutated = false;
        for (String rowId : new ArrayList<>(incomingRawRows.keySet())) {
            JsonElement incomingRaw = incomingRawRows.get(rowId);
            JsonElement previousRaw = previousRawRows.get(rowId);
            if (previousRaw != null && previousRaw.equals(incomingRaw)) {
                continue;
            }
            JsonObject row = incomingPlainRows.get(rowId);
            if (row == null) continue;
            boolean isDeleted = getBool(row, "isDeleted", false);
            if (!isDeleted) continue;

            int teamNumber = getInt(row, "teamNumber", parseIntSafe(rowId, 0));
            JsonObject prevPlain = previousPlainRows.get(rowId);
            String existingScoutId = prevPlain != null ? getStr(prevPlain, "scoutId", "").trim() : "";
            if (existingScoutId.isEmpty() && teamNumber > 0) {
                String fromDb = dbScoutByTeam.get(teamNumber);
                if (fromDb != null) existingScoutId = fromDb.trim();
            }
            if (!existingScoutId.isEmpty() && !Objects.equals(existingScoutId, callerUserId)) {
                rejectedRowIds.add(rowId);
                if (teamNumber > 0) rejectedRowIds.add(String.valueOf(teamNumber));
                if (previousRaw != null) {
                    tableHandle.rowsObj().add(rowId, previousRaw.deepCopy());
                } else {
                    tableHandle.rowsObj().remove(rowId);
                }
                snapshotMutated = true;
            }
        }

        if (snapshotMutated) {
            trimStampHash(tableHandle.tableStamp());
            trimStampHash(tableHandle.tablesStamp());
        }
        return rejectedRowIds;
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
            boolean projectAll,
            Set<String> rejectedPitRowIds
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
            if (rejectedPitRowIds != null && rejectedPitRowIds.contains(String.valueOf(teamNum))) {
                continue;
            }
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

                PitScoutingRecord pitRec = new PitScoutingRecord();
                pitRec.setId(id);
                pitRec.setEventId(eventId);
                pitRec.setTeamNumber(teamNum);
                pitRec.setScoutId(scoutId);
                pitRec.setScoutName(scoutName);
                pitRec.setRobotName(robotName);
                pitRec.setDrivetrainType(drivetrain);
                pitRec.setWeightLbs(getDouble(row, "weightLbs", 0.0));
                pitRec.setChassisSize(getStr(row, "chassisSize", ""));
                pitRec.setOdometryType(truncate(nonBlankOr(getStr(row, "odometryType", ""), "none"), 30));
                pitRec.setBallCompatibility(truncate(nonBlankOr(getStr(row, "ballCompatibility", ""), "universal"), 30));
                pitRec.setLauncherType(truncate(getStr(row, "launcherType", ""), 100));
                pitRec.setFlowerMechanism(truncate(getStr(row, "flowerMechanism", ""), 100));
                pitRec.setClaimedAutoStrategy(getStr(row, "claimedAutoStrategy", ""));
                pitRec.setClaimedAutoScore(getInt(row, "claimedAutoScore", 0));
                pitRec.setClaimedTeleopCycles(getInt(row, "claimedTeleopCycles", 0));
                pitRec.setClaimedTeleopScore(getInt(row, "claimedTeleopScore", 0));
                pitRec.setClaimedTeleopPark(getBool(row, "claimedTeleopPark", false));
                pitRec.setClaimedFlowerNectars(getInt(row, "claimedFlowerNectars", 0));
                pitRec.setClaimedFlowerBottomBonus(getInt(row, "claimedFlowerBottomBonus", 0));
                pitRec.setClaimedFlowerPollens(getInt(row, "claimedFlowerPollens", 0));
                pitRec.setClaimedGardenBalls(getInt(row, "claimedGardenBalls", 0));
                pitRec.setClaimedEndgameScore(getInt(row, "claimedEndgameScore", 0));
                pitRec.setClaimedTotalScore(getInt(row, "claimedTotalScore", 0));
                PitScoutRoutes.normalizePitRecord(pitRec);

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
                        .bind("drivetrainType", truncate(pitRec.getDrivetrainType(), 30))
                        .bind("weightLbs", pitRec.getWeightLbs())
                        .bind("chassisSize", truncate(pitRec.getChassisSize(), 64))
                        .bind("odometryType", truncate(pitRec.getOdometryType(), 30))
                        .bind("ballCompatibility", truncate(pitRec.getBallCompatibility(), 30))
                        .bind("launcherType", truncate(pitRec.getLauncherType(), 100))
                        .bind("flowerMechanism", truncate(pitRec.getFlowerMechanism(), 100))
                        .bind("hasColorSensor", getBool(row, "hasColorSensor", false))
                        .bind("hasDescoreMech", getBool(row, "hasDescoreMech", false))
                        .bind("hasApriltagVision", getBool(row, "hasApriltagVision", false))
                        .bind("claimedAutoStrategy", pitRec.getClaimedAutoStrategy())
                        .bind("claimedAutoScore", pitRec.getClaimedAutoScore())
                        .bind("claimedTeleopCycles", pitRec.getClaimedTeleopCycles())
                        .bind("claimedTeleopScore", pitRec.getClaimedTeleopScore())
                        .bind("claimedTeleopPark", pitRec.isClaimedTeleopPark())
                        .bind("claimedFlowerNectars", pitRec.getClaimedFlowerNectars())
                        .bind("claimedFlowerBottomBonus", pitRec.getClaimedFlowerBottomBonus())
                        .bind("claimedFlowerPollens", pitRec.getClaimedFlowerPollens())
                        .bind("claimedGardenBalls", pitRec.getClaimedGardenBalls())
                        .bind("claimedEndgameScore", pitRec.getClaimedEndgameScore())
                        .bind("claimedTotalScore", pitRec.getClaimedTotalScore())
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
            String callerUserId,
            boolean enforceNonHostRules,
            JsonElement snapshotEl,
            Map<String, List<String>> dirtyRows,
            boolean projectAll,
            Set<String> rejectedTagRowIds
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "team_tags");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "team_tags", projectAll);
        int count = 0;

        for (String rowId : targetRowIds) {
            if (rejectedTagRowIds != null && rejectedTagRowIds.contains(rowId)) {
                continue;
            }
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
            if (enforceNonHostRules && !isValidTeamTagName(normalizedTag)) continue;
            String id = nonBlankOr(getStr(row, "id", ""), eventId + "_tag_" + teamNumber + "_" + normalizedTag);
            boolean active = getBool(row, "active", true);

            if (!active) {
                if (enforceNonHostRules) {
                    String existingCreator = handle.createQuery(
                                    "SELECT created_by FROM team_tags WHERE event_id = :eventId AND " +
                                    "((team_number = :teamNumber AND LOWER(tag) = LOWER(:tag)) OR id = :id) LIMIT 1")
                            .bind("eventId", eventId)
                            .bind("teamNumber", teamNumber)
                            .bind("tag", normalizedTag)
                            .bind("id", id)
                            .mapTo(String.class)
                            .findFirst()
                            .orElse(null);
                    if (existingCreator != null && !Objects.equals(existingCreator.trim(), callerUserId)) {
                        continue;
                    }
                    if (existingCreator == null) {
                        continue;
                    }
                }
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
            boolean isPreset = !enforceNonHostRules && getBool(row, "isPreset", false);
            String createdBy = getStrOrNull(row, "createdBy");
            if (enforceNonHostRules && (createdBy == null || createdBy.isBlank())) {
                createdBy = callerUserId;
            }

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
            String description = truncateNullable(getStrOrNull(row, "description"), 300);
            String configJson = getStrOrNull(row, "configJson");
            String aggregationMode = truncate(nonBlankOr(getStr(row, "aggregationMode", ""), "avg").toLowerCase(Locale.ROOT), 30);
            String displayFormat = truncate(nonBlankOr(getStr(row, "displayFormat", ""), "number").toLowerCase(Locale.ROOT), 30);

            String formulaExpr = null;
            String dependenciesJson = null;
            if ("formula".equals(fieldType)) {
                String rawFormula = getStrOrNull(row, "formulaExpr");
                if (rawFormula != null && !rawFormula.isBlank()) {
                    // Validate syntax/injection/DoS/namespace only; allow cyclic dependencies from offline CRDT merges
                    FormulaValidator.ValidationResult valRes = FormulaValidator.validate(rawFormula, target);
                    if (valRes.isValid()) {
                        formulaExpr = rawFormula;
                        dependenciesJson = gson.toJson(valRes.getDependencies());
                    }
                }
            }

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
                        unit, description, config_json, formula_expr, aggregation_mode,
                        display_format, dependencies_json, order_seq, is_active, updated_at
                    ) KEY (id)
                    VALUES (
                        :id, :eventId, :target, :phase, :name, :fieldKey, :fieldType,
                        :required, :defaultVal, :optionsJson, :minVal, :maxVal, :stepVal,
                        :unit, :description, :configJson, :formulaExpr, :aggregationMode,
                        :displayFormat, :dependenciesJson, :orderSeq, :isActive, CURRENT_TIMESTAMP
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
                    .bind("description", description)
                    .bind("configJson", configJson)
                    .bind("formulaExpr", formulaExpr)
                    .bind("aggregationMode", aggregationMode)
                    .bind("displayFormat", displayFormat)
                    .bind("dependenciesJson", dependenciesJson)
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
            boolean projectAll,
            Set<String> preRejectedRowIds
    ) {
        Map<String, JsonObject> rows = extractTableRows(snapshotEl, "scouting_records");
        Set<String> targetRowIds = collectTargetRowIds(rows, dirtyRows, "scouting_records", projectAll);
        String eventHostId = isHost ? null : queryEventHostId(handle, eventId);
        int count = 0;

        for (String rowId : targetRowIds) {
            if (preRejectedRowIds != null && preRejectedRowIds.contains(rowId)) {
                continue;
            }
            JsonObject row = rows.get(rowId);
            if (row == null) continue;
            String rowEventId = getStr(row, "eventId", eventId);
            if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;

            String id = nonBlankOr(getStr(row, "id", ""), rowId);
            int matchNumber = getInt(row, "matchNumber", 0);
            int teamNumber = getInt(row, "teamNumber", 0);
            if (id.isEmpty() || matchNumber <= 0 || teamNumber <= 0) continue;

            ScoutingRecord candidate = toCandidateScoutingRecord(id, eventId, row);
            ScoutingRecord existing = queryExistingScoutingRecord(handle, id);
            if (existing != null && !Objects.equals(existing.getEventId(), eventId)) {
                continue;
            }
            if (!isHost && !isNonHostScoutingRowAuthorized(handle, eventId, eventHostId, callerUserId, rowId, row)) {
                continue;
            }

            String rawScoutId = candidate.getScoutId();
            int autoScore = candidate.getAutoScore();
            int teleopScore = candidate.getTeleopScore();
            int endgameScore = candidate.getEndgameScore();
            int totalScore = candidate.getTotalScore();
            String notes = candidate.getNotes();
            String rawDataJson = candidate.getRawData();
            boolean isBroken = candidate.getIsBroken();
            boolean isDeleted = candidate.isDeleted();
            String authorPubKey = candidate.getAuthorPubKey();
            String authorSig = candidate.getAuthorSig();
            String hostSig = candidate.getHostSig();

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
