package com.bear27570.app.util;

import com.bear27570.app.model.ScoutingRecord;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EcdsaRecordVerifierTest {

    private static KeyPair generateP256KeyPair() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        return kpg.generateKeyPair();
    }

    private static void signRecord(ScoutingRecord r, KeyPair kp) throws Exception {
        String pubBase64 = Base64.getEncoder().encodeToString(kp.getPublic().getEncoded());
        r.setAuthorPubKey(pubBase64);
        String payload = EcdsaRecordVerifier.buildCanonicalPayload(r);
        Signature sig = Signature.getInstance("SHA256withECDSAinP1363Format");
        sig.initSign(kp.getPrivate());
        sig.update(payload.getBytes(StandardCharsets.UTF_8));
        r.setAuthorSig(Base64.getEncoder().encodeToString(sig.sign()));
    }

    private static ScoutingRecord makeSampleRecord() {
        ScoutingRecord r = new ScoutingRecord();
        r.setId("rec-ecdsa-1");
        r.setEventId("evt-uuid-1");
        r.setScoutId("scout-bob");
        r.setScoutName("Bob");
        r.setMatchNumber(6);
        r.setTeamNumber(27570);
        r.setAutoScore(20);
        r.setTeleopScore(50);
        r.setEndgameScore(30);
        r.setTotalScore(100);
        r.setNotes("Solid <auto> & 'teleop' = great");
        r.setRawData("{\"allianceColor\":\"blue\",\"note\":\"x=1<2&3\"}");
        r.setIsBroken(false);
        r.setIsDeleted(false);
        return r;
    }

    @Test
    void validP1363SignatureAndSpecialCharsVerifyCleanly() throws Exception {
        KeyPair kp = generateP256KeyPair();
        ScoutingRecord r = makeSampleRecord();
        signRecord(r, kp);

        String payload = EcdsaRecordVerifier.buildCanonicalPayload(r);
        assertThat(payload).contains("<auto>");
        assertThat(payload).contains("x=1<2&3");
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isTrue();
    }

    @Test
    void verifiesCrossLanguageWebCryptoGoldenVectorByteForByte() {
        ScoutingRecord r = makeSampleRecord();
        String expectedCanonicalJson =
                "[\"SP27_REC_V1\",\"rec-ecdsa-1\",\"evt-uuid-1\",\"scout-bob\",6,27570,20,50,30,100,"
                        + "\"Solid <auto> & 'teleop' = great\","
                        + "\"{\\\"allianceColor\\\":\\\"blue\\\",\\\"note\\\":\\\"x=1<2&3\\\"}\",false,false]";

        assertThat(EcdsaRecordVerifier.buildCanonicalPayload(r)).isEqualTo(expectedCanonicalJson);

        // Generated directly by WebCrypto crypto.subtle (ECDSA P-256 / SHA-256, SPKI + P1363 Base64)
        r.setAuthorPubKey("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEM1AE0ePgEEwMTlPx5rvC3vrIWF9m/VFZK7gp5COTvM/fFeQKObrxmCU/yAMTrql12+CVy/wmfwu39fjs0ZUENg==");
        r.setAuthorSig("GqBY9AlBpTV7KHM7UsktJmAY06wQgUQ1r/Hu4q+fhIy0+FQR2bJ50aJDDwDmc8JXGxLMdZ4qCEbAiBE8yv9row==");

        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isTrue();

        // Any 1-byte mutation in canonical fields must invalidate the WebCrypto signature
        r.setNotes("Solid <auto> & 'teleop' = tampered");
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();
    }

    @Test
    void tamperedScoreOrScoutIdFailsVerification() throws Exception {
        KeyPair kp = generateP256KeyPair();
        ScoutingRecord r = makeSampleRecord();
        signRecord(r, kp);

        r.setTotalScore(999);
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();

        r.setTotalScore(100);
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isTrue();

        r.setScoutId("scout-eve");
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();
    }

    @Test
    void missingOrMalformedKeyOrSignatureFailsSafely() throws Exception {
        KeyPair kp = generateP256KeyPair();
        ScoutingRecord r = makeSampleRecord();
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(null)).isFalse();

        signRecord(r, kp);
        r.setAuthorSig("not-valid-base64!!!");
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();

        signRecord(r, kp);
        r.setAuthorPubKey("not-valid-key");
        assertThat(EcdsaRecordVerifier.verifyScoutingRecord(r)).isFalse();
    }

    @Test
    void verifyMemberIdentityCanonicalAcceptsValidAndRejectsTampered() throws Exception {
        KeyPair hostKp = generateP256KeyPair();
        KeyPair memberKp = generateP256KeyPair();

        String hostPubBase64 = Base64.getEncoder().encodeToString(hostKp.getPublic().getEncoded());
        String memberPubBase64 = Base64.getEncoder().encodeToString(memberKp.getPublic().getEncoded());

        String canonicalPayload = EcdsaRecordVerifier.buildMemberIdentityCanonicalPayload(
                "evt-1", "scout-alice", "dev-1", memberPubBase64);
        assertThat(canonicalPayload).contains("SP27_ID_V1");

        Signature sig = Signature.getInstance("SHA256withECDSAinP1363Format");
        sig.initSign(hostKp.getPrivate());
        sig.update(canonicalPayload.getBytes(StandardCharsets.UTF_8));
        String hostSigBase64 = Base64.getEncoder().encodeToString(sig.sign());

        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-1", "scout-alice", "dev-1", memberPubBase64, hostPubBase64, hostSigBase64)).isTrue();

        // Tamper userId, deviceId, eventId, or key -> must reject
        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-1", "scout-mallory", "dev-1", memberPubBase64, hostPubBase64, hostSigBase64)).isFalse();
        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-1", "scout-alice", "dev-2", memberPubBase64, hostPubBase64, hostSigBase64)).isFalse();
        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-2", "scout-alice", "dev-1", memberPubBase64, hostPubBase64, hostSigBase64)).isFalse();
        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-1", "scout-alice", "dev-1", hostPubBase64, hostPubBase64, hostSigBase64)).isFalse();

        // Blank fields must fail closed
        assertThat(EcdsaRecordVerifier.verifyMemberIdentityCanonical(
                "evt-1", " ", "dev-1", memberPubBase64, hostPubBase64, hostSigBase64)).isFalse();
    }

    private static String signMemberIdentity(
            String eventId,
            String userId,
            String deviceId,
            String memberPubBase64,
            KeyPair hostKp
    ) throws Exception {
        String canonicalPayload = EcdsaRecordVerifier.buildMemberIdentityCanonicalPayload(
                eventId, userId, deviceId, memberPubBase64);
        Signature sig = Signature.getInstance("SHA256withECDSAinP1363Format");
        sig.initSign(hostKp.getPrivate());
        sig.update(canonicalPayload.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(sig.sign());
    }

    private static JsonArray cellStamp(String val) {
        JsonArray cell = new JsonArray();
        cell.add(val);
        cell.add("hlc-1");
        cell.add(0);
        return cell;
    }

    private static JsonArray memberIdentityRowStamp(
            String eventId,
            String userId,
            String deviceId,
            String signingPubKeyBase64,
            String hostPubKeyBase64,
            String hostSigBase64
    ) {
        JsonObject cells = new JsonObject();
        cells.add("eventId", cellStamp(eventId));
        cells.add("userId", cellStamp(userId));
        cells.add("deviceId", cellStamp(deviceId));
        cells.add("signingPubKeyHex", cellStamp(signingPubKeyBase64));
        cells.add("hostPubKey", cellStamp(hostPubKeyBase64));
        cells.add("hostSig", cellStamp(hostSigBase64));

        JsonArray rowStamp = new JsonArray();
        rowStamp.add(cells);
        rowStamp.add("");
        rowStamp.add(0);
        return rowStamp;
    }

    private static String buildMergeableSnapshotWithMemberIdentities(JsonObject rowsObj) {
        JsonObject tablesObj = new JsonObject();
        if (rowsObj != null) {
            JsonArray tableStamp = new JsonArray();
            tableStamp.add(rowsObj);
            tableStamp.add("");
            tableStamp.add(0);
            tablesObj.add("member_identities", tableStamp);
        }

        JsonArray tablesStamp = new JsonArray();
        tablesStamp.add(tablesObj);
        tablesStamp.add("");
        tablesStamp.add(0);

        JsonArray valuesStamp = new JsonArray();
        valuesStamp.add(new JsonObject());
        valuesStamp.add("");
        valuesStamp.add(0);

        JsonArray root = new JsonArray();
        root.add(tablesStamp);
        root.add(valuesStamp);
        return root.toString();
    }

    private static Jdbi createMigratedEventDb() {
        String url = "jdbc:h2:mem:ecdsa_verifier_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();
        Jdbi jdbi = Jdbi.create(url, "sa", "");
        jdbi.useHandle(handle -> {
            handle.execute("INSERT INTO users (id, username) VALUES (?, ?)", "host-1", "host");
            handle.execute("INSERT INTO users (id, username) VALUES (?, ?)", "alice-1", "alice");
            handle.execute("INSERT INTO users (id, username) VALUES (?, ?)", "eve-1", "eve");
            handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                    "evt-1", "Test Event", "INVECDSA1", "host-1");
        });
        return jdbi;
    }

    @Test
    void verifyNonHostPeerRecordAuthorizationFailsClosedOnCorruptedCrdtSnapshotJson() throws Exception {
        Jdbi jdbi = createMigratedEventDb();
        jdbi.useHandle(handle -> handle.execute(
                "INSERT INTO event_crdt_state (event_id, host_epoch, snapshot_revision, crdt_snapshot_json) VALUES (?, ?, ?, ?)",
                "evt-1", 1, 1L, "{CORRUPTED_JSON"));

        KeyPair eveKp = generateP256KeyPair();
        ScoutingRecord forged = makeSampleRecord();
        forged.setEventId("evt-1");
        forged.setScoutId("alice-1");
        signRecord(forged, eveKp);

        jdbi.useHandle(handle -> assertThatThrownBy(() ->
                EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                        handle, "evt-1", "host-1", "eve-1", forged, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("member_identities"));
    }

    @Test
    void verifyNonHostPeerRecordAuthorizationFailsClosedWhenScoutingRecordsQueryFails() throws Exception {
        Jdbi unmigratedJdbi = Jdbi.create("jdbc:h2:mem:ecdsa_missing_tbl_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1", "sa", "");
        KeyPair eveKp = generateP256KeyPair();
        ScoutingRecord forged = makeSampleRecord();
        forged.setEventId("evt-1");
        forged.setScoutId("alice-1");
        signRecord(forged, eveKp);

        unmigratedJdbi.useHandle(handle -> assertThatThrownBy(() ->
                EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                        handle, "evt-1", "host-1", "eve-1", forged, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("scouting_records"));
    }

    @Test
    void verifyNonHostPeerRecordAuthorizationHandlesEmptyCrdtAndRejectsUnboundKeyWhenMemberIdentitiesPresent() throws Exception {
        Jdbi jdbi = createMigratedEventDb();
        KeyPair hostKp = generateP256KeyPair();
        KeyPair aliceKp = generateP256KeyPair();
        KeyPair eveKp = generateP256KeyPair();

        // 1. Fresh event with no event_crdt_state row operates normally without throwing (TOFU allowed)
        ScoutingRecord aliceNewRecord = makeSampleRecord();
        aliceNewRecord.setId("rec-alice-fresh");
        aliceNewRecord.setEventId("evt-1");
        aliceNewRecord.setScoutId("alice-1");
        signRecord(aliceNewRecord, aliceKp);

        jdbi.useHandle(handle -> {
            EcdsaRecordVerifier.AuthResult noRowResult = EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                    handle, "evt-1", "host-1", "eve-1", aliceNewRecord, null);
            assertThat(noRowResult.allowed()).isTrue();
        });

        // 2. Event with valid JSON lacking member_identities table operates normally without throwing
        String emptyTablesSnapshot = buildMergeableSnapshotWithMemberIdentities(null);
        jdbi.useHandle(handle -> {
            handle.execute(
                    "INSERT INTO event_crdt_state (event_id, host_epoch, snapshot_revision, crdt_snapshot_json) VALUES (?, ?, ?, ?)",
                    "evt-1", 1, 1L, emptyTablesSnapshot);
            EcdsaRecordVerifier.AuthResult noTableResult = EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                    handle, "evt-1", "host-1", "eve-1", aliceNewRecord, null);
            assertThat(noTableResult.allowed()).isTrue();
        });

        // 3. When member_identities pins alice-1 -> aliceKp, aliceKp passes while unbound eveKp forging alice-1 is rejected
        String hostPub = Base64.getEncoder().encodeToString(hostKp.getPublic().getEncoded());
        String alicePub = Base64.getEncoder().encodeToString(aliceKp.getPublic().getEncoded());
        String hostSelfSig = signMemberIdentity("evt-1", "host-1", "dev-host", hostPub, hostKp);
        String aliceCounterSig = signMemberIdentity("evt-1", "alice-1", "dev-alice", alicePub, hostKp);

        JsonObject rowsObj = new JsonObject();
        rowsObj.add("host-1::dev-host", memberIdentityRowStamp("evt-1", "host-1", "dev-host", hostPub, hostPub, hostSelfSig));
        rowsObj.add("alice-1::dev-alice", memberIdentityRowStamp("evt-1", "alice-1", "dev-alice", alicePub, hostPub, aliceCounterSig));
        String boundSnapshot = buildMergeableSnapshotWithMemberIdentities(rowsObj);

        ScoutingRecord forgedForAlice = makeSampleRecord();
        forgedForAlice.setId("rec-forged-alice");
        forgedForAlice.setEventId("evt-1");
        forgedForAlice.setScoutId("alice-1");
        signRecord(forgedForAlice, eveKp);

        jdbi.useHandle(handle -> {
            handle.execute(
                    "UPDATE event_crdt_state SET snapshot_revision = ?, crdt_snapshot_json = ? WHERE event_id = ?",
                    2L, boundSnapshot, "evt-1");

            // Control: legitimate record signed by aliceKp (relayed by eve-1) is allowed
            EcdsaRecordVerifier.AuthResult validResult = EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                    handle, "evt-1", "host-1", "eve-1", aliceNewRecord, null);
            assertThat(validResult.allowed()).isTrue();

            // Negative: forged record claiming alice-1 signed by unbound eveKp is rejected
            EcdsaRecordVerifier.AuthResult forgedResult = EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                    handle, "evt-1", "host-1", "eve-1", forgedForAlice, null);
            assertThat(forgedResult.allowed()).isFalse();
            assertThat(forgedResult.rejectReason()).contains("not bound to scoutId");
        });
    }
}
