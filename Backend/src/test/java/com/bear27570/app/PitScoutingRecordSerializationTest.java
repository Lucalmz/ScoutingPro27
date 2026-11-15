package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import com.bear27570.app.routes.ApiRoutes;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PitScoutingRecordSerializationTest {

    private Jdbi jdbi;
    private Gson gson;
    private String eventId = "evt_photo_test";

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_pit_serialization_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = JdbiConfig.create(url, "sa", "");
        gson = new Gson();

        // Seed user & event
        jdbi.useExtension(UserDao.class, dao -> {
            User u = new User("user_pit_1", "scoutuser");
            u.setPassword("pass");
            dao.upsert(u);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent evt = new ScoutingEvent();
            evt.setId(eventId);
            evt.setName("Pit Test Event");
            evt.setInviteCode("PITSER1");
            evt.setHostId("user_pit_1");
            dao.insert(evt);
        });
    }

    @Test
    void testDeserializeJsonArrayFromFrontend() {
        // Simulating payload sent by frontend: photoKeys is a JSON array of strings
        String frontendPayload = """
            {
                "id": "pit_rec_array_1",
                "eventId": "evt_photo_test",
                "teamNumber": 27570,
                "scoutId": "user_pit_1",
                "scoutName": "scoutuser",
                "photoKeys": ["photo_front_1", "photo_intake_2", "photo_flower_3"],
                "claimedTotalScore": 190,
                "version": 1
            }
        """;

        PitScoutingRecord record = gson.fromJson(frontendPayload, PitScoutingRecord.class);
        assertThat(record).isNotNull();
        assertThat(record.getPhotoKeys()).isNotNull();
        assertThat(record.getPhotoKeys()).containsExactly("photo_front_1", "photo_intake_2", "photo_flower_3");

        // Save to DB via Dao
        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        // Query back from DB
        PitScoutingRecord fetched = jdbi.withExtension(PitScoutDao.class,
                dao -> dao.findPitRecordByTeam(eventId, 27570));
        assertThat(fetched).isNotNull();
        assertThat(fetched.getPhotoKeys()).containsExactly("photo_front_1", "photo_intake_2", "photo_flower_3");

        // Serialize back to JSON and verify it is a JSON Array
        String serializedJson = gson.toJson(fetched);
        JsonObject jsonObject = JsonParser.parseString(serializedJson).getAsJsonObject();
        assertThat(jsonObject.get("photoKeys").isJsonArray()).isTrue();
        assertThat(jsonObject.getAsJsonArray("photoKeys")).hasSize(3);
    }

    @Test
    void testBackwardCompatibilityWithLegacyDelimitedStringOrNull() {
        // Legacy or client sending empty string or comma-delimited
        String legacyJson = """
            {
                "id": "pit_rec_legacy",
                "eventId": "evt_photo_test",
                "teamNumber": 19666,
                "scoutId": "user_pit_1",
                "scoutName": "scoutuser",
                "photoKeys": "photo_old_1, photo_old_2",
                "claimedTotalScore": 120
            }
        """;

        PitScoutingRecord record = gson.fromJson(legacyJson, PitScoutingRecord.class);
        assertThat(record.getPhotoKeys()).containsExactly("photo_old_1", "photo_old_2");

        // Test with null photoKeys
        String nullJson = """
            {
                "id": "pit_rec_null",
                "eventId": "evt_photo_test",
                "teamNumber": 30319,
                "scoutId": "user_pit_1",
                "scoutName": "scoutuser"
            }
        """;
        PitScoutingRecord nullRecord = gson.fromJson(nullJson, PitScoutingRecord.class);
        assertThat(nullRecord.getPhotoKeys()).isNotNull().isEmpty();
        assertThat(nullRecord.getChassisSize()).isEmpty();
        assertThat(nullRecord.isHasDescoreMech()).isFalse();
        assertThat(nullRecord.isHasApriltagVision()).isFalse();
        assertThat(nullRecord.isClaimedTeleopPark()).isFalse();
        assertThat(nullRecord.getClaimedFlowerNectars()).isZero();
        assertThat(nullRecord.getClaimedFlowerBottomBonus()).isZero();
        assertThat(nullRecord.getClaimedFlowerPollens()).isZero();
        assertThat(nullRecord.getClaimedGardenBalls()).isZero();
    }

    @Test
    void testBiobuzzPitTraitsAndEndgameSerialization() {
        String payload = """
            {
                "id": "pit_biobuzz_v6",
                "eventId": "evt_photo_test",
                "teamNumber": 27570,
                "scoutId": "user_pit_1",
                "scoutName": "scoutuser",
                "drivetrainType": "swerve",
                "weightLbs": 46.2,
                "chassisSize": "标准中型 (16\\\"-17\\\")",
                "ballCompatibility": "sorting",
                "launcherType": "差速双飞轮",
                "flowerMechanism": "垂直级联高抬升",
                "hasColorSensor": true,
                "hasDescoreMech": true,
                "hasApriltagVision": true,
                "claimedTeleopPark": true,
                "claimedFlowerNectars": 2,
                "claimedFlowerBottomBonus": 1,
                "claimedFlowerPollens": 4,
                "claimedGardenBalls": 3,
                "claimedEndgameScore": 25,
                "claimedTotalScore": 145,
                "version": 1
            }
        """;

        PitScoutingRecord parsed = gson.fromJson(payload, PitScoutingRecord.class);
        assertThat(parsed.getChassisSize()).isEqualTo("标准中型 (16\"-17\")");
        assertThat(parsed.isHasDescoreMech()).isTrue();
        assertThat(parsed.isHasApriltagVision()).isTrue();
        assertThat(parsed.isClaimedTeleopPark()).isTrue();
        assertThat(parsed.getClaimedFlowerNectars()).isEqualTo(2);
        assertThat(parsed.getClaimedFlowerBottomBonus()).isEqualTo(1);
        assertThat(parsed.getClaimedFlowerPollens()).isEqualTo(4);
        assertThat(parsed.getClaimedGardenBalls()).isEqualTo(3);

        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(parsed));
        PitScoutingRecord fetched = jdbi.withExtension(PitScoutDao.class,
                dao -> dao.findPitRecordByTeam(eventId, 27570));

        String json = gson.toJson(fetched);
        JsonObject obj = JsonParser.parseString(json).getAsJsonObject();
        assertThat(obj.get("hasDescoreMech").getAsBoolean()).isTrue();
        assertThat(obj.get("hasApriltagVision").getAsBoolean()).isTrue();
        assertThat(obj.get("claimedTeleopPark").getAsBoolean()).isTrue();
        assertThat(obj.get("claimedFlowerNectars").getAsInt()).isEqualTo(2);
        assertThat(obj.get("claimedFlowerBottomBonus").getAsInt()).isEqualTo(1);
        assertThat(obj.get("claimedFlowerPollens").getAsInt()).isEqualTo(4);
        assertThat(obj.get("claimedGardenBalls").getAsInt()).isEqualTo(3);
        assertThat(obj.get("chassisSize").getAsString()).isEqualTo("标准中型 (16\"-17\")");
        assertThat(obj.get("weightLbs").getAsDouble()).isEqualTo(46.2);
    }

    @Test
    void testPitScoutRoutesStructuredAndLegacyCompatibility() {
        Javalin app = Javalin.create(config -> new ApiRoutes(jdbi).register(config.routes));
        JavalinTest.test(app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"pithost\", \"password\":\"Pass123!\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"pithost\", \"password\":\"Pass123!\"}");
            String token = JsonParser.parseString(loginRes.body().string()).getAsJsonObject().get("token").getAsString();

            var evtRes = client.post("/api/events", "{\"name\":\"Pit Route Event\"}",
                    b -> b.header("Authorization", "Bearer " + token));
            String routeEventId = JsonParser.parseString(evtRes.body().string()).getAsJsonObject().get("id").getAsString();

            // 1. Structured payload omitting claimedEndgameScore/claimedTotalScore and testing bottomBonus <= nectars clamping
            String structuredBody = """
                {
                    "teamNumber": 27570,
                    "drivetrainType": "swerve",
                    "weightLbs": 48.0,
                    "chassisSize": "宽体大车 (~18\\\")",
                    "flowerMechanism": "垂直级联高抬升",
                    "hasColorSensor": true,
                    "hasDescoreMech": true,
                    "hasApriltagVision": true,
                    "claimedAutoScore": 14,
                    "claimedTeleopScore": 40,
                    "claimedTeleopPark": true,
                    "claimedFlowerNectars": 2,
                    "claimedFlowerBottomBonus": 5,
                    "claimedFlowerPollens": 3,
                    "claimedGardenBalls": 2
                }
            """;
            var postRes = client.post("/api/events/" + routeEventId + "/pit-records", structuredBody,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(postRes.code()).isEqualTo(200);
            JsonObject postJson = JsonParser.parseString(postRes.body().string()).getAsJsonObject();
            JsonObject savedRec = postJson.getAsJsonObject("record");
            assertThat(savedRec.get("claimedFlowerBottomBonus").getAsInt()).isEqualTo(2);
            // 5 (park) + 2*2 (nectars) + 2*5 (bottomBonus) + 3*2 (pollens) + 2 (garden) = 27
            assertThat(savedRec.get("claimedEndgameScore").getAsInt()).isEqualTo(27);
            assertThat(savedRec.get("claimedTotalScore").getAsInt()).isEqualTo(81);

            // 2. Batch sync with a legacy payload (claimedEndgameScore only, no structured fields)
            String batchBody = """
                [
                    {
                        "teamNumber": 11115,
                        "claimedAutoScore": 12,
                        "claimedTeleopScore": 36,
                        "claimedEndgameScore": 15,
                        "claimedTotalScore": 63
                    }
                ]
            """;
            var batchRes = client.post("/api/events/" + routeEventId + "/pit-records/batch", batchBody,
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(batchRes.code()).isEqualTo(200);

            // 3. GET pit-records and verify both records survived accurately
            var getRes = client.get("/api/events/" + routeEventId + "/pit-records",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(getRes.code()).isEqualTo(200);
            JsonObject getJson = JsonParser.parseString(getRes.body().string()).getAsJsonObject();
            var recordsArr = getJson.getAsJsonArray("records");
            assertThat(recordsArr).hasSize(2);
            JsonObject t11115 = recordsArr.get(0).getAsJsonObject();
            JsonObject t27570 = recordsArr.get(1).getAsJsonObject();
            assertThat(t11115.get("claimedEndgameScore").getAsInt()).isEqualTo(15);
            assertThat(t11115.get("claimedTotalScore").getAsInt()).isEqualTo(63);
            assertThat(t27570.get("weightLbs").getAsDouble()).isEqualTo(48.0);
            assertThat(t27570.get("chassisSize").getAsString()).isEqualTo("宽体大车 (~18\")");
            assertThat(t27570.get("hasDescoreMech").getAsBoolean()).isTrue();
            assertThat(t27570.get("hasApriltagVision").getAsBoolean()).isTrue();
            assertThat(t27570.get("claimedEndgameScore").getAsInt()).isEqualTo(27);
        });
    }
}
