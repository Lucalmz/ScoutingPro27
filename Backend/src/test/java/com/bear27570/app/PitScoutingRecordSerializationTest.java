package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
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
                "photoKeys": ["photo_front_1", "photo_intake_2", "photo_hang_3"],
                "claimedTotalScore": 190,
                "version": 1
            }
        """;

        PitScoutingRecord record = gson.fromJson(frontendPayload, PitScoutingRecord.class);
        assertThat(record).isNotNull();
        assertThat(record.getPhotoKeys()).isNotNull();
        assertThat(record.getPhotoKeys()).containsExactly("photo_front_1", "photo_intake_2", "photo_hang_3");

        // Save to DB via Dao
        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        // Query back from DB
        PitScoutingRecord fetched = jdbi.withExtension(PitScoutDao.class,
                dao -> dao.findPitRecordByTeam(eventId, 27570));
        assertThat(fetched).isNotNull();
        assertThat(fetched.getPhotoKeys()).containsExactly("photo_front_1", "photo_intake_2", "photo_hang_3");

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
    }
}
