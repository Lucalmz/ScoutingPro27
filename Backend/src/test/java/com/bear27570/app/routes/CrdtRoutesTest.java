package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
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

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CrdtRoutesTest {

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
        String url = "jdbc:h2:mem:test_crdt_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        try {
            if (apiRoutes != null) {
                apiRoutes.shutdown();
            }
            JdbiConfig.closeDataSources();
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) {
                System.clearProperty("scouting.data.dir");
            } else {
                System.setProperty("scouting.data.dir", prevDataDir);
            }
        }
    }

    private Map<?, ?> registerUser(HttpClient client, String username) throws Exception {
        var res = client.post("/api/user/register",
                gson.toJson(Map.of("username", username, "password", "Pass123!")));
        assertThat(res.code()).isEqualTo(200);
        return gson.fromJson(res.body().string(), Map.class);
    }

    private Map<?, ?> createEvent(HttpClient client, String token, String name) throws Exception {
        var res = client.post("/api/events", gson.toJson(Map.of("name", name)),
                req -> req.header("Authorization", "Bearer " + token));
        assertThat(res.code()).isEqualTo(200);
        return gson.fromJson(res.body().string(), Map.class);
    }

    private static JsonArray cell(Object primitive) {
        JsonArray arr = new JsonArray();
        arr.add(new Gson().toJsonTree(primitive));
        arr.add("Nn1JUF----2FnHIC");
        return arr;
    }

    private static JsonArray wrapRow(Map<String, Object> cells) {
        JsonObject cellsObj = new JsonObject();
        for (Map.Entry<String, Object> entry : cells.entrySet()) {
            if (entry.getValue() != null) {
                cellsObj.add(entry.getKey(), cell(entry.getValue()));
            }
        }
        JsonArray rowStamp = new JsonArray();
        rowStamp.add(cellsObj);
        rowStamp.add("Nn1JUF----2FnHIC");
        return rowStamp;
    }

    private static JsonArray wrapTable(Map<String, JsonArray> rows) {
        JsonObject rowsObj = new JsonObject();
        for (Map.Entry<String, JsonArray> entry : rows.entrySet()) {
            rowsObj.add(entry.getKey(), entry.getValue());
        }
        JsonArray tableStamp = new JsonArray();
        tableStamp.add(rowsObj);
        tableStamp.add("Nn1JUF----2FnHIC");
        return tableStamp;
    }

    private static JsonArray buildSnapshot(Map<String, Map<String, Map<String, Object>>> tables) {
        JsonObject tablesObj = new JsonObject();
        for (Map.Entry<String, Map<String, Map<String, Object>>> tableEntry : tables.entrySet()) {
            Map<String, JsonArray> wrappedRows = new LinkedHashMap<>();
            for (Map.Entry<String, Map<String, Object>> rowEntry : tableEntry.getValue().entrySet()) {
                wrappedRows.put(rowEntry.getKey(), wrapRow(rowEntry.getValue()));
            }
            tablesObj.add(tableEntry.getKey(), wrapTable(wrappedRows));
        }
        JsonArray tablesStamp = new JsonArray();
        tablesStamp.add(tablesObj);
        tablesStamp.add("Nn1JUF----2FnHIC");

        JsonArray valuesStamp = new JsonArray();
        valuesStamp.add(new JsonObject());
        valuesStamp.add("");

        JsonArray root = new JsonArray();
        root.add(tablesStamp);
        root.add(valuesStamp);
        return root;
    }

    private static Map<String, Map<String, Map<String, Object>>> createBaselineTables(
            String eventId,
            String aliceId,
            boolean fastTagActive
    ) {
        Map<String, Map<String, Map<String, Object>>> tables = new LinkedHashMap<>();

        tables.put("pit_records", Map.of(
                "27570", new LinkedHashMap<>(Map.ofEntries(
                        Map.entry("id", "pit-27570"),
                        Map.entry("eventId", eventId),
                        Map.entry("teamNumber", 27570),
                        Map.entry("scoutId", aliceId),
                        Map.entry("scoutName", "LeadAlice"),
                        Map.entry("robotName", "Polaris"),
                        Map.entry("drivetrainType", "mecanum"),
                        Map.entry("weightLbs", 31.5),
                        Map.entry("chassisSize", "compact"),
                        Map.entry("ballCompatibility", "universal"),
                        Map.entry("launcherType", "Turret"),
                        Map.entry("flowerMechanism", "Lift"),
                        Map.entry("hasColorSensor", true),
                        Map.entry("hasDescoreMech", true),
                        Map.entry("hasApriltagVision", true),
                        Map.entry("odometryType", "pinpoint"),
                        Map.entry("claimedAutoScore", 60),
                        Map.entry("claimedTeleopCycles", 7),
                        Map.entry("claimedTeleopScore", 80),
                        Map.entry("claimedEndgameScore", 15),
                        Map.entry("claimedTotalScore", 155),
                        Map.entry("version", 2),
                        Map.entry("isDeleted", false)
                ))
        ));

        tables.put("pit_photo_keys", Map.of(
                "27570::photo_a", Map.of("teamNumber", 27570, "photoKey", "photo_a", "active", true, "addedBy", aliceId),
                "27570::photo_b", Map.of("teamNumber", 27570, "photoKey", "photo_b", "active", false, "addedBy", aliceId)
        ));

        tables.put("team_tags", Map.of(
                "27570::fast", Map.of(
                        "id", "tag-1",
                        "eventId", eventId,
                        "teamNumber", 27570,
                        "tag", "fast",
                        "color", "green",
                        "isPreset", false,
                        "active", fastTagActive,
                        "createdBy", aliceId
                ),
                "27570::slow", Map.of(
                        "id", "tag-2",
                        "eventId", eventId,
                        "teamNumber", 27570,
                        "tag", "slow",
                        "color", "red",
                        "isPreset", false,
                        "active", false,
                        "createdBy", aliceId
                )
        ));

        tables.put("custom_fields", Map.of(
                "cf-1", Map.ofEntries(
                        Map.entry("id", "cf-1"),
                        Map.entry("eventId", eventId),
                        Map.entry("target", "MATCH"),
                        Map.entry("phase", "teleop"),
                        Map.entry("name", "Driver Skill"),
                        Map.entry("fieldKey", "driver_skill"),
                        Map.entry("fieldType", "level"),
                        Map.entry("required", false),
                        Map.entry("orderSeq", 1),
                        Map.entry("orderKey", "a001"),
                        Map.entry("isActive", true),
                        Map.entry("isDeleted", false)
                )
        ));

        tables.put("schedules", Map.of(
                "QUALIFICATION_1", Map.of(
                        "id", eventId + "_M1",
                        "eventId", eventId,
                        "matchNumber", 1,
                        "tournamentLevel", "QUALIFICATION",
                        "red1", 27570,
                        "red2", 11111,
                        "blue1", 22222,
                        "blue2", 33333,
                        "isDeleted", false
                )
        ));

        tables.put("assignments", Map.of(
                "QUALIFICATION_1_red1", Map.of(
                        "id", eventId + "_QUALIFICATION_1_red1",
                        "eventId", eventId,
                        "matchNumber", 1,
                        "tournamentLevel", "QUALIFICATION",
                        "station", "red1",
                        "teamNumber", 27570,
                        "scoutId", aliceId,
                        "scoutName", "LeadAlice",
                        "isDeleted", false
                )
        ));

        tables.put("scouting_records", Map.of(
                "rec-1", Map.ofEntries(
                        Map.entry("id", "rec-1"),
                        Map.entry("eventId", eventId),
                        Map.entry("scoutId", aliceId),
                        Map.entry("scoutName", "LeadAlice"),
                        Map.entry("matchNumber", 1),
                        Map.entry("teamNumber", 27570),
                        Map.entry("autoScore", 25),
                        Map.entry("teleopScore", 45),
                        Map.entry("endgameScore", 15),
                        Map.entry("totalScore", 85),
                        Map.entry("notes", "strong auto"),
                        Map.entry("rawDataJson", "{}"),
                        Map.entry("isBroken", false),
                        Map.entry("version", 1),
                        Map.entry("isDeleted", false),
                        Map.entry("authorPubKey", "ecdsaPubBase64"),
                        Map.entry("authorSig", "ecdsaSigBase64")
                )
        ));

        return tables;
    }

    @Test
    void testFreshGetAndNonMember403() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "alice_crdt");
            String aliceToken = (String) alice.get("token");
            String eventId = (String) createEvent(client, aliceToken, "CRDT Empty Event").get("id");

            Map<?, ?> outsider = registerUser(client, "outsider_crdt");
            String outsiderToken = (String) outsider.get("token");

            var freshGet = client.get("/api/events/" + eventId + "/crdt-state",
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(freshGet.code()).isEqualTo(200);
            JsonObject freshJson = JsonParser.parseString(freshGet.body().string()).getAsJsonObject();
            assertThat(freshJson.get("exists").getAsBoolean()).isFalse();
            assertThat(freshJson.get("snapshot").isJsonNull()).isTrue();

            var forbiddenGet = client.get("/api/events/" + eventId + "/crdt-state",
                    req -> req.header("Authorization", "Bearer " + outsiderToken));
            assertThat(forbiddenGet.code()).isEqualTo(403);

            var forbiddenPut = client.put("/api/events/" + eventId + "/crdt-state",
                    "{}",
                    req -> req.header("Authorization", "Bearer " + outsiderToken));
            assertThat(forbiddenPut.code()).isEqualTo(403);
        });
    }

    @Test
    void testDirtyRowProjectionAcrossAllTablesAndIncrementalIsolation() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "alice_proj");
            String aliceId = (String) alice.get("id");
            String aliceToken = (String) alice.get("token");
            String eventId = (String) createEvent(client, aliceToken, "Projection Event").get("id");

            JsonArray snapshot1 = buildSnapshot(createBaselineTables(eventId, aliceId, true));
            JsonObject req1 = new JsonObject();
            req1.addProperty("hostEpoch", 1);
            req1.addProperty("snapshotRevision", 1);
            req1.add("snapshot", snapshot1);
            req1.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "pit_records", List.of("27570"),
                    "pit_photo_keys", List.of("27570::photo_a", "27570::photo_b"),
                    "team_tags", List.of("27570::fast", "27570::slow"),
                    "custom_fields", List.of("cf-1"),
                    "schedules", List.of("QUALIFICATION_1"),
                    "assignments", List.of("QUALIFICATION_1_red1"),
                    "scouting_records", List.of("rec-1")
            ))));

            var put1 = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req1),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(put1.code()).isEqualTo(200);
            JsonObject res1 = JsonParser.parseString(put1.body().string()).getAsJsonObject();
            assertThat(res1.get("saved").getAsBoolean()).isTrue();

            // Verify all 6 relational tables in H2
            jdbi.useHandle(h -> {
                Map<String, Object> pitRow = h.createQuery(
                        "SELECT robot_name, drivetrain_type, weight_lbs, launcher_type, photo_keys FROM pit_scouting_records WHERE event_id = ? AND team_number = 27570")
                        .bind(0, eventId).mapToMap().one();
                assertThat(pitRow.get("robot_name")).isEqualTo("Polaris");
                assertThat(((Number) pitRow.get("weight_lbs")).doubleValue()).isEqualTo(31.5);
                assertThat(pitRow.get("launcher_type")).isEqualTo("Turret");
                assertThat((String) pitRow.get("photo_keys")).contains("photo_a").doesNotContain("photo_b");

                List<String> tags = h.createQuery("SELECT tag FROM team_tags WHERE event_id = ? AND team_number = 27570")
                        .bind(0, eventId).mapTo(String.class).list();
                assertThat(tags).containsExactly("fast");

                String fieldKey = h.createQuery("SELECT field_key FROM event_custom_fields WHERE id = 'cf-1'")
                        .mapTo(String.class).one();
                assertThat(fieldKey).isEqualTo("driver_skill");

                Integer schedRed1 = h.createQuery("SELECT red1 FROM match_schedules WHERE event_id = ? AND match_number = 1")
                        .bind(0, eventId).mapTo(Integer.class).one();
                assertThat(schedRed1).isEqualTo(27570);

                String assignedScout = h.createQuery("SELECT scout_id FROM scout_assignments WHERE event_id = ? AND match_number = 1 AND station = 'red1'")
                        .bind(0, eventId).mapTo(String.class).one();
                assertThat(assignedScout).isEqualTo(aliceId);

                Map<String, Object> sigRow = h.createQuery("SELECT author_pub_key, author_sig, total_score FROM scouting_records WHERE id = 'rec-1'")
                        .mapToMap().one();
                assertThat(sigRow.get("author_pub_key")).isEqualTo("ecdsaPubBase64");
                assertThat(sigRow.get("author_sig")).isEqualTo("ecdsaSigBase64");
                assertThat(((Number) sigRow.get("total_score")).intValue()).isEqualTo(85);
            });

            // 2. Second PUT touches ONLY 1 row in pit_records -> verify incremental dirty-row projection counts
            Map<String, Map<String, Map<String, Object>>> updatedTables = createBaselineTables(eventId, aliceId, true);
            updatedTables.get("pit_records").get("27570").put("weightLbs", 33.0);
            JsonObject req2 = new JsonObject();
            req2.addProperty("hostEpoch", 1);
            req2.addProperty("snapshotRevision", 2);
            req2.add("snapshot", buildSnapshot(updatedTables));
            req2.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "pit_records", List.of("27570")
            ))));

            var put2 = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(req2),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(put2.code()).isEqualTo(200);
            JsonObject res2 = JsonParser.parseString(put2.body().string()).getAsJsonObject();
            JsonObject counts2 = res2.getAsJsonObject("projectedCounts");
            assertThat(counts2.get("pit_records").getAsInt()).isEqualTo(1);
            assertThat(counts2.get("team_tags").getAsInt()).isEqualTo(0);
            assertThat(counts2.get("custom_fields").getAsInt()).isEqualTo(0);
            assertThat(counts2.get("schedules").getAsInt()).isEqualTo(0);
            assertThat(counts2.get("assignments").getAsInt()).isEqualTo(0);
            assertThat(counts2.get("scouting_records").getAsInt()).isEqualTo(0);

            Double newWeight = jdbi.withHandle(h -> h.createQuery(
                    "SELECT weight_lbs FROM pit_scouting_records WHERE event_id = ? AND team_number = 27570")
                    .bind(0, eventId).mapTo(Double.class).one());
            assertThat(newWeight).isEqualTo(33.0);
        });
    }

    @Test
    void testSoftDeleteTagProjectionRevisionConflictAndSharedMemberAccess() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "lead_alice");
            String aliceId = (String) alice.get("id");
            String aliceToken = (String) alice.get("token");
            Map<?, ?> evt = createEvent(client, aliceToken, "Shared H2 Event");
            String eventId = (String) evt.get("id");
            String inviteCode = (String) evt.get("inviteCode");

            Map<?, ?> bob = registerUser(client, "assistant_bob");
            String bobId = (String) bob.get("id");
            String bobToken = (String) bob.get("token");

            // Bob joins the event on shared DB (not host_id)
            var joinRes = client.post("/api/events/join", gson.toJson(Map.of("inviteCode", inviteCode)),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(joinRes.code()).isEqualTo(200);

            // Bob writes offline schedule & match record while LeadAlice is not logged in yet
            Map<String, Map<String, Map<String, Object>>> initialTables = createBaselineTables(eventId, aliceId, true);
            JsonObject putBob = new JsonObject();
            putBob.addProperty("hostEpoch", 1);
            putBob.addProperty("snapshotRevision", 5);
            putBob.add("snapshot", buildSnapshot(initialTables));
            putBob.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "team_tags", List.of("27570::fast"),
                    "assignments", List.of("QUALIFICATION_1_red1")
            ))));

            var bobPutRes = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(putBob),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(bobPutRes.code()).isEqualTo(200);

            // Stale revision (3 < 5 on same epoch 1) MUST be rejected with 409 Conflict
            JsonObject stalePut = new JsonObject();
            stalePut.addProperty("hostEpoch", 1);
            stalePut.addProperty("snapshotRevision", 3);
            stalePut.add("snapshot", buildSnapshot(createBaselineTables(eventId, bobId, true)));
            var staleRes = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(stalePut),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(staleRes.code()).isEqualTo(409);

            // Alice (higher Epoch=2) soft-deletes '27570::fast' (active: false) -> deleted from H2 team_tags while keeping CRDT tombstone
            JsonObject softDelPut = new JsonObject();
            softDelPut.addProperty("hostEpoch", 2);
            softDelPut.addProperty("snapshotRevision", 1);
            softDelPut.add("snapshot", buildSnapshot(createBaselineTables(eventId, aliceId, false)));
            softDelPut.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "team_tags", List.of("27570::fast")
            ))));
            var alicePutRes = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(softDelPut),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(alicePutRes.code()).isEqualTo(200);

            Integer tagCount = jdbi.withHandle(h -> h.createQuery(
                    "SELECT COUNT(*) FROM team_tags WHERE event_id = ? AND team_number = 27570 AND tag = 'fast'")
                    .bind(0, eventId).mapTo(Integer.class).one());
            assertThat(tagCount).isZero();

            // LeadAlice loads persisted snapshot from shared H2 (tombstone row remains inside CRDT JSON)
            var aliceGet = client.get("/api/events/" + eventId + "/crdt-state",
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(aliceGet.code()).isEqualTo(200);
            JsonObject loaded = JsonParser.parseString(aliceGet.body().string()).getAsJsonObject();
            assertThat(loaded.get("exists").getAsBoolean()).isTrue();
            assertThat(loaded.get("hostEpoch").getAsInt()).isEqualTo(2);
            assertThat(loaded.getAsJsonArray("snapshot").toString()).contains("27570::fast");
        });
    }

    @Test
    void testNonHostMemberCannotProjectForgedOrUnsignedOtherScoutRecordViaCrdtState() throws Exception {
        java.security.KeyPairGenerator kpg = java.security.KeyPairGenerator.getInstance("EC");
        kpg.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
        java.security.KeyPair aliceKp = kpg.generateKeyPair();
        java.security.KeyPair bobKp = kpg.generateKeyPair();

        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "host_alice_sec");
            String aliceId = (String) alice.get("id");
            String aliceToken = (String) alice.get("token");
            Map<?, ?> evt = createEvent(client, aliceToken, "CRDT Sec Event");
            String eventId = (String) evt.get("id");
            String inviteCode = (String) evt.get("inviteCode");

            Map<?, ?> bob = registerUser(client, "member_bob_sec");
            String bobId = (String) bob.get("id");
            String bobToken = (String) bob.get("token");
            var joinRes = client.post("/api/events/join", gson.toJson(Map.of("inviteCode", inviteCode)),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(joinRes.code()).isEqualTo(200);

            // 1. Host Alice signs and projects her record rec-alice-1
            ScoutingRecord aliceDto = new ScoutingRecord();
            aliceDto.setId("rec-alice-1");
            aliceDto.setEventId(eventId);
            aliceDto.setScoutId(aliceId);
            aliceDto.setMatchNumber(1);
            aliceDto.setTeamNumber(27570);
            aliceDto.setAutoScore(25);
            aliceDto.setTeleopScore(45);
            aliceDto.setEndgameScore(15);
            aliceDto.setTotalScore(85);
            aliceDto.setNotes("alice genuine");
            aliceDto.setRawData("{}");
            aliceDto.setIsBroken(false);
            aliceDto.setIsDeleted(false);

            String alicePub = java.util.Base64.getEncoder().encodeToString(aliceKp.getPublic().getEncoded());
            java.security.Signature aliceSig = java.security.Signature.getInstance("SHA256withECDSAinP1363Format");
            aliceSig.initSign(aliceKp.getPrivate());
            aliceSig.update(EcdsaRecordVerifier.buildCanonicalPayload(aliceDto).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String aliceSigB64 = java.util.Base64.getEncoder().encodeToString(aliceSig.sign());

            Map<String, Map<String, Map<String, Object>>> hostTables = new LinkedHashMap<>();
            hostTables.put("scouting_records", Map.of(
                    "rec-alice-1", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-alice-1"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", aliceId),
                            Map.entry("scoutName", "HostAlice"),
                            Map.entry("matchNumber", 1),
                            Map.entry("teamNumber", 27570),
                            Map.entry("autoScore", 25),
                            Map.entry("teleopScore", 45),
                            Map.entry("endgameScore", 15),
                            Map.entry("totalScore", 85),
                            Map.entry("notes", "alice genuine"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 1),
                            Map.entry("isDeleted", false),
                            Map.entry("authorPubKey", alicePub),
                            Map.entry("authorSig", aliceSigB64)
                    ))
            ));
            JsonObject hostReq = new JsonObject();
            hostReq.addProperty("hostEpoch", 1);
            hostReq.addProperty("snapshotRevision", 1);
            hostReq.add("snapshot", buildSnapshot(hostTables));
            hostReq.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of("scouting_records", List.of("rec-alice-1")))));

            var hostPut = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(hostReq),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(hostPut.code()).isEqualTo(200);

            // 2. Non-host member Bob tries to project:
            //    (a) unsigned record claiming scoutId = aliceId
            //    (b) tampered overwrite of rec-alice-1 signed by Bob's own keypair
            ScoutingRecord bobTamperDto = new ScoutingRecord();
            bobTamperDto.setId("rec-alice-1");
            bobTamperDto.setEventId(eventId);
            bobTamperDto.setScoutId(aliceId);
            bobTamperDto.setMatchNumber(1);
            bobTamperDto.setTeamNumber(27570);
            bobTamperDto.setAutoScore(25);
            bobTamperDto.setTeleopScore(45);
            bobTamperDto.setEndgameScore(15);
            bobTamperDto.setTotalScore(999);
            bobTamperDto.setNotes("tampered by bob");
            bobTamperDto.setRawData("{}");
            bobTamperDto.setIsBroken(false);
            bobTamperDto.setIsDeleted(false);

            String bobPub = java.util.Base64.getEncoder().encodeToString(bobKp.getPublic().getEncoded());
            java.security.Signature bobSig = java.security.Signature.getInstance("SHA256withECDSAinP1363Format");
            bobSig.initSign(bobKp.getPrivate());
            bobSig.update(EcdsaRecordVerifier.buildCanonicalPayload(bobTamperDto).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String bobSigB64 = java.util.Base64.getEncoder().encodeToString(bobSig.sign());

            Map<String, Map<String, Map<String, Object>>> bobTables = new LinkedHashMap<>();
            bobTables.put("scouting_records", Map.of(
                    "rec-alice-1", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-alice-1"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", aliceId),
                            Map.entry("scoutName", "HostAlice"),
                            Map.entry("matchNumber", 1),
                            Map.entry("teamNumber", 27570),
                            Map.entry("autoScore", 25),
                            Map.entry("teleopScore", 45),
                            Map.entry("endgameScore", 15),
                            Map.entry("totalScore", 999),
                            Map.entry("notes", "tampered by bob"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 2),
                            Map.entry("isDeleted", false),
                            Map.entry("authorPubKey", bobPub),
                            Map.entry("authorSig", bobSigB64)
                    )),
                    "rec-alice-unsigned-forge", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-alice-unsigned-forge"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", aliceId),
                            Map.entry("scoutName", "HostAlice"),
                            Map.entry("matchNumber", 2),
                            Map.entry("teamNumber", 27570),
                            Map.entry("autoScore", 10),
                            Map.entry("teleopScore", 20),
                            Map.entry("endgameScore", 10),
                            Map.entry("totalScore", 40),
                            Map.entry("notes", "unsigned forge"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 1),
                            Map.entry("isDeleted", false)
                    ))
            ));

            JsonObject bobReq = new JsonObject();
            bobReq.addProperty("hostEpoch", 1);
            bobReq.addProperty("snapshotRevision", 2);
            bobReq.add("snapshot", buildSnapshot(bobTables));
            bobReq.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "scouting_records", List.of("rec-alice-1", "rec-alice-unsigned-forge")
            ))));

            var bobPut = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(bobReq),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(bobPut.code()).isEqualTo(200);
            JsonObject bobResJson = JsonParser.parseString(bobPut.body().string()).getAsJsonObject();
            assertThat(bobResJson.getAsJsonObject("projectedCounts").get("scouting_records").getAsInt()).isZero();

            jdbi.useHandle(h -> {
                Integer tamperedScore = h.createQuery("SELECT total_score FROM scouting_records WHERE id = 'rec-alice-1'")
                        .mapTo(Integer.class).one();
                assertThat(tamperedScore).isEqualTo(85);
                Integer forgedCount = h.createQuery("SELECT COUNT(*) FROM scouting_records WHERE id = 'rec-alice-unsigned-forge'")
                        .mapTo(Integer.class).one();
                assertThat(forgedCount).isZero();
            });

            // 3. Verify persisted CRDT snapshot itself was sanitized (no forged row, genuine Alice row preserved)
            var getAfterBob = client.get("/api/events/" + eventId + "/crdt-state",
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(getAfterBob.code()).isEqualTo(200);
            JsonObject loadedAfterBob = JsonParser.parseString(getAfterBob.body().string()).getAsJsonObject();
            JsonElement sanitizedSnapshot = loadedAfterBob.get("snapshot");
            Map<String, JsonObject> persistedScouting = com.bear27570.app.service.CrdtProjectionService
                    .extractTableRows(sanitizedSnapshot, "scouting_records");
            assertThat(persistedScouting).doesNotContainKey("rec-alice-unsigned-forge");
            assertThat(persistedScouting).containsKey("rec-alice-1");
            assertThat(persistedScouting.get("rec-alice-1").get("totalScore").getAsInt()).isEqualTo(85);
            assertThat(persistedScouting.get("rec-alice-1").get("notes").getAsString()).isEqualTo("alice genuine");
            assertThat(persistedScouting.get("rec-alice-1").get("authorPubKey").getAsString()).isEqualTo(alicePub);

            // 4. Host Alice reloads that snapshot and performs a fullProjection PUT -> zero laundering into H2
            JsonObject hostReloadReq = new JsonObject();
            hostReloadReq.addProperty("hostEpoch", 1);
            hostReloadReq.addProperty("snapshotRevision", 3);
            hostReloadReq.addProperty("fullProjection", true);
            hostReloadReq.add("snapshot", sanitizedSnapshot);
            var hostReplay = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(hostReloadReq),
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(hostReplay.code()).isEqualTo(200);

            jdbi.useHandle(h -> {
                Integer scoreAfterReplay = h.createQuery("SELECT total_score FROM scouting_records WHERE id = 'rec-alice-1'")
                        .mapTo(Integer.class).one();
                assertThat(scoreAfterReplay).isEqualTo(85);
                Integer forgedAfterReplay = h.createQuery("SELECT COUNT(*) FROM scouting_records WHERE id = 'rec-alice-unsigned-forge'")
                        .mapTo(Integer.class).one();
                assertThat(forgedAfterReplay).isZero();
            });
        });
    }

    @Test
    void testNonHostCrdtPutStripsSmuggledRowsOutsideDirtyRowsAndPreventsTruncation() throws Exception {
        java.security.KeyPairGenerator kpg = java.security.KeyPairGenerator.getInstance("EC");
        kpg.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
        java.security.KeyPair aliceKp = kpg.generateKeyPair();

        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> alice = registerUser(client, "host_alice_smug");
            String aliceId = (String) alice.get("id");
            String aliceToken = (String) alice.get("token");
            Map<?, ?> evt = createEvent(client, aliceToken, "CRDT Smuggling Guard Event");
            String eventId = (String) evt.get("id");
            String inviteCode = (String) evt.get("inviteCode");

            Map<?, ?> bob = registerUser(client, "member_bob_smug");
            String bobId = (String) bob.get("id");
            String bobToken = (String) bob.get("token");
            var joinRes = client.post("/api/events/join", gson.toJson(Map.of("inviteCode", inviteCode)),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(joinRes.code()).isEqualTo(200);

            ScoutingRecord aliceDto = new ScoutingRecord();
            aliceDto.setId("rec-alice-1");
            aliceDto.setEventId(eventId);
            aliceDto.setScoutId(aliceId);
            aliceDto.setMatchNumber(1);
            aliceDto.setTeamNumber(27570);
            aliceDto.setAutoScore(20);
            aliceDto.setTeleopScore(50);
            aliceDto.setEndgameScore(15);
            aliceDto.setTotalScore(85);
            aliceDto.setNotes("alice original");
            aliceDto.setRawData("{}");
            aliceDto.setIsBroken(false);
            aliceDto.setIsDeleted(false);

            String alicePub = java.util.Base64.getEncoder().encodeToString(aliceKp.getPublic().getEncoded());
            java.security.Signature aliceSig = java.security.Signature.getInstance("SHA256withECDSAinP1363Format");
            aliceSig.initSign(aliceKp.getPrivate());
            aliceSig.update(EcdsaRecordVerifier.buildCanonicalPayload(aliceDto).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String aliceSigB64 = java.util.Base64.getEncoder().encodeToString(aliceSig.sign());

            Map<String, Map<String, Map<String, Object>>> hostTables = new LinkedHashMap<>();
            hostTables.put("scouting_records", Map.of(
                    "rec-alice-1", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-alice-1"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", aliceId),
                            Map.entry("scoutName", "HostAlice"),
                            Map.entry("matchNumber", 1),
                            Map.entry("teamNumber", 27570),
                            Map.entry("autoScore", 20),
                            Map.entry("teleopScore", 50),
                            Map.entry("endgameScore", 15),
                            Map.entry("totalScore", 85),
                            Map.entry("notes", "alice original"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 1),
                            Map.entry("isDeleted", false),
                            Map.entry("authorPubKey", alicePub),
                            Map.entry("authorSig", aliceSigB64)
                    ))
            ));
            JsonObject hostReq = new JsonObject();
            hostReq.addProperty("hostEpoch", 1);
            hostReq.addProperty("snapshotRevision", 1);
            hostReq.add("snapshot", buildSnapshot(hostTables));
            hostReq.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of("scouting_records", List.of("rec-alice-1")))));
            assertThat(client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(hostReq),
                    req -> req.header("Authorization", "Bearer " + aliceToken)).code()).isEqualTo(200);

            // Non-Host Bob sends snapshot omitting rec-alice-1 (truncation attempt) and smuggling rec-smuggled
            // while keeping dirtyRows empty {} (except bob's own legitimate record rec-bob-own)
            Map<String, Map<String, Map<String, Object>>> bobTables = new LinkedHashMap<>();
            bobTables.put("scouting_records", Map.of(
                    "rec-smuggled", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-smuggled"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", aliceId),
                            Map.entry("scoutName", "HostAlice"),
                            Map.entry("matchNumber", 3),
                            Map.entry("teamNumber", 11115),
                            Map.entry("autoScore", 10),
                            Map.entry("teleopScore", 30),
                            Map.entry("endgameScore", 5),
                            Map.entry("totalScore", 45),
                            Map.entry("notes", "smuggled unsigned"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 1),
                            Map.entry("isDeleted", false)
                    )),
                    "rec-bob-own", new LinkedHashMap<>(Map.ofEntries(
                            Map.entry("id", "rec-bob-own"),
                            Map.entry("eventId", eventId),
                            Map.entry("scoutId", bobId),
                            Map.entry("scoutName", "MemberBob"),
                            Map.entry("matchNumber", 2),
                            Map.entry("teamNumber", 27570),
                            Map.entry("autoScore", 12),
                            Map.entry("teleopScore", 24),
                            Map.entry("endgameScore", 5),
                            Map.entry("totalScore", 41),
                            Map.entry("notes", "bob own"),
                            Map.entry("rawDataJson", "{}"),
                            Map.entry("isBroken", false),
                            Map.entry("version", 1),
                            Map.entry("isDeleted", false)
                    ))
            ));
            JsonObject bobReq = new JsonObject();
            bobReq.addProperty("hostEpoch", 1);
            bobReq.addProperty("snapshotRevision", 2);
            bobReq.add("snapshot", buildSnapshot(bobTables));
            bobReq.add("dirtyRows", JsonParser.parseString(gson.toJson(Map.of(
                    "scouting_records", List.of("rec-bob-own")
            ))));

            var bobPut = client.put("/api/events/" + eventId + "/crdt-state", gson.toJson(bobReq),
                    req -> req.header("Authorization", "Bearer " + bobToken));
            assertThat(bobPut.code()).isEqualTo(200);

            var getRes = client.get("/api/events/" + eventId + "/crdt-state",
                    req -> req.header("Authorization", "Bearer " + aliceToken));
            assertThat(getRes.code()).isEqualTo(200);
            JsonElement persistedSnap = JsonParser.parseString(getRes.body().string()).getAsJsonObject().get("snapshot");
            Map<String, JsonObject> persistedRows = com.bear27570.app.service.CrdtProjectionService
                    .extractTableRows(persistedSnap, "scouting_records");

            assertThat(persistedRows).doesNotContainKey("rec-smuggled");
            assertThat(persistedRows).containsKeys("rec-alice-1", "rec-bob-own");
            assertThat(persistedRows.get("rec-alice-1").get("totalScore").getAsInt()).isEqualTo(85);
            assertThat(persistedRows.get("rec-alice-1").get("notes").getAsString()).isEqualTo("alice original");

            jdbi.useHandle(h -> {
                assertThat(h.createQuery("SELECT COUNT(*) FROM scouting_records WHERE id = 'rec-smuggled'")
                        .mapTo(Integer.class).one()).isZero();
                assertThat(h.createQuery("SELECT total_score FROM scouting_records WHERE id = 'rec-alice-1'")
                        .mapTo(Integer.class).one()).isEqualTo(85);
                assertThat(h.createQuery("SELECT total_score FROM scouting_records WHERE id = 'rec-bob-own'")
                        .mapTo(Integer.class).one()).isEqualTo(41);
            });
        });
    }
}
