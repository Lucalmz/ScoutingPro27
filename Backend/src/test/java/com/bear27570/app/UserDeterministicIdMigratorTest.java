package com.bear27570.app;

import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.bear27570.app.model.User;
import com.bear27570.app.util.UserUtil;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.ResultSet;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class UserDeterministicIdMigratorTest {

    private Jdbi jdbi;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_migrator_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());
    }

    @Test
    void testDynamicForeignKeyCoverage() {
        jdbi.useHandle(handle -> {
            Set<String> fkTables = new HashSet<>();
            try (ResultSet rs = handle.getConnection().getMetaData().getExportedKeys(null, null, "USERS")) {
                while (rs.next()) {
                    String fkTable = rs.getString("FKTABLE_NAME");
                    if (fkTable != null) {
                        fkTables.add(fkTable.toUpperCase());
                    }
                }
            } catch (java.sql.SQLException e) {
                throw new RuntimeException(e);
            }

            // All foreign keys referencing USERS(ID) in the schema must be known and handled
            assertThat(fkTables).containsExactlyInAnyOrder("EVENTS", "EVENT_USERS", "AI_SETTINGS", "AI_CHAT_SESSIONS");
        });
    }

    @Test
    void testUpdateForeignKeysCascade() {
        String oldId = "legacy-user-uuid-123";
        String username = "Alice";
        String password = "SecretPassword";
        String newDeterministicId = UserUtil.generateDeterministicUserId(username, password);

        jdbi.useHandle(handle -> {
            handle.execute("SET REFERENTIAL_INTEGRITY FALSE");
            handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", oldId, username, "pass-hash");
            handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)", "evt1", "Event 1", "INV123", oldId);
            handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", "evt1", oldId);
            handle.execute("INSERT INTO scouting_records (id, event_id, scout_id, scout_name, match_number, team_number) VALUES (?, ?, ?, ?, ?, ?)",
                    "rec1", "evt1", oldId, "Alice", 1, 27570);
            handle.execute("INSERT INTO ai_settings (user_id, provider, api_key_encrypted, model_name, system_prompt, proxy_host) VALUES (?, ?, ?, ?, ?, ?)",
                    oldId, "OPENAI", "enc-key", "gpt-4", "prompt", "127.0.0.1");
            handle.execute("INSERT INTO ai_chat_sessions (user_id, event_id, chat_history_json) VALUES (?, ?, ?)",
                    oldId, "evt1", "[]");
            handle.execute("INSERT INTO team_tags (id, event_id, team_number, tag, created_by) VALUES (?, ?, ?, ?, ?)",
                    "tag1", "evt1", 27570, "defense", oldId);
            handle.execute("INSERT INTO scout_assignments (id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    "asgn1", "evt1", 1, "QUALIFICATION", "red1", 27570, oldId, "Alice");
            handle.execute("INSERT INTO pit_scouting_records (id, event_id, team_number, scout_id, scout_name, claimed_total_score) VALUES (?, ?, ?, ?, ?, ?)",
                    "pit1", "evt1", 27570, oldId, "Alice", 180);
            handle.execute("SET REFERENTIAL_INTEGRITY TRUE");

            // Execute cascading user ID migration
            UserDeterministicIdMigrator.cascadeMigrateUserId(handle, oldId, newDeterministicId);

            // Verify cascading updates across all dependent tables
            String eventHostId = handle.createQuery("SELECT host_id FROM events WHERE id = 'evt1'").mapTo(String.class).one();
            assertThat(eventHostId).isEqualTo(newDeterministicId);

            String eventUserId = handle.createQuery("SELECT user_id FROM event_users WHERE event_id = 'evt1'").mapTo(String.class).one();
            assertThat(eventUserId).isEqualTo(newDeterministicId);

            String recordScoutId = handle.createQuery("SELECT scout_id FROM scouting_records WHERE id = 'rec1'").mapTo(String.class).one();
            assertThat(recordScoutId).isEqualTo(newDeterministicId);

            String aiSettingsUserId = handle.createQuery("SELECT user_id FROM ai_settings WHERE provider = 'OPENAI'").mapTo(String.class).one();
            assertThat(aiSettingsUserId).isEqualTo(newDeterministicId);

            String chatSessionUserId = handle.createQuery("SELECT user_id FROM ai_chat_sessions WHERE event_id = 'evt1'").mapTo(String.class).one();
            assertThat(chatSessionUserId).isEqualTo(newDeterministicId);

            String tagCreatedBy = handle.createQuery("SELECT created_by FROM team_tags WHERE id = 'tag1'").mapTo(String.class).one();
            assertThat(tagCreatedBy).isEqualTo(newDeterministicId);

            String assignmentScoutId = handle.createQuery("SELECT scout_id FROM scout_assignments WHERE id = 'asgn1'").mapTo(String.class).one();
            assertThat(assignmentScoutId).isEqualTo(newDeterministicId);

            String pitScoutId = handle.createQuery("SELECT scout_id FROM pit_scouting_records WHERE id = 'pit1'").mapTo(String.class).one();
            assertThat(pitScoutId).isEqualTo(newDeterministicId);
        });
    }
}
