package com.bear27570.app.util;

import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.service.CrdtProjectionService;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jdbi.v3.core.Handle;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Cryptographic ECDSA P-256 / SHA-256 verifier for ScoutingRecord payloads,
 * byte-compatible with frontend `buildRecordCanonicalPayload` in `recordSignature.ts`.
 */
public final class EcdsaRecordVerifier {

    private static final Logger logger = LoggerFactory.getLogger(EcdsaRecordVerifier.class);
    private static final Gson CANONICAL_GSON = new GsonBuilder().disableHtmlEscaping().create();

    public record AuthResult(boolean allowed, String rejectReason) {
        public static AuthResult ok() {
            return new AuthResult(true, null);
        }

        public static AuthResult reject(String reason) {
            return new AuthResult(false, reason);
        }
    }

    private record KeyBindings(
            Map<String, Set<String>> keysByUser,
            Map<String, Set<String>> usersByKey,
            Set<String> memberAnchoredKeysForUserPrefix
    ) {}

    private EcdsaRecordVerifier() {}

    public static String buildCanonicalPayload(ScoutingRecord r) {
        String raw = (r.getRawData() != null && !r.getRawData().isEmpty()) ? r.getRawData() : "{}";
        JsonArray arr = new JsonArray();
        arr.add("SP27_REC_V1");
        arr.add(r.getId() != null ? r.getId() : "");
        arr.add(r.getEventId() != null ? r.getEventId() : "");
        arr.add(r.getScoutId() != null ? r.getScoutId() : "");
        arr.add(r.getMatchNumber());
        arr.add(r.getTeamNumber());
        arr.add(r.getAutoScore());
        arr.add(r.getTeleopScore());
        arr.add(r.getEndgameScore());
        arr.add(r.getTotalScore());
        arr.add(r.getNotes() != null ? r.getNotes() : "");
        arr.add(raw);
        arr.add(r.getIsBroken());
        arr.add(r.isDeleted());
        return CANONICAL_GSON.toJson(arr);
    }

    public static String buildMemberIdentityCanonicalPayload(
            String eventId,
            String userId,
            String deviceId,
            String signingPubKeyHex
    ) {
        JsonArray arr = new JsonArray();
        arr.add("SP27_ID_V1");
        arr.add(eventId != null ? eventId : "");
        arr.add(userId != null ? userId : "");
        arr.add(deviceId != null ? deviceId : "");
        arr.add(signingPubKeyHex != null ? signingPubKeyHex : "");
        return CANONICAL_GSON.toJson(arr);
    }

    private static boolean verifyRawSignature(String spkiBase64, String canonicalPayload, String signatureBase64) {
        if (spkiBase64 == null || spkiBase64.isBlank() || signatureBase64 == null || signatureBase64.isBlank()) {
            return false;
        }
        try {
            byte[] pubBytes = Base64.getDecoder().decode(spkiBase64.trim());
            byte[] sigBytes = Base64.getDecoder().decode(signatureBase64.trim());
            KeyFactory kf = KeyFactory.getInstance("EC");
            PublicKey pubKey = kf.generatePublic(new X509EncodedKeySpec(pubBytes));
            Signature sig = Signature.getInstance("SHA256withECDSAinP1363Format");
            sig.initVerify(pubKey);
            sig.update(canonicalPayload.getBytes(StandardCharsets.UTF_8));
            return sig.verify(sigBytes);
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean verifyMemberIdentityCanonical(
            String eventId,
            String userId,
            String deviceId,
            String signingPubKeyBase64,
            String hostPubKeyBase64,
            String hostSigBase64
    ) {
        if (userId == null || userId.isBlank()
                || deviceId == null || deviceId.isBlank()
                || signingPubKeyBase64 == null || signingPubKeyBase64.isBlank()
                || hostPubKeyBase64 == null || hostPubKeyBase64.isBlank()
                || hostSigBase64 == null || hostSigBase64.isBlank()) {
            return false;
        }
        String payload = buildMemberIdentityCanonicalPayload(eventId, userId, deviceId, signingPubKeyBase64);
        return verifyRawSignature(hostPubKeyBase64, payload, hostSigBase64);
    }

    public static boolean verifyScoutingRecord(ScoutingRecord r) {
        if (r == null
                || r.getAuthorPubKey() == null
                || r.getAuthorPubKey().isBlank()
                || r.getAuthorSig() == null
                || r.getAuthorSig().isBlank()) {
            return false;
        }
        return verifyRawSignature(r.getAuthorPubKey(), buildCanonicalPayload(r), r.getAuthorSig());
    }

    public static AuthResult verifyNonHostPeerRecordAuthorization(
            Handle handle,
            String eventId,
            String eventHostId,
            String callerUserId,
            ScoutingRecord incoming,
            ScoutingRecord existing
    ) {
        if (!verifyScoutingRecord(incoming)) {
            return AuthResult.reject("Invalid ECDSA signature");
        }
        String targetScoutId = incoming.getScoutId() != null ? incoming.getScoutId().trim() : "";
        if (targetScoutId.isEmpty()) {
            return AuthResult.reject("Signed record is missing scoutId");
        }
        if (existing != null && !Objects.equals(existing.getScoutId(), targetScoutId)) {
            return AuthResult.reject("Cannot alter the author of an existing record");
        }

        boolean callerIsAuthor = Objects.equals(targetScoutId, callerUserId);
        if (callerIsAuthor) {
            return AuthResult.ok();
        }

        String pub = incoming.getAuthorPubKey().trim();
        KeyBindings bindings = loadTrustedKeyBindings(handle, eventId, eventHostId);
        Set<String> hostKeys = (eventHostId != null && !eventHostId.isBlank())
                ? bindings.keysByUser().getOrDefault(eventHostId, Set.of())
                : Set.of();

        if (existing != null) {
            String existingPub = existing.getAuthorPubKey() != null ? existing.getAuthorPubKey().trim() : "";
            if (!existingPub.isEmpty()) {
                if (!pub.equals(existingPub) && !hostKeys.contains(pub)) {
                    return AuthResult.reject("Author public key mismatch for existing record");
                }
            } else {
                boolean boundInMemberIdentities = bindings.memberAnchoredKeysForUserPrefix()
                        .contains(targetScoutId + "::" + pub);
                if (!boundInMemberIdentities && !hostKeys.contains(pub)) {
                    return AuthResult.reject("Cannot retroactively sign another scout's unsigned record");
                }
            }
        }

        Set<String> targetKeys = bindings.keysByUser().getOrDefault(targetScoutId, Set.of());
        if (!targetKeys.isEmpty() && !targetKeys.contains(pub) && !hostKeys.contains(pub)) {
            return AuthResult.reject("Author public key is not bound to scoutId");
        }

        Set<String> boundUsers = bindings.usersByKey().getOrDefault(pub, Set.of());
        if (!boundUsers.isEmpty()
                && !boundUsers.contains(targetScoutId)
                && (eventHostId == null || !boundUsers.contains(eventHostId))) {
            return AuthResult.reject("Author public key is already bound to another scout");
        }

        return AuthResult.ok();
    }

    private static KeyBindings loadTrustedKeyBindings(Handle handle, String eventId, String eventHostId) {
        Map<String, Set<String>> keysByUser = new HashMap<>();
        Map<String, Set<String>> usersByKey = new HashMap<>();
        Set<String> memberAnchoredPairs = new HashSet<>();

        if (handle == null || eventId == null || eventId.isBlank()) {
            return new KeyBindings(keysByUser, usersByKey, memberAnchoredPairs);
        }

        try {
            handle.createQuery(
                    "SELECT DISTINCT scout_id, author_pub_key FROM scouting_records " +
                    "WHERE event_id = :eventId AND scout_id IS NOT NULL AND TRIM(scout_id) <> '' " +
                    "AND author_pub_key IS NOT NULL AND TRIM(author_pub_key) <> ''")
                    .bind("eventId", eventId)
                    .map((rs, ctx) -> Map.entry(rs.getString("scout_id").trim(), rs.getString("author_pub_key").trim()))
                    .list()
                    .forEach(entry -> {
                        keysByUser.computeIfAbsent(entry.getKey(), k -> new HashSet<>()).add(entry.getValue());
                        usersByKey.computeIfAbsent(entry.getValue(), k -> new HashSet<>()).add(entry.getKey());
                    });
        } catch (Exception e) {
            logger.warn("Failed to load scouting_records key bindings for event {}", eventId, e);
            throw new IllegalStateException("Failed to load scouting_records key bindings for event " + eventId, e);
        }

        try {
            String snapshotJson = handle.createQuery(
                    "SELECT crdt_snapshot_json FROM event_crdt_state WHERE event_id = :eventId")
                    .bind("eventId", eventId)
                    .mapTo(String.class)
                    .findFirst()
                    .orElse(null);

            if (snapshotJson != null && !snapshotJson.isBlank()) {
                JsonElement snapshotEl = JsonParser.parseString(snapshotJson);
                Map<String, JsonObject> idRows = CrdtProjectionService.extractTableRows(snapshotEl, "member_identities");
                Set<String> trustedHostKeys = new HashSet<>();
                if (eventHostId != null && !eventHostId.isBlank()) {
                    trustedHostKeys.addAll(keysByUser.getOrDefault(eventHostId, Set.of()));
                }

                // Pass 1: verify self-signed host identity anchors (bootstrap at most one if none pinned yet)
                for (JsonObject row : idRows.values()) {
                    String rowEventId = getJsonStr(row, "eventId");
                    if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;
                    String userId = getJsonStr(row, "userId");
                    String deviceId = getJsonStr(row, "deviceId");
                    String pubKey = getJsonStr(row, "signingPubKeyHex");
                    String hostPubKey = getJsonStr(row, "hostPubKey");
                    String hostSig = getJsonStr(row, "hostSig");
                    if (trustedHostKeys.isEmpty()
                            && eventHostId != null
                            && eventHostId.equals(userId)
                            && !pubKey.isEmpty()
                            && pubKey.equals(hostPubKey)
                            && verifyMemberIdentityCanonical(
                                    rowEventId.isEmpty() ? eventId : rowEventId,
                                    userId,
                                    deviceId,
                                    pubKey,
                                    hostPubKey,
                                    hostSig)) {
                        trustedHostKeys.add(pubKey);
                        keysByUser.computeIfAbsent(userId, k -> new HashSet<>()).add(pubKey);
                        usersByKey.computeIfAbsent(pubKey, k -> new HashSet<>()).add(userId);
                        memberAnchoredPairs.add(userId + "::" + pubKey);
                    }
                }

                // Pass 2: verify host-countersigned member identities against trusted host keys
                for (JsonObject row : idRows.values()) {
                    String rowEventId = getJsonStr(row, "eventId");
                    if (!rowEventId.isEmpty() && !eventId.equals(rowEventId)) continue;
                    String userId = getJsonStr(row, "userId");
                    String deviceId = getJsonStr(row, "deviceId");
                    String pubKey = getJsonStr(row, "signingPubKeyHex");
                    String hostPubKey = getJsonStr(row, "hostPubKey");
                    String hostSig = getJsonStr(row, "hostSig");
                    if (userId.isEmpty() || deviceId.isEmpty() || pubKey.isEmpty()) continue;
                    if (!hostPubKey.isEmpty()
                            && !hostSig.isEmpty()
                            && trustedHostKeys.contains(hostPubKey)
                            && verifyMemberIdentityCanonical(
                                    rowEventId.isEmpty() ? eventId : rowEventId,
                                    userId,
                                    deviceId,
                                    pubKey,
                                    hostPubKey,
                                    hostSig)) {
                        keysByUser.computeIfAbsent(userId, k -> new HashSet<>()).add(pubKey);
                        usersByKey.computeIfAbsent(pubKey, k -> new HashSet<>()).add(userId);
                        memberAnchoredPairs.add(userId + "::" + pubKey);
                    }
                }
            }
        } catch (Exception e) {
            logger.warn("Failed to load member_identities key bindings for event {}", eventId, e);
            throw new IllegalStateException("Failed to load member_identities key bindings for event " + eventId, e);
        }

        return new KeyBindings(keysByUser, usersByKey, memberAnchoredPairs);
    }

    private static String getJsonStr(JsonObject obj, String key) {
        if (obj == null) return "";
        JsonElement el = obj.get(key);
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) return "";
        return el.getAsString().trim();
    }
}
