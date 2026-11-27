package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.service.CrdtProjectionService;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import io.javalin.testtools.HttpClient;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CrdtAndSecurityExtendedTest {

    @TempDir
    Path tempDir;

    private Jdbi jdbi;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();
        AESUtil.initMasterKey();

        String url = "jdbc:h2:mem:test_crdt_ext_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());
        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        try {
            if (apiRoutes != null) apiRoutes.shutdown();
            JdbiConfig.closeDataSources();
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) System.clearProperty("scouting.data.dir");
            else System.setProperty("scouting.data.dir", prevDataDir);
        }
    }

    private Map<?, ?> registerUser(HttpClient client, String username) {
        var res = client.post("/api/user/register", gson.toJson(Map.of("username", username, "password", "Pass123!")));
        assertThat(res.code()).isEqualTo(200);
        return gson.fromJson(res.body().string(), Map.class);
    }

    private Map<?, ?> createEvent(HttpClient client, String token, String name) {
        var res = client.post("/api/events", gson.toJson(Map.of("name", name)),
                req -> req.header("Authorization", "Bearer " + token));
        assertThat(res.code()).isEqualTo(200);
        return gson.fromJson(res.body().string(), Map.class);
    }

    private static JsonArray buildSnapshot(Map<String, Map<String, Map<String, Object>>> tables) {
        JsonObject tablesObj = new JsonObject();
        for (var tableEntry : tables.entrySet()) {
            JsonObject rowsObj = new JsonObject();
            for (var rowEntry : tableEntry.getValue().entrySet()) {
                JsonObject cellsObj = new JsonObject();
                for (var cell : rowEntry.getValue().entrySet()) {
                    if (cell.getValue() != null) {
                        JsonArray cellArr = new JsonArray();
                        cellArr.add(new Gson().toJsonTree(cell.getValue()));
                        cellArr.add("HLC1");
                        cellsObj.add(cell.getKey(), cellArr);
                    }
                }
                JsonArray rowArr = new JsonArray();
                rowArr.add(cellsObj);
                rowArr.add("HLC1");
                rowsObj.add(rowEntry.getKey(), rowArr);
            }
            JsonArray tableArr = new JsonArray();
            tableArr.add(rowsObj);
            tableArr.add("HLC1");
            tablesObj.add(tableEntry.getKey(), tableArr);
        }
        JsonArray tablesStamp = new JsonArray();
        tablesStamp.add(tablesObj);
        tablesStamp.add("HLC1");
        JsonArray valuesStamp = new JsonArray();
        valuesStamp.add(new JsonObject());
        valuesStamp.add("");
        JsonArray root = new JsonArray();
        root.add(tablesStamp);
        root.add(valuesStamp);
        return root;
    }

    @Test
    void testCrdtRoutesInputValidationStringSnapshotsAndEpochRevisionRules() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "crdt_val_alice");
            String aliceToken = (String) alice.get("token");
            String eventId = (String) createEvent(client, aliceToken, "CRDT Validation Event").get("id");

            // 1. Blank eventId -> 400; invalid JSON / non-object / missing snapshot -> 400
            assertThat(client.get("/api/events/%20/crdt-state", r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(400);
            assertThat(client.put("/api/events/%20/crdt-state", "{}", r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(400);
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", "{bad", r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(400);
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", "[]", r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(400);
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", "{\"hostEpoch\":1}", r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(400);

            // 2. crdtSnapshotJson stringified form + epoch<=0 normalized to 1 + rev==0 on fresh DB normalized to 1
            String snapStr = buildSnapshot(Map.of()).toString();
            JsonObject req1 = new JsonObject();
            req1.addProperty("hostEpoch", 0);
            req1.addProperty("snapshotRevision", 0);
            req1.addProperty("crdtSnapshotJson", snapStr);
            var res1 = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req1),
                    r -> r.header("Authorization", "Bearer " + aliceToken));
            assertThat(res1.code()).isEqualTo(200);
            JsonObject j1 = JsonParser.parseString(res1.body().string()).getAsJsonObject();
            assertThat(j1.get("hostEpoch").getAsInt()).isEqualTo(1);
            assertThat(j1.get("snapshotRevision").getAsLong()).isEqualTo(1L);

            // 3. Stringified "snapshot" field + hostEpoch bump 1 -> 2 advances snapshotRevision to at least existing + 1 (2)
            JsonObject req2 = new JsonObject();
            req2.addProperty("hostEpoch", 2);
            req2.addProperty("snapshotRevision", 0);
            req2.addProperty("snapshot", snapStr);
            var res2 = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req2),
                    r -> r.header("Authorization", "Bearer " + aliceToken));
            assertThat(res2.code()).isEqualTo(200);
            JsonObject j2 = JsonParser.parseString(res2.body().string()).getAsJsonObject();
            assertThat(j2.get("hostEpoch").getAsInt()).isEqualTo(2);
            assertThat(j2.get("snapshotRevision").getAsLong()).isEqualTo(2L);

            // 4. Stale epoch (1 < 2) MUST return 409 stale_epoch
            JsonObject staleEpochReq = new JsonObject();
            staleEpochReq.addProperty("hostEpoch", 1);
            staleEpochReq.addProperty("snapshotRevision", 99);
            staleEpochReq.add("snapshot", buildSnapshot(Map.of()));
            var staleRes = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(staleEpochReq),
                    r -> r.header("Authorization", "Bearer " + aliceToken));
            assertThat(staleRes.code()).isEqualTo(409);
            assertThat(staleRes.body().string()).contains("stale_epoch");

            // 5. ensureCrdtSchema is idempotent
            CrdtProjectionService.ensureCrdtSchema(jdbi);
        });
    }

    @Test
    void testCrdtProjectionPhotoOnlyUpdateAndDeletionsAcrossTables() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "crdt_del_alice");
            String aliceId = (String) alice.get("id");
            String aliceToken = (String) alice.get("token");
            String eventId = (String) createEvent(client, aliceToken, "CRDT Delete & Photo Event").get("id");

            Map<String, Map<String, Map<String, Object>>> initTables = new LinkedHashMap<>();
            initTables.put("pit_records", Map.of(
                    "27570", Map.of("id", eventId + "_pit_27570", "eventId", eventId, "teamNumber", 27570, "scoutId", aliceId, "scoutName", "Alice")
            ));
            initTables.put("pit_photo_keys", Map.of(
                    "27570::p1", Map.of("teamNumber", 27570, "photoKey", "p1", "active", true)
            ));
            initTables.put("custom_fields", Map.of(
                    "cf-a", Map.of("id", "cf-a", "eventId", eventId, "target", "MATCH", "name", "A", "fieldKey", "k_a", "fieldType", "number", "orderSeq", 0, "orderKey", "002"),
                    "cf-b", Map.of("id", "cf-b", "eventId", eventId, "target", "MATCH", "name", "B", "fieldKey", "k_b", "fieldType", "number", "orderSeq", 0, "orderKey", "001")
            ));
            initTables.put("schedules", Map.of(
                    "QUALIFICATION_1", Map.of("id", eventId + "_M1", "eventId", eventId, "matchNumber", 1, "tournamentLevel", "QUALIFICATION", "red1", 27570, "red2", 1, "blue1", 2, "blue2", 3)
            ));
            initTables.put("assignments", Map.of(
                    "QUALIFICATION_1_red1", Map.of("id", eventId + "_A1", "eventId", eventId, "matchNumber", 1, "tournamentLevel", "QUALIFICATION", "station", "red1", "teamNumber", 27570, "scoutId", "", "scoutName", "  ")
            ));

            JsonObject req1 = new JsonObject();
            req1.addProperty("hostEpoch", 1);
            req1.addProperty("snapshotRevision", 1);
            req1.addProperty("fullProjection", true);
            req1.add("snapshot", buildSnapshot(initTables));
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req1),
                    r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(200);

            jdbi.useHandle(h -> {
                assertThat(h.createQuery("SELECT order_seq FROM event_custom_fields WHERE id = 'cf-b'").mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(h.createQuery("SELECT order_seq FROM event_custom_fields WHERE id = 'cf-a'").mapTo(Integer.class).one()).isEqualTo(2);
                assertThat(h.createQuery("SELECT scout_id FROM scout_assignments WHERE event_id = ? AND match_number = 1").bind(0, eventId).mapTo(String.class).one()).isNull();
            });

            // Dirty ONLY pit_photo_keys (adding p2) + delete cf-a, schedule M1, assignment A1
            Map<String, Map<String, Map<String, Object>>> updTables = new LinkedHashMap<>();
            updTables.put("pit_photo_keys", Map.of(
                    "27570::p1", Map.of("teamNumber", 27570, "photoKey", "p1", "active", true),
                    "27570::p2", Map.of("teamNumber", 27570, "photoKey", "p2", "active", true)
            ));
            updTables.put("custom_fields", Map.of(
                    "cf-a", Map.of("id", "cf-a", "eventId", eventId, "isDeleted", true)
            ));
            updTables.put("schedules", Map.of(
                    "QUALIFICATION_1", Map.of("eventId", eventId, "matchNumber", 1, "tournamentLevel", "QUALIFICATION", "isDeleted", true)
            ));
            updTables.put("assignments", Map.of(
                    "QUALIFICATION_1_red1", Map.of("eventId", eventId, "matchNumber", 1, "tournamentLevel", "QUALIFICATION", "station", "red1", "isDeleted", true)
            ));

            JsonObject req2 = new JsonObject();
            req2.addProperty("hostEpoch", 1);
            req2.addProperty("snapshotRevision", 2);
            req2.add("snapshot", buildSnapshot(updTables));
            req2.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "pit_photo_keys", List.of("27570::p2"),
                    "custom_fields", List.of("cf-a"),
                    "schedules", List.of("QUALIFICATION_1"),
                    "assignments", List.of("QUALIFICATION_1_red1")
            ))));
            var res2 = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req2),
                    r -> r.header("Authorization", "Bearer " + aliceToken));
            assertThat(res2.code()).isEqualTo(200);

            jdbi.useHandle(h -> {
                String photoKeys = h.createQuery("SELECT photo_keys FROM pit_scouting_records WHERE event_id = ? AND team_number = 27570")
                        .bind(0, eventId).mapTo(String.class).one();
                assertThat(photoKeys).contains("p1").contains("p2");
                assertThat(h.createQuery("SELECT COUNT(*) FROM event_custom_fields WHERE id = 'cf-a'").mapTo(Integer.class).one()).isZero();
                assertThat(h.createQuery("SELECT COUNT(*) FROM match_schedules WHERE event_id = ?").bind(0, eventId).mapTo(Integer.class).one()).isZero();
                assertThat(h.createQuery("SELECT COUNT(*) FROM scout_assignments WHERE event_id = ?").bind(0, eventId).mapTo(Integer.class).one()).isZero();
            });
        });
    }

    @Test
    void testNonHostTeamTagGuards15LimitPresetSpoofCreatorSpoofAndColdReplicaBootstrap() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair remoteHostKp = kpg.generateKeyPair();
        KeyPair bobKp = kpg.generateKeyPair();

        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "tag_host_alice");
            String aliceToken = (String) alice.get("token");
            Map<?, ?> evt = createEvent(client, aliceToken, "Tag Guard Event");
            String eventId = (String) evt.get("id");
            String inviteCode = (String) evt.get("inviteCode");

            Map<?, ?> bob = registerUser(client, "tag_bob");
            String bobId = (String) bob.get("id");
            String bobToken = (String) bob.get("token");
            assertThat(client.post("/api/events/join", gson.toJson(Map.of("inviteCode", inviteCode)),
                    r -> r.header("Authorization", "Bearer " + bobToken)).code()).isEqualTo(200);

            // Seed 14 tags by Bob + 1 tag by Alice (15 total on team 27570)
            Map<String, Map<String, Object>> tagRows = new LinkedHashMap<>();
            for (int i = 1; i <= 14; i++) {
                tagRows.put("27570::t" + i, Map.of("id", eventId + "_t" + i, "eventId", eventId, "teamNumber", 27570, "tag", "t" + i, "active", true, "createdBy", bobId));
            }
            tagRows.put("27570::alice_tag", Map.of("id", eventId + "_ta", "eventId", eventId, "teamNumber", 27570, "tag", "alice_tag", "active", true, "createdBy", alice.get("id")));
            JsonObject seedReq = new JsonObject();
            seedReq.addProperty("hostEpoch", 1);
            seedReq.addProperty("snapshotRevision", 1);
            seedReq.addProperty("fullProjection", true);
            seedReq.add("snapshot", buildSnapshot(Map.of("team_tags", tagRows)));
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(seedReq),
                    r -> r.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(200);

            // Bob tries: (a) 16th tag, (b) isPreset=true, (c) createdBy=alice spoof, (d) dot in tag, (e) omit alice_tag
            Map<String, Map<String, Object>> badTags = new LinkedHashMap<>(tagRows);
            badTags.remove("27570::alice_tag"); // omission attack
            badTags.put("27570::t15_over", Map.of("id", eventId + "_t15", "eventId", eventId, "teamNumber", 27570, "tag", "t15_over", "active", true, "createdBy", bobId));
            badTags.put("27570::preset_spoof", Map.of("id", eventId + "_tp", "eventId", eventId, "teamNumber", 27571, "tag", "preset_spoof", "isPreset", true, "active", true, "createdBy", bobId));
            badTags.put("27570::creator_spoof", Map.of("id", eventId + "_tc", "eventId", eventId, "teamNumber", 27571, "tag", "creator_spoof", "active", true, "createdBy", alice.get("id")));
            badTags.put("27570::bad.dot", Map.of("id", eventId + "_td", "eventId", eventId, "teamNumber", 27571, "tag", "bad.dot", "active", true, "createdBy", bobId));
            // Positive control: Bob CAN add a valid tag on team 27571 and soft-delete his own t1 on 27570
            badTags.put("27571::bob_valid", Map.of("id", eventId + "_bv", "eventId", eventId, "teamNumber", 27571, "tag", "bob_valid", "active", true, "createdBy", bobId));
            badTags.put("27570::t1", Map.of("id", eventId + "_t1", "eventId", eventId, "teamNumber", 27570, "tag", "t1", "active", false, "createdBy", bobId));

            JsonObject bobReq = new JsonObject();
            bobReq.addProperty("hostEpoch", 1);
            bobReq.addProperty("snapshotRevision", 2);
            bobReq.add("snapshot", buildSnapshot(Map.of("team_tags", badTags)));
            bobReq.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of("team_tags", List.copyOf(badTags.keySet())))));
            var bobRes = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(bobReq),
                    r -> r.header("Authorization", "Bearer " + bobToken));
            assertThat(bobRes.code()).isEqualTo(200);

            jdbi.useHandle(h -> {
                assertThat(h.createQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = ? AND tag = 'bob_valid'").bind(0, eventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(h.createQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = ? AND tag = 't1'").bind(0, eventId).mapTo(Integer.class).one()).isZero();
                assertThat(h.createQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = ? AND tag = 'alice_tag'").bind(0, eventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(h.createQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = ? AND tag IN ('t15_over','preset_spoof','creator_spoof','bad.dot')").bind(0, eventId).mapTo(Integer.class).one()).isZero();
            });

            // Cold-standby replica: allows valid self-signed remote Host anchor + Host-endorsed member key
            var coldEvtRes = client.post("/api/events/external-sync", gson.toJson(Map.of(
                    "id", "cold_replica_evt", "name", "Cold", "inviteCode", "COLD88", "hostId", "remote_host_placeholder"
            )), r -> r.header("Authorization", "Bearer " + bobToken));
            assertThat(coldEvtRes.code()).isEqualTo(200);

            String remoteHostPub = Base64.getEncoder().encodeToString(remoteHostKp.getPublic().getEncoded());
            String bobPub = Base64.getEncoder().encodeToString(bobKp.getPublic().getEncoded());
            Signature s1 = Signature.getInstance("SHA256withECDSAinP1363Format");
            s1.initSign(remoteHostKp.getPrivate());
            s1.update(EcdsaRecordVerifier.buildMemberIdentityCanonicalPayload("cold_replica_evt", "remote_host_placeholder", "dev-h", remoteHostPub).getBytes(StandardCharsets.UTF_8));
            String hostSelfSig = Base64.getEncoder().encodeToString(s1.sign());

            Signature s2 = Signature.getInstance("SHA256withECDSAinP1363Format");
            s2.initSign(remoteHostKp.getPrivate());
            s2.update(EcdsaRecordVerifier.buildMemberIdentityCanonicalPayload("cold_replica_evt", bobId, "dev-b", bobPub).getBytes(StandardCharsets.UTF_8));
            String bobEndorseSig = Base64.getEncoder().encodeToString(s2.sign());

            JsonObject coldReq = new JsonObject();
            coldReq.addProperty("hostEpoch", 2);
            coldReq.addProperty("snapshotRevision", 1);
            coldReq.add("snapshot", buildSnapshot(Map.of("member_identities", Map.of(
                    "remote_host_placeholder::dev-h", Map.of("eventId", "cold_replica_evt", "userId", "remote_host_placeholder", "deviceId", "dev-h", "signingPubKeyHex", remoteHostPub, "hostPubKey", remoteHostPub, "hostSig", hostSelfSig),
                    bobId + "::dev-b", Map.of("eventId", "cold_replica_evt", "userId", bobId, "deviceId", "dev-b", "signingPubKeyHex", bobPub, "hostPubKey", remoteHostPub, "hostSig", bobEndorseSig)
            ))));
            var coldPut = client.put("/api/events/cold_replica_evt/crdt-state", gson.toJson(coldReq),
                    r -> r.header("Authorization", "Bearer " + bobToken));
            assertThat(coldPut.code()).isEqualTo(200);

            var coldGet = client.get("/api/events/cold_replica_evt/crdt-state",
                    r -> r.header("Authorization", "Bearer " + bobToken));
            Map<String, JsonObject> coldIds = CrdtProjectionService.extractTableRows(
                    JsonParser.parseString(coldGet.body().string()).getAsJsonObject().get("snapshot"), "member_identities");
            assertThat(coldIds).containsKeys("remote_host_placeholder::dev-h", bobId + "::dev-b");
        });
    }
}
