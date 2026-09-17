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

class EventDeleteRouteTest {

    private Jdbi jdbi;
    private Javalin app;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_del_evt_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

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
    void testHostDeleteEventCascadesAllChildRecords() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register host user
            var reg = client.post("/api/user/register", "{\"username\":\"host_user\", \"password\":\"Pass123\"}");
            assertThat(reg.code()).isEqualTo(200);
            Map<?, ?> userMap = gson.fromJson(reg.body().string(), Map.class);
            String hostId = (String) userMap.get("id");
            String hostToken = (String) userMap.get("token");

            // 2. Create event via API
            var createRes = client.post("/api/events", "{\"name\":\"Championship Event\"}", req -> {
                req.header("Authorization", "Bearer " + hostToken);
            });
            assertThat(createRes.code()).isEqualTo(200);
            Map<?, ?> evtMap = gson.fromJson(createRes.body().string(), Map.class);
            String eventId = (String) evtMap.get("id");

            // 3. Insert child records into DB for this event
            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO scouting_records (id, event_id, scout_id, scout_name, match_number, team_number) VALUES (?, ?, ?, ?, ?, ?)",
                        "rec1", eventId, hostId, "host_user", 1, 27570);
                handle.execute("INSERT INTO banned_teams (event_id, team_number) VALUES (?, ?)", eventId, 99999);
            });

            // Verify event and record exist
            jdbi.useHandle(handle -> {
                int count = handle.createQuery("SELECT COUNT(*) FROM events WHERE id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(count).isEqualTo(1);
                int recCount = handle.createQuery("SELECT COUNT(*) FROM scouting_records WHERE event_id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(recCount).isEqualTo(1);
            });

            // 4. Host calls DELETE /api/events/{id}
            var delRes = client.delete("/api/events/" + eventId, null, req -> {
                req.header("Authorization", "Bearer " + hostToken);
            });
            assertThat(delRes.code()).isEqualTo(204);

            // 5. Verify event and cascaded child rows are completely deleted
            jdbi.useHandle(handle -> {
                int count = handle.createQuery("SELECT COUNT(*) FROM events WHERE id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(count).isEqualTo(0);
                int recCount = handle.createQuery("SELECT COUNT(*) FROM scouting_records WHERE event_id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(recCount).isEqualTo(0);
                int bannedCount = handle.createQuery("SELECT COUNT(*) FROM banned_teams WHERE event_id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(bannedCount).isEqualTo(0);
            });
        });
    }

    @Test
    void testParticipantDeleteEventOnlyRemovesMembership() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register host and participant
            var regHost = client.post("/api/user/register", "{\"username\":\"the_host\", \"password\":\"Pass123\"}");
            String hostToken = (String) gson.fromJson(regHost.body().string(), Map.class).get("token");

            var regPart = client.post("/api/user/register", "{\"username\":\"the_scout\", \"password\":\"Pass123\"}");
            Map<?, ?> partMap = gson.fromJson(regPart.body().string(), Map.class);
            String partUserId = (String) partMap.get("id");
            String partToken = (String) partMap.get("token");

            // 2. Host creates event
            var createRes = client.post("/api/events", "{\"name\":\"Team Event\"}", req -> {
                req.header("Authorization", "Bearer " + hostToken);
            });
            Map<?, ?> evtMap = gson.fromJson(createRes.body().string(), Map.class);
            String eventId = (String) evtMap.get("id");
            String inviteCode = (String) evtMap.get("inviteCode");

            // 3. Participant joins event
            var joinRes = client.post("/api/events/join", "{\"inviteCode\":\"" + inviteCode + "\"}", req -> {
                req.header("Authorization", "Bearer " + partToken);
            });
            assertThat(joinRes.code()).isEqualTo(200);

            // Verify both see the event in their event list
            var listForScout = client.get("/api/events?userId=" + partUserId, req -> {
                req.header("Authorization", "Bearer " + partToken);
            });
            assertThat(listForScout.body().string()).contains("Team Event");

            // 4. Participant calls DELETE /api/events/{id}
            var delRes = client.delete("/api/events/" + eventId, null, req -> {
                req.header("Authorization", "Bearer " + partToken);
            });
            assertThat(delRes.code()).isEqualTo(204);

            // 5. Event STILL exists in DB for the host!
            jdbi.useHandle(handle -> {
                int count = handle.createQuery("SELECT COUNT(*) FROM events WHERE id = ?").bind(0, eventId).mapTo(Integer.class).one();
                assertThat(count).isEqualTo(1);
            });

            // 6. But participant's event list no longer includes this event!
            var listAfter = client.get("/api/events?userId=" + partUserId, req -> {
                req.header("Authorization", "Bearer " + partToken);
            });
            assertThat(listAfter.body().string()).doesNotContain("Team Event");
        });
    }
}
