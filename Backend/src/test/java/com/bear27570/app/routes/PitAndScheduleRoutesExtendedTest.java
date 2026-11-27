package com.bear27570.app.routes;

import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.dao.ScheduleDao;
import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class PitAndScheduleRoutesExtendedTest {

    private RouteTestSupport support;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_pit_sched_ext");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    @Test
    void testScheduleReplacePreserveAssignmentsUpdateAndDelete() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            // 1. Seed initial schedule + assignment with scoutA
            String seedBatch = """
                {
                  "replace": false,
                  "items": [
                    {"id":"sched-m1","matchNumber":1,"tournamentLevel":"QUALIFICATION","red1":1111,"red2":2222,"blue1":3333,"blue2":4444}
                  ],
                  "assignments": [
                    {"matchNumber":1,"tournamentLevel":"QUALIFICATION","station":"red1","teamNumber":1111,"scoutId":"%s","scoutName":"ScoutA"}
                  ]
                }
                """.formatted(f.scoutAId);
            assertThat(client.post("/api/events/" + f.eventId + "/schedule/batch", seedBatch,
                    b -> b.header("Authorization", "Bearer " + f.hostToken)).code()).isEqualTo(200);

            // 2. Non-replace batch updates red1 teamNumber from 1111 -> 5555: MUST preserve existing scoutId/scoutName!
            // Also exercises matchNumber <= 0 skip and missing item id fallback
            String updateBatch = """
                {
                  "replace": false,
                  "items": [
                    {"matchNumber":0,"red1":9999},
                    {"matchNumber":1,"red1":5555,"red2":2222,"blue1":3333,"blue2":4444}
                  ]
                }
                """;
            var updRes = client.post("/api/events/" + f.eventId + "/schedule/batch", updateBatch,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(updRes.code()).isEqualTo(200);
            assertThat(JsonParser.parseString(updRes.body().string()).getAsJsonObject().get("count").getAsInt()).isEqualTo(1);

            support.jdbi.useExtension(ScheduleDao.class, dao -> {
                var a = dao.findAssignment(f.eventId, 1, "QUALIFICATION", "red1");
                assertThat(a).isNotNull();
                assertThat(a.getTeamNumber()).isEqualTo(5555);
                assertThat(a.getScoutId()).isEqualTo(f.scoutAId);
                assertThat(a.getScoutName()).isEqualTo("ScoutA");
            });

            // 3. PUT /assignments: non-host forbidden, missing array 400, valid update normalizes blank scoutId/scoutName to null
            assertThat(client.put("/api/events/" + f.eventId + "/assignments", "{\"assignments\":[]}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(403);
            assertThat(client.put("/api/events/" + f.eventId + "/assignments", "{}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken)).code()).isEqualTo(400);

            String putAssignments = """
                {
                  "assignments": [
                    {"matchNumber":0,"station":"red1","teamNumber":1},
                    {"matchNumber":1,"station":"","teamNumber":1},
                    {"matchNumber":1,"station":"red1","teamNumber":5555,"scoutId":"   ","scoutName":""},
                    {"id":"custom-asgn-1","matchNumber":2,"tournamentLevel":"PLAYOFF","station":"blue2","teamNumber":7777,"scoutId":"%s","scoutName":"ScoutB"}
                  ]
                }
                """.formatted(f.scoutBId);
            var putRes = client.put("/api/events/" + f.eventId + "/assignments", putAssignments,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(putRes.code()).isEqualTo(200);
            assertThat(JsonParser.parseString(putRes.body().string()).getAsJsonObject().get("count").getAsInt()).isEqualTo(2);

            support.jdbi.useExtension(ScheduleDao.class, dao -> {
                var cleared = dao.findAssignment(f.eventId, 1, "QUALIFICATION", "red1");
                assertThat(cleared.getScoutId()).isNull();
                assertThat(cleared.getScoutName()).isNull();

                var custom = dao.findAssignment(f.eventId, 2, "PLAYOFF", "blue2");
                assertThat(custom).isNotNull();
                assertThat(custom.getId()).isEqualTo("custom-asgn-1");
                assertThat(custom.getScoutId()).isEqualTo(f.scoutBId);
            });

            // 4. POST /schedule/batch with replace=true wipes old matches & assignments
            String replaceBatch = """
                {
                  "replace": true,
                  "items": [
                    {"matchNumber":10,"red1":101,"red2":102,"blue1":103,"blue2":104}
                  ],
                  "assignments": [
                    {"id":"asgn-10-r1","matchNumber":10,"station":"red1","teamNumber":101,"scoutId":"%s","scoutName":"Host"}
                  ]
                }
                """.formatted(f.hostId);
            assertThat(client.post("/api/events/" + f.eventId + "/schedule/batch", replaceBatch,
                    b -> b.header("Authorization", "Bearer " + f.hostToken)).code()).isEqualTo(200);

            support.jdbi.useExtension(ScheduleDao.class, dao -> {
                assertThat(dao.findSchedulesByEvent(f.eventId)).hasSize(1);
                assertThat(dao.findSchedulesByEvent(f.eventId).get(0).getMatchNumber()).isEqualTo(10);
                assertThat(dao.findAssignment(f.eventId, 2, "PLAYOFF", "blue2")).isNull();
            });

            // 5. DELETE /schedule: non-host forbidden, host clears everything
            assertThat(client.delete("/api/events/" + f.eventId + "/schedule", null,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(403);
            var delRes = client.delete("/api/events/" + f.eventId + "/schedule", null,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(delRes.code()).isEqualTo(200);

            support.jdbi.useExtension(ScheduleDao.class, dao -> {
                assertThat(dao.findSchedulesByEvent(f.eventId)).isEmpty();
                assertThat(dao.findAssignmentsByEvent(f.eventId)).isEmpty();
            });
        });
    }

    @Test
    void testPitRecordsSingleBatchNormalizationOfficialTeamsAndPhotoValidation() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            // 1. Non-member 403 on write endpoints
            assertThat(client.post("/api/events/" + f.eventId + "/pit-records", "{\"teamNumber\":27570}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)).code()).isEqualTo(403);
            assertThat(client.post("/api/events/" + f.eventId + "/pit-records/batch", "[]",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)).code()).isEqualTo(403);
            assertThat(client.post("/api/events/" + f.eventId + "/official-teams/sync", "[]",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)).code()).isEqualTo(403);
            assertThat(client.get("/api/events/" + f.eventId + "/official-teams",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)).code()).isEqualTo(403);

            // 2. Null payload 400 on single pit-record; blank eventId 400 on GET pit-records
            assertThat(client.post("/api/events/" + f.eventId + "/pit-records", "null",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);
            assertThat(client.get("/api/events/%20/pit-records",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);

            // 3. Single pit-record POST: auto-generates id, backfills scoutId/scoutName, normalizes BIOBUZZ endgame & clamps fields
            String overlongChassis = "18x18x18-".repeat(10); // > 64 chars
            String pitPayload = """
                {
                  "teamNumber": 27570,
                  "robotName": "Valkyrie",
                  "drivetrainType": "",
                  "weightLbs": -5.0,
                  "chassisSize": "  %s  ",
                  "claimedAutoScore": -10,
                  "claimedTeleopScore": 40,
                  "claimedTeleopCycles": -3,
                  "claimedTeleopPark": true,
                  "claimedFlowerNectars": 12,
                  "claimedFlowerBottomBonus": 7,
                  "claimedFlowerPollens": 2,
                  "claimedGardenBalls": 3,
                  "claimedEndgameScore": 0,
                  "claimedTotalScore": 0
                }
                """.formatted(overlongChassis);
            var postPitRes = client.post("/api/events/" + f.eventId + "/pit-records", pitPayload,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(postPitRes.code()).isEqualTo(200);
            JsonObject savedRec = JsonParser.parseString(postPitRes.body().string())
                    .getAsJsonObject().getAsJsonObject("record");
            assertThat(savedRec.get("id").getAsString()).isNotBlank();
            assertThat(savedRec.get("scoutId").getAsString()).isEqualTo(f.scoutAId);
            assertThat(savedRec.get("drivetrainType").getAsString()).isEqualTo("mecanum");
            assertThat(savedRec.get("weightLbs").getAsDouble()).isEqualTo(0.0);
            assertThat(savedRec.get("chassisSize").getAsString()).hasSize(64);
            assertThat(savedRec.get("claimedAutoScore").getAsInt()).isEqualTo(0);
            assertThat(savedRec.get("claimedTeleopCycles").getAsInt()).isEqualTo(0);
            assertThat(savedRec.get("claimedFlowerNectars").getAsInt()).isEqualTo(8);
            assertThat(savedRec.get("claimedFlowerBottomBonus").getAsInt()).isEqualTo(4);
            // 5 (park) + 8*2 (nectars) + 4*5 (bottomBonus) + 2*2 (pollens) + 3 (garden) = 48
            assertThat(savedRec.get("claimedEndgameScore").getAsInt()).isEqualTo(48);
            // 0 + 40 + 48 = 88
            assertThat(savedRec.get("claimedTotalScore").getAsInt()).isEqualTo(88);

            // 4. Batch pit sync: empty array returns count 0; populated batch normalizes & upserts
            var emptyBatchRes = client.post("/api/events/" + f.eventId + "/pit-records/batch", "[]",
                    b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(emptyBatchRes.code()).isEqualTo(200);
            assertThat(emptyBatchRes.body().string()).contains("\"count\":0");

            String batchPitJson = """
                [
                  {
                    "teamNumber": 11115,
                    "robotName": "GlutenFree",
                    "claimedAutoScore": 30,
                    "claimedTeleopScore": 50,
                    "claimedEndgameScore": -5,
                    "claimedTotalScore": 80,
                    "version": 1
                  },
                  {
                    "id": "pit-8417",
                    "teamNumber": 8417,
                    "robotName": "Lectric",
                    "claimedAutoScore": 25,
                    "claimedTeleopScore": 45,
                    "claimedEndgameScore": 15,
                    "claimedTotalScore": 85,
                    "version": 1
                  }
                ]
                """;
            var batchPitRes = client.post("/api/events/" + f.eventId + "/pit-records/batch", batchPitJson,
                    b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(batchPitRes.code()).isEqualTo(200);
            assertThat(batchPitRes.body().string()).contains("\"count\":2");

            support.jdbi.useExtension(PitScoutDao.class, dao -> {
                PitScoutingRecord r11115 = dao.findPitRecordByTeam(f.eventId, 11115);
                assertThat(r11115).isNotNull();
                assertThat(r11115.getClaimedEndgameScore()).isEqualTo(0);
                PitScoutingRecord r8417 = dao.findPitRecordByTeam(f.eventId, 8417);
                assertThat(r8417).isNotNull();
                assertThat(r8417.getClaimedEndgameScore()).isEqualTo(15);
                assertThat(r8417.getClaimedTotalScore()).isEqualTo(85);
            });

            // 5. Official teams sync (empty + non-empty) and GET /official-teams
            var emptyTeamsSync = client.post("/api/events/" + f.eventId + "/official-teams/sync", "[]",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(emptyTeamsSync.code()).isEqualTo(200);
            assertThat(emptyTeamsSync.body().string()).contains("\"count\":0");

            String teamsPayload = gson.toJson(List.of(
                    Map.of("teamNumber", 27570, "nameFull", "Team 27570", "robotName", "Valkyrie", "city", "Shanghai", "country", "China"),
                    Map.of("teamNumber", 11115, "nameFull", "Gluten Free", "robotName", "GF", "city", "Hollis", "country", "USA")
            ));
            var syncTeamsRes = client.post("/api/events/" + f.eventId + "/official-teams/sync", teamsPayload,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(syncTeamsRes.code()).isEqualTo(200);
            assertThat(syncTeamsRes.body().string()).contains("\"count\":2");

            var getTeamsRes = client.get("/api/events/" + f.eventId + "/official-teams",
                    b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(getTeamsRes.code()).isEqualTo(200);
            JsonArray teamsArr = JsonParser.parseString(getTeamsRes.body().string()).getAsJsonArray();
            assertThat(teamsArr).hasSize(2);
            // Sorted ascending by teamNumber
            assertThat(teamsArr.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(11115);
            assertThat(teamsArr.get(1).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);

            // 6. Photo validation & idempotent delete
            assertThat(client.post("/api/events/" + f.eventId + "/pit/photos", "null",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);
            assertThat(client.post("/api/events/" + f.eventId + "/pit/photos", "{\"key\":\"valid_k\",\"dataUrl\":\"\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);
            assertThat(client.post("/api/events/bad.evt/pit/photos", "{\"key\":\"valid_k\",\"dataUrl\":\"AAAA\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);
            assertThat(client.get("/api/events/bad.evt/pit/photos/valid_k").code()).isEqualTo(400);
            assertThat(client.delete("/api/events/bad.evt/pit/photos/valid_k", null,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)).code()).isEqualTo(400);

            // Raw base64 without data: prefix succeeds, and deleting absent key is idempotent 200
            String rawB64 = Base64.getEncoder().encodeToString("webp-raw".getBytes());
            var rawUpload = client.post("/api/events/" + f.eventId + "/pit/photos",
                    gson.toJson(Map.of("key", "raw_photo_1", "dataUrl", rawB64)),
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(rawUpload.code()).isEqualTo(200);

            var idempotentDel = client.delete("/api/events/" + f.eventId + "/pit/photos/never_existed", null,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(idempotentDel.code()).isEqualTo(200);
        });
    }

    @Test
    void testNormalizePitRecordNaNWeightAndComponentSumOverrideRules() {
        PitScoutingRecord rec = new PitScoutingRecord();
        rec.setWeightLbs(Double.NaN);
        rec.setClaimedAutoScore(20);
        rec.setClaimedTeleopScore(30);
        rec.setClaimedFlowerNectars(3);
        rec.setClaimedFlowerBottomBonus(1);
        // Old stale endgame=5 and old total=55 (20+30+5) -> structured endgame becomes 3*2 + 1*5 = 11 -> total MUST update to 61
        rec.setClaimedEndgameScore(5);
        rec.setClaimedTotalScore(55);
        PitScoutRoutes.normalizePitRecord(rec);

        assertThat(rec.getWeightLbs()).isEqualTo(0.0);
        assertThat(rec.getClaimedEndgameScore()).isEqualTo(11);
        assertThat(rec.getClaimedTotalScore()).isEqualTo(61);

        // Negative total without structured endgame clamps to 0
        PitScoutingRecord negRec = new PitScoutingRecord();
        negRec.setClaimedTotalScore(-20);
        negRec.setClaimedEndgameScore(-5);
        PitScoutRoutes.normalizePitRecord(negRec);
        assertThat(negRec.getClaimedEndgameScore()).isEqualTo(0);
        assertThat(negRec.getClaimedTotalScore()).isEqualTo(0);

        // Concurrent merge where componentSum > non-matching positive originalTotal -> bumps total to componentSum
        PitScoutingRecord mergeRec = new PitScoutingRecord();
        mergeRec.setClaimedAutoScore(40);
        mergeRec.setClaimedTeleopScore(50);
        mergeRec.setClaimedEndgameScore(20);
        mergeRec.setClaimedTotalScore(95);
        PitScoutRoutes.normalizePitRecord(mergeRec);
        assertThat(mergeRec.getClaimedTotalScore()).isEqualTo(110);
    }
}
