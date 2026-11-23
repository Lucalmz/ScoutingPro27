package com.bear27570.app.routes;

import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.google.gson.Gson;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class RecordRoutesTest {

    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_record_routes");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    private static String signRecordJson(ScoutingRecord r, KeyPair kp) throws Exception {
        r.setAuthorPubKey(Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));
        String payload = EcdsaRecordVerifier.buildCanonicalPayload(r);
        Signature sig = Signature.getInstance("SHA256withECDSAinP1363Format");
        sig.initSign(kp.getPrivate());
        sig.update(payload.getBytes(StandardCharsets.UTF_8));
        r.setAuthorSig(Base64.getEncoder().encodeToString(sig.sign()));
        return new Gson().toJson(List.of(r));
    }

    @Test
    void testSyncRecordsWithNonExistentScoutIdCreatesSafePlaceholder() {
        JavalinTest.test(support.app, (server, client) -> {
            var hostReg = client.post("/api/user/register", "{\"username\":\"HostUser\", \"password\":\"HostPass\"}");
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Championship 2026\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            String unknownScoutId = "scout_uuid_unregistered_999";
            String syncPayload = "[{\"id\":\"rec_unregistered_peer_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + unknownScoutId + "\",\"scoutName\":\"RemoteScout\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":140,\"version\":1}]";

            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(syncRes.code()).isEqualTo(200);

            support.jdbi.useHandle(handle -> {
                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_unregistered_peer_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(unknownScoutId);

                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", unknownScoutId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("RemoteScout");
                assertThat(user.get("password")).isEqualTo("");
            });
        });
    }

    @Test
    void testNonMemberForbiddenOnGetAndPostRecords() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            var outsiderGet = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderGet.code()).isEqualTo(403);

            var scoutAGet = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutAGet.code()).isEqualTo(200);

            String outsiderRecordJson = "{\"id\":\"rec_out\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":100}";
            var outsiderPost = client.post("/api/records", outsiderRecordJson, b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderPost.code()).isEqualTo(403);
        });
    }

    @Test
    void testScoutIdSpoofingForcedToAuthenticatedUser() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String spoofedRecordJson = "{"
                    + "\"id\":\"rec_a1\","
                    + "\"eventId\":\"" + f.eventId + "\","
                    + "\"scoutId\":\"" + f.scoutBId + "\","
                    + "\"scoutName\":\"Scout A\","
                    + "\"matchNumber\":1,"
                    + "\"teamNumber\":27570,"
                    + "\"totalScore\":120,"
                    + "\"version\":1"
                    + "}";
            var scoutAPost = client.post("/api/records", spoofedRecordJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutAPost.code()).isEqualTo(200);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r).isNotNull();
                assertThat(r.getScoutId()).isEqualTo(f.scoutAId);
                assertThat(r.getTotalScore()).isEqualTo(120);
            });
        });
    }

    @Test
    void testNonOwnerAndFakeHostCannotOverwriteExistingRecord() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            String attackPayload = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"isHost\":true,\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":999,\"version\":2}";
            var attackRes = client.post("/api/records", attackPayload, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(attackRes.code()).isEqualTo(403);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getTotalScore()).isEqualTo(120);
                assertThat(r.getVersion()).isEqualTo(1);
            });
        });
    }

    @Test
    void testHostCanUpdateAnyEventRecord() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            String hostEditPayload = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":130,\"version\":2}";
            var hostEditRes = client.post("/api/records", hostEditPayload, b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostEditRes.code()).isEqualTo(200);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getTotalScore()).isEqualTo(130);
                assertThat(r.getVersion()).isEqualTo(2);
            });
        });
    }

    @Test
    void testSoftDeleteTombstoneOwnershipEnforcement() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            String deleteAttempt = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"isDeleted\":true,\"matchNumber\":1,\"teamNumber\":27570,\"version\":3}";
            var deleteAttemptRes = client.post("/api/records", deleteAttempt, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(deleteAttemptRes.code()).isEqualTo(403);

            var scoutADeleteRes = client.post("/api/records", deleteAttempt, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutADeleteRes.code()).isEqualTo(200);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getIsDeleted()).isTrue();
            });
        });
    }

    @Test
    void testBatchSyncOwnershipEnforcement() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String scoutASyncPayload = "[{\"id\":\"rec_a2\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":2,\"teamNumber\":27570,\"totalScore\":140,\"version\":1}]";
            var syncRes1 = client.post("/api/records/sync", scoutASyncPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(syncRes1.code()).isEqualTo(200);

            String invalidSyncPayload = "[{\"id\":\"rec_b1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":3,\"teamNumber\":27570,\"totalScore\":150,\"version\":1}]";
            var syncRes2 = client.post("/api/records/sync", invalidSyncPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(syncRes2.code()).isEqualTo(403);

            String hostBatchSyncPayload = "["
                    + "{\"id\":\"rec_b1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":3,\"teamNumber\":27570,\"totalScore\":150,\"version\":1},"
                    + "{\"id\":\"rec_a3\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":4,\"teamNumber\":27570,\"totalScore\":160,\"version\":1}"
                    + "]";
            var hostBatchRes = client.post("/api/records/sync", hostBatchSyncPayload, b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostBatchRes.code()).isEqualTo(200);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                assertThat(dao.findById("rec_b1")).isNotNull();
                assertThat(dao.findById("rec_a3")).isNotNull();
            });
        });
    }

    @Test
    void testHostMigrateScoutRecords() {
        JavalinTest.test(support.app, (server, client) -> {
            var hostReg = client.post("/api/user/register", "{\"username\":\"HostBoss\", \"password\":\"BossPass\"}");
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];
            var eventRes = client.post("/api/events", "{\"name\":\"State Championship\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            String oldScoutId = "scout_alice_old_uuid";
            String syncPayload = "[{\"id\":\"rec_alice_m1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldScoutId + "\",\"scoutName\":\"Alice\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1},"
                    + "{\"id\":\"rec_alice_m2\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldScoutId + "\",\"scoutName\":\"Alice\",\"matchNumber\":2,\"teamNumber\":27570,\"totalScore\":135,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(syncRes.code()).isEqualTo(200);

            String newScoutId = "scout_alice_new_uuid_88";
            String migratePayload = "{\"eventId\":\"" + eventId + "\",\"oldScoutId\":\"" + oldScoutId + "\",\"newScoutId\":\"" + newScoutId + "\",\"newScoutName\":\"Alice-88\"}";

            var migrateRes = client.post("/api/records/migrate-scout", migratePayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(migrateRes.code()).isEqualTo(200);

            support.jdbi.useHandle(handle -> {
                var records = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = :eventId AND scout_id = :scoutId ORDER BY match_number")
                        .bind("eventId", eventId)
                        .bind("scoutId", newScoutId)
                        .mapToMap()
                        .list();
                assertThat(records).hasSize(2);
                assertThat(records.get(0).get("scout_name")).isEqualTo("Alice-88");
                assertThat(records.get(0).get("version")).isEqualTo(2);
                assertThat(records.get(1).get("scout_name")).isEqualTo("Alice-88");
                assertThat(records.get(1).get("version")).isEqualTo(2);

                var oldRecords = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = :eventId AND scout_id = :scoutId")
                        .bind("eventId", eventId)
                        .bind("scoutId", oldScoutId)
                        .mapToMap()
                        .list();
                assertThat(oldRecords).isEmpty();
            });
        });
    }

    @Test
    void testOrdinaryScoutCanSyncCryptographicallySignedPeerRecordsButNotLegacyHostSeq() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair scoutBKp = kpg.generateKeyPair();

        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String legacyHostSeqPayload = "[{\"id\":\"rec_legacy_forged\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":4,\"teamNumber\":27570,\"totalScore\":155,\"version\":1,\"hostSeq\":10}]";
            var legacyRes = client.post("/api/records/sync", legacyHostSeqPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(legacyRes.code()).isEqualTo(403);

            ScoutingRecord signedRec = new ScoutingRecord();
            signedRec.setId("rec_signed_b");
            signedRec.setEventId(f.eventId);
            signedRec.setScoutId(f.scoutBId);
            signedRec.setMatchNumber(5);
            signedRec.setTeamNumber(27570);
            signedRec.setTotalScore(155);
            signedRec.setVersion(1);
            String signedPayload = signRecordJson(signedRec, scoutBKp);

            var signedRes = client.post("/api/records/sync", signedPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(signedRes.code()).isEqualTo(200);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                var saved = dao.findById("rec_signed_b");
                assertThat(saved).isNotNull();
                assertThat(saved.getAuthorPubKey()).isEqualTo(signedRec.getAuthorPubKey());
                assertThat(saved.getAuthorSig()).isEqualTo(signedRec.getAuthorSig());
            });

            signedRec.setTotalScore(999);
            String tamperedPayload = new Gson().toJson(List.of(signedRec));
            var tamperedRes = client.post("/api/records/sync", tamperedPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(tamperedRes.code()).isEqualTo(403);
        });
    }

    @Test
    void testOrdinaryScoutCannotAlterAuthorOfExistingRecordEvenWithEcdsaSignature() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair scoutBKp = kpg.generateKeyPair();
        KeyPair scoutAKp = kpg.generateKeyPair();

        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            ScoutingRecord signedRec = new ScoutingRecord();
            signedRec.setId("rec_signed_b2");
            signedRec.setEventId(f.eventId);
            signedRec.setScoutId(f.scoutBId);
            signedRec.setMatchNumber(6);
            signedRec.setTeamNumber(27570);
            signedRec.setTotalScore(155);
            signedRec.setVersion(1);
            String signedPayload = signRecordJson(signedRec, scoutBKp);

            var res1 = client.post("/api/records/sync", signedPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(res1.code()).isEqualTo(200);

            ScoutingRecord spoofRec = new ScoutingRecord();
            spoofRec.setId("rec_signed_b2");
            spoofRec.setEventId(f.eventId);
            spoofRec.setScoutId(f.scoutAId);
            spoofRec.setMatchNumber(6);
            spoofRec.setTeamNumber(27570);
            spoofRec.setTotalScore(180);
            spoofRec.setVersion(2);
            String spoofPayload = signRecordJson(spoofRec, scoutAKp);

            var spoofRes = client.post("/api/records/sync", spoofPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(spoofRes.code()).isEqualTo(403);
            assertThat(spoofRes.body().string()).contains("Cannot alter the author of an existing record");
        });
    }

    @Test
    void testOrdinaryScoutCannotSpoofAnotherScoutsRecordWithSelfGeneratedEcdsaKey() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair scoutBKp = kpg.generateKeyPair();
        KeyPair eveKp = kpg.generateKeyPair();

        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            ScoutingRecord bSigned = new ScoutingRecord();
            bSigned.setId("rec_b_signed");
            bSigned.setEventId(f.eventId);
            bSigned.setScoutId(f.scoutBId);
            bSigned.setMatchNumber(7);
            bSigned.setTeamNumber(27570);
            bSigned.setTotalScore(100);
            bSigned.setVersion(1);
            String bSignedPayload = signRecordJson(bSigned, scoutBKp);

            var okRes = client.post("/api/records/sync", bSignedPayload, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(okRes.code()).isEqualTo(200);

            ScoutingRecord overwriteAttempt = new ScoutingRecord();
            overwriteAttempt.setId("rec_b_signed");
            overwriteAttempt.setEventId(f.eventId);
            overwriteAttempt.setScoutId(f.scoutBId);
            overwriteAttempt.setMatchNumber(7);
            overwriteAttempt.setTeamNumber(27570);
            overwriteAttempt.setTotalScore(999);
            overwriteAttempt.setVersion(2);
            String overwritePayload = signRecordJson(overwriteAttempt, eveKp);

            var overwriteRes = client.post("/api/records/sync", overwritePayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(overwriteRes.code()).isEqualTo(403);

            ScoutingRecord newForgeAttempt = new ScoutingRecord();
            newForgeAttempt.setId("rec_b_forged");
            newForgeAttempt.setEventId(f.eventId);
            newForgeAttempt.setScoutId(f.scoutBId);
            newForgeAttempt.setMatchNumber(8);
            newForgeAttempt.setTeamNumber(27570);
            newForgeAttempt.setTotalScore(888);
            newForgeAttempt.setVersion(1);
            String newForgePayload = signRecordJson(newForgeAttempt, eveKp);

            var newForgeRes = client.post("/api/records/sync", newForgePayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(newForgeRes.code()).isEqualTo(403);

            String unsignedPayload = "[{\"id\":\"rec_b_unsigned\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":9,\"teamNumber\":27570,\"totalScore\":70,\"version\":1}]";
            var unsignedRes = client.post("/api/records/sync", unsignedPayload, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(unsignedRes.code()).isEqualTo(200);

            ScoutingRecord retroAttempt = new ScoutingRecord();
            retroAttempt.setId("rec_b_unsigned");
            retroAttempt.setEventId(f.eventId);
            retroAttempt.setScoutId(f.scoutBId);
            retroAttempt.setMatchNumber(9);
            retroAttempt.setTeamNumber(27570);
            retroAttempt.setTotalScore(777);
            retroAttempt.setVersion(2);
            String retroPayload = signRecordJson(retroAttempt, eveKp);

            var retroRes = client.post("/api/records/sync", retroPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(retroRes.code()).isEqualTo(403);

            support.jdbi.useExtension(RecordDao.class, dao -> {
                assertThat(dao.findById("rec_b_signed").getTotalScore()).isEqualTo(100);
                assertThat(dao.findById("rec_b_forged")).isNull();
                assertThat(dao.findById("rec_b_unsigned").getTotalScore()).isEqualTo(70);
            });
        });
    }
}
