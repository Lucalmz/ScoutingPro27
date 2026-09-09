package com.bear27570.app;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.routes.ApiRoutes;
import com.google.gson.Gson;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class EventReparentingE2ETest {

    private Jdbi jdbi;
    private Javalin app;
    private Gson gson = new Gson();
    private String inviteCode = "TEST99";
    private String stubEventId = "ext_" + inviteCode;
    private String authoritativeEventId = "evt_authoritative_" + System.nanoTime();
    private File stubPhotoDir;
    private File targetPhotoDir;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_reparent_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

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

        stubPhotoDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + stubEventId);
        targetPhotoDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + authoritativeEventId);
    }

    @AfterEach
    void tearDown() {
        cleanupDir(stubPhotoDir);
        cleanupDir(targetPhotoDir);
    }

    private void cleanupDir(File dir) {
        if (dir != null && dir.exists()) {
            File[] files = dir.listFiles();
            if (files != null) {
                for (File f : files) f.delete();
            }
            dir.delete();
        }
    }

    @Test
    void testReparentEventDataFullPipeline() throws Exception {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register host user and scout user
            client.post("/api/user/register", "{\"username\":\"reparenthost\", \"password\":\"Pass123456\"}");
            var hostLogin = client.post("/api/user/login", "{\"username\":\"reparenthost\", \"password\":\"Pass123456\"}");
            Map<?, ?> hostMap = gson.fromJson(hostLogin.body().string(), Map.class);
            String hostToken = (String) hostMap.get("token");
            String hostId = (String) hostMap.get("id");

            client.post("/api/user/register", "{\"username\":\"reparentscout\", \"password\":\"Pass123456\"}");
            var scoutLogin = client.post("/api/user/login", "{\"username\":\"reparentscout\", \"password\":\"Pass123456\"}");
            Map<?, ?> scoutMap = gson.fromJson(scoutLogin.body().string(), Map.class);
            String scoutToken = (String) scoutMap.get("token");
            String scoutId = (String) scoutMap.get("id");

            // 2. Seed stub event ext_TEST99 and associated data in all tables
            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        stubEventId, "Temporary Distributed Stub", inviteCode, hostId);

                handle.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)", stubEventId, scoutId);

                handle.execute("""
                    INSERT INTO scouting_records (id, event_id, scout_id, scout_name, match_number, team_number,
                        auto_score, teleop_score, endgame_score, total_score, notes, raw_data, sync_status, is_broken, is_deleted)
                    VALUES ('rec_stub_1', ?, ?, 'Scout', 1, 27570, 30, 50, 20, 100, 'good', '{}', 'SYNCED', FALSE, FALSE)
                """, stubEventId, scoutId);

                handle.execute("""
                    INSERT INTO pit_scouting_records (id, event_id, team_number, scout_id, scout_name, drivetrain_type, claimed_total_score)
                    VALUES ('pit_stub_1', ?, 27570, ?, 'Scout', 'mecanum', 150)
                """, stubEventId, scoutId);

                handle.execute("""
                    INSERT INTO event_official_teams (event_id, team_number, name_full, robot_name)
                    VALUES (?, 27570, 'B.E.A.R.', 'Polaris')
                """, stubEventId);

                handle.execute("""
                    INSERT INTO match_schedules (id, event_id, match_number, tournament_level, red1, red2, blue1, blue2)
                    VALUES ('sched_stub_1', ?, 1, 'QUALIFICATION', 27570, 11111, 22222, 33333)
                """, stubEventId);

                handle.execute("""
                    INSERT INTO scout_assignments (id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name)
                    VALUES ('assign_stub_1', ?, 1, 'QUALIFICATION', 'red1', 27570, ?, 'Scout')
                """, stubEventId, scoutId);

                handle.execute("""
                    INSERT INTO team_tags (id, event_id, team_number, tag, color, is_preset, created_by)
                    VALUES ('tag_stub_1', ?, 27570, 'intake_fast', 'blue', FALSE, ?)
                """, stubEventId, hostId);

                handle.execute("INSERT INTO banned_teams (event_id, team_number) VALUES (?, 99999)", stubEventId);

                handle.execute("""
                    INSERT INTO ai_chat_sessions (user_id, event_id, chat_history_json)
                    VALUES (?, ?, '[]')
                """, hostId, stubEventId);
            });

            // 3. Create physical photo on disk in stubPhotoDir
            stubPhotoDir.mkdirs();
            File stubPhotoFile = new File(stubPhotoDir, "pit_27570_photo.webp");
            Files.write(stubPhotoFile.toPath(), "test-photo-webp-bytes".getBytes());
            assertThat(stubPhotoFile.exists()).isTrue();

            // 4. Trigger /api/events/external-sync to reparent stub to authoritative event
            ScoutingEvent incoming = new ScoutingEvent();
            incoming.setId(authoritativeEventId);
            incoming.setName("Official Championship 2026");
            incoming.setInviteCode(inviteCode);
            incoming.setHostId(hostId);
            incoming.setFtcYear(2026);
            incoming.setFtcEventCode("CNCMP");

            var syncRes = client.post("/api/events/external-sync", gson.toJson(incoming),
                    b -> b.header("Authorization", "Bearer " + hostToken));
            if (syncRes.code() != 200) {
                System.err.println("SYNC ERROR: " + syncRes.code() + " -> " + syncRes.body().string());
            }
            assertThat(syncRes.code()).isEqualTo(200);

            // 5. Verify Database Reparenting
            jdbi.useHandle(handle -> {
                // Stub event must be deleted
                int stubCount = handle.createQuery("SELECT COUNT(*) FROM events WHERE id = ?").bind(0, stubEventId).mapTo(Integer.class).one();
                assertThat(stubCount).isEqualTo(0);

                // Authoritative event must exist
                int authCount = handle.createQuery("SELECT COUNT(*) FROM events WHERE id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one();
                assertThat(authCount).isEqualTo(1);

                // Check all reparented tables
                assertThat(handle.createQuery("SELECT COUNT(*) FROM scouting_records WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM pit_scouting_records WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM event_official_teams WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM match_schedules WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM scout_assignments WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM banned_teams WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM ai_chat_sessions WHERE event_id = ?").bind(0, authoritativeEventId).mapTo(Integer.class).one()).isEqualTo(1);
                assertThat(handle.createQuery("SELECT COUNT(*) FROM event_users WHERE event_id = ? AND user_id = ?").bind(0, authoritativeEventId).bind(1, scoutId).mapTo(Integer.class).one()).isEqualTo(1);
            });

            // 6. Verify Physical Photo File Migration
            File migratedPhoto = new File(targetPhotoDir, "pit_27570_photo.webp");
            assertThat(migratedPhoto.exists()).isTrue();
            assertThat(new String(Files.readAllBytes(migratedPhoto.toPath()))).isEqualTo("test-photo-webp-bytes");
            assertThat(stubPhotoFile.exists()).isFalse();
        });
    }
}
