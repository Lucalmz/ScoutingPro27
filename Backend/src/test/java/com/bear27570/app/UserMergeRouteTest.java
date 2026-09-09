package com.bear27570.app;

import com.bear27570.app.routes.ApiRoutes;
import com.google.gson.Gson;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class UserMergeRouteTest {

    private Jdbi jdbi;
    private Javalin app;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_merge_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        app = Javalin.create(config -> {
            new ApiRoutes(jdbi).register(config.routes);
        });
    }

    @Test
    void testUserMergeSuccess() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register target (main) user and source (device) user
            var regMain = client.post("/api/user/register", "{\"username\":\"alice_main\", \"password\":\"PassMain123\"}");
            assertThat(regMain.code()).isEqualTo(200);
            Map<?, ?> mainMap = gson.fromJson(regMain.body().string(), Map.class);
            String mainUserId = (String) mainMap.get("id");

            var regPhone = client.post("/api/user/register", "{\"username\":\"alice_phone\", \"password\":\"PassPhone123\"}");
            assertThat(regPhone.code()).isEqualTo(200);
            Map<?, ?> phoneMap = gson.fromJson(regPhone.body().string(), Map.class);
            String phoneUserId = (String) phoneMap.get("id");
            String phoneToken = (String) phoneMap.get("token");

            // 2. Insert data belonging to phone user and pre-existing data belonging to main user
            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)", "evt1", "Event 1", "INV123", phoneUserId);
                handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", "evt1", phoneUserId);

                // Pre-existing record by main user
                handle.execute("INSERT INTO scouting_records (id, event_id, scout_id, scout_name, match_number, team_number, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        "rec_main", "evt1", mainUserId, "alice_original", 99, 10000, 1);

                // Record by phone user
                handle.execute("INSERT INTO scouting_records (id, event_id, scout_id, scout_name, match_number, team_number, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        "rec1", "evt1", phoneUserId, "alice_phone", 1, 27570, 1);
                handle.execute("INSERT INTO scout_assignments (id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        "asgn1", "evt1", 1, "QUALIFICATION", "red1", 27570, phoneUserId, "alice_phone");
                handle.execute("INSERT INTO pit_scouting_records (id, event_id, team_number, scout_id, scout_name, claimed_total_score, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        "pit1", "evt1", 27570, phoneUserId, "alice_phone", 180, 1);
            });

            // 3. Call POST /api/users/merge authenticated as phone user
            String reqJson = gson.toJson(Map.of(
                    "targetUsername", "alice_main",
                    "targetPassword", "PassMain123"
            ));

            var response = client.post("/api/users/merge", reqJson, b -> b.header("Authorization", "Bearer " + phoneToken));
            assertThat(response.code()).isEqualTo(200);
            Map<?, ?> respMap = gson.fromJson(response.body().string(), Map.class);
            assertThat(respMap.get("id")).isEqualTo(mainUserId);
            assertThat(respMap.get("username")).isEqualTo("alice_main");
            assertThat(respMap.get("token")).isNotNull();

            // 4. Verify in DB: phone user is removed, all foreign keys migrated to mainUserId, version bumped
            jdbi.useHandle(handle -> {
                int phoneUserCount = handle.createQuery("SELECT COUNT(*) FROM users WHERE id = ?").bind(0, phoneUserId).mapTo(Integer.class).one();
                assertThat(phoneUserCount).isEqualTo(0);

                String hostId = handle.createQuery("SELECT host_id FROM events WHERE id = 'evt1'").mapTo(String.class).one();
                assertThat(hostId).isEqualTo(mainUserId);

                // Migrated record: scout_id updated, scout_name updated, version incremented
                var rec1Row = handle.createQuery("SELECT scout_id, scout_name, version FROM scouting_records WHERE id = 'rec1'").mapToMap().one();
                assertThat(rec1Row.get("scout_id")).isEqualTo(mainUserId);
                assertThat(rec1Row.get("scout_name")).isEqualTo("alice_main");
                assertThat(((Number) rec1Row.get("version")).intValue()).isEqualTo(2);

                // Main user's pre-existing record: untouched!
                var recMainRow = handle.createQuery("SELECT scout_id, scout_name, version FROM scouting_records WHERE id = 'rec_main'").mapToMap().one();
                assertThat(recMainRow.get("scout_id")).isEqualTo(mainUserId);
                assertThat(recMainRow.get("scout_name")).isEqualTo("alice_original");
                assertThat(((Number) recMainRow.get("version")).intValue()).isEqualTo(1);

                // Assignments: scout_id updated, scout_name updated
                var asgnRow = handle.createQuery("SELECT scout_id, scout_name FROM scout_assignments WHERE id = 'asgn1'").mapToMap().one();
                assertThat(asgnRow.get("scout_id")).isEqualTo(mainUserId);
                assertThat(asgnRow.get("scout_name")).isEqualTo("alice_main");

                // Pit scouting: scout_id updated, scout_name updated, version incremented
                var pitRow = handle.createQuery("SELECT scout_id, scout_name, version FROM pit_scouting_records WHERE id = 'pit1'").mapToMap().one();
                assertThat(pitRow.get("scout_id")).isEqualTo(mainUserId);
                assertThat(pitRow.get("scout_name")).isEqualTo("alice_main");
                assertThat(((Number) pitRow.get("version")).intValue()).isEqualTo(2);
            });
        });
    }

    @Test
    void testUserMergeWithOverlappingCompositeKeys() {
        JavalinTest.test(app, (server, client) -> {
            var regMain = client.post("/api/user/register", "{\"username\":\"alice_c_main\", \"password\":\"Pass123\"}");
            String mainUserId = (String) gson.fromJson(regMain.body().string(), Map.class).get("id");

            var regPhone = client.post("/api/user/register", "{\"username\":\"alice_c_phone\", \"password\":\"Pass123\"}");
            Map<?, ?> phoneMap = gson.fromJson(regPhone.body().string(), Map.class);
            String phoneUserId = (String) phoneMap.get("id");
            String phoneToken = (String) phoneMap.get("token");

            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)", "evtA", "Event A", "INVA", mainUserId);
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)", "evtB", "Event B", "INVB", phoneUserId);

                // event_users: evtA has both users; evtB has only phone user
                handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", "evtA", mainUserId);
                handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", "evtA", phoneUserId);
                handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", "evtB", phoneUserId);

                // ai_settings: OPENAI has both users; GEMINI has only phone user
                handle.execute("INSERT INTO ai_settings (user_id, provider, api_key_encrypted) VALUES (?, ?, ?)", mainUserId, "OPENAI", "enc_main");
                handle.execute("INSERT INTO ai_settings (user_id, provider, api_key_encrypted) VALUES (?, ?, ?)", phoneUserId, "OPENAI", "enc_phone");
                handle.execute("INSERT INTO ai_settings (user_id, provider, api_key_encrypted) VALUES (?, ?, ?)", phoneUserId, "GEMINI", "enc_gemini");

                // ai_chat_sessions: evtA has both users; evtB has only phone user
                handle.execute("INSERT INTO ai_chat_sessions (user_id, event_id, chat_history_json) VALUES (?, ?, ?)", mainUserId, "evtA", "[]");
                handle.execute("INSERT INTO ai_chat_sessions (user_id, event_id, chat_history_json) VALUES (?, ?, ?)", phoneUserId, "evtA", "[]");
                handle.execute("INSERT INTO ai_chat_sessions (user_id, event_id, chat_history_json) VALUES (?, ?, ?)", phoneUserId, "evtB", "[]");

                // team_tags: created by phone user
                handle.execute("INSERT INTO team_tags (id, event_id, team_number, tag, created_by) VALUES (?, ?, ?, ?, ?)",
                        "tag1", "evtA", 27570, "Fast", phoneUserId);
            });

            String reqJson = gson.toJson(Map.of(
                    "targetUsername", "alice_c_main",
                    "targetPassword", "Pass123"
            ));

            var response = client.post("/api/users/merge", reqJson, b -> b.header("Authorization", "Bearer " + phoneToken));
            assertThat(response.code()).isEqualTo(200);

            jdbi.useHandle(handle -> {
                // Verify phone user deleted
                int phoneCount = handle.createQuery("SELECT COUNT(*) FROM users WHERE id = ?").bind(0, phoneUserId).mapTo(Integer.class).one();
                assertThat(phoneCount).isEqualTo(0);

                // Verify event_users
                int eventUsersCount = handle.createQuery("SELECT COUNT(*) FROM event_users WHERE user_id = ?").bind(0, mainUserId).mapTo(Integer.class).one();
                assertThat(eventUsersCount).isEqualTo(2); // evtA and evtB

                // Verify ai_settings
                int aiSettingsCount = handle.createQuery("SELECT COUNT(*) FROM ai_settings WHERE user_id = ?").bind(0, mainUserId).mapTo(Integer.class).one();
                assertThat(aiSettingsCount).isEqualTo(2); // OPENAI and GEMINI

                // Verify ai_chat_sessions
                int aiChatCount = handle.createQuery("SELECT COUNT(*) FROM ai_chat_sessions WHERE user_id = ?").bind(0, mainUserId).mapTo(Integer.class).one();
                assertThat(aiChatCount).isEqualTo(2); // evtA and evtB

                // Verify team_tags
                String tagCreator = handle.createQuery("SELECT created_by FROM team_tags WHERE id = 'tag1'").mapTo(String.class).one();
                assertThat(tagCreator).isEqualTo(mainUserId);
            });
        });
    }

    @Test
    void testUserMergeInvalidPassword() {
        JavalinTest.test(app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"bob_main\", \"password\":\"CorrectPass\"}");
            var regPhone = client.post("/api/user/register", "{\"username\":\"bob_phone\", \"password\":\"Pass123\"}");
            String phoneToken = (String) gson.fromJson(regPhone.body().string(), Map.class).get("token");

            String reqJson = gson.toJson(Map.of(
                    "targetUsername", "bob_main",
                    "targetPassword", "WrongPass"
            ));

            var response = client.post("/api/users/merge", reqJson, b -> b.header("Authorization", "Bearer " + phoneToken));
            assertThat(response.code()).isEqualTo(401);
        });
    }

    @Test
    void testUserMergeSelfFails() {
        JavalinTest.test(app, (server, client) -> {
            var reg = client.post("/api/user/register", "{\"username\":\"charlie\", \"password\":\"CharliePass\"}");
            String token = (String) gson.fromJson(reg.body().string(), Map.class).get("token");

            String reqJson = gson.toJson(Map.of(
                    "targetUsername", "charlie",
                    "targetPassword", "CharliePass"
            ));

            var response = client.post("/api/users/merge", reqJson, b -> b.header("Authorization", "Bearer " + token));
            assertThat(response.code()).isEqualTo(400);
        });
    }

    @Test
    void testUserMergeNonexistentTarget() {
        JavalinTest.test(app, (server, client) -> {
            var reg = client.post("/api/user/register", "{\"username\":\"david\", \"password\":\"DavidPass\"}");
            String token = (String) gson.fromJson(reg.body().string(), Map.class).get("token");

            String reqJson = gson.toJson(Map.of(
                    "targetUsername", "nonexistent_target",
                    "targetPassword", "SomePass"
            ));

            var response = client.post("/api/users/merge", reqJson, b -> b.header("Authorization", "Bearer " + token));
            assertThat(response.code()).isEqualTo(404);
        });
    }
}
