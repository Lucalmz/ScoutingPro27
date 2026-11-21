package com.bear27570.app.routes;

import com.bear27570.app.util.AESUtil;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CrdtRoutesTest {

    private Jdbi jdbi;
    private Javalin app;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() throws Exception {
        AESUtil.initMasterKey();
        String url = "jdbc:h2:mem:test_crdt_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        app = Javalin.create(config -> new ApiRoutes(jdbi).register(config.routes));
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
}
