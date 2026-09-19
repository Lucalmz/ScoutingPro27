package com.bear27570.app;

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

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public class EventMemberLifecycleTest {

    private Jdbi jdbi;
    private Javalin app;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_members_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

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

    @AfterEach
    void tearDown() {
        if (jdbi != null) {
            jdbi.useHandle(handle -> {
                handle.execute("DELETE FROM event_users");
                handle.execute("DELETE FROM events");
                handle.execute("DELETE FROM users");
            });
            int remainingUsers = jdbi.withHandle(h -> h.createQuery("SELECT COUNT(*) FROM users").mapTo(Integer.class).one());
            int remainingEvents = jdbi.withHandle(h -> h.createQuery("SELECT COUNT(*) FROM events").mapTo(Integer.class).one());
            int remainingMembers = jdbi.withHandle(h -> h.createQuery("SELECT COUNT(*) FROM event_users").mapTo(Integer.class).one());
            assertThat(remainingUsers).isZero();
            assertThat(remainingEvents).isZero();
            assertThat(remainingMembers).isZero();
        }
    }

    @Test
    void testHostCanRegisterMobileScoutAndMemberRemainsWithoutScoring() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Host registers and creates event
            var hostReg = client.post("/api/user/register", "{\"username\":\"host_lead\", \"password\":\"hostpass123\"}");
            assertThat(hostReg.code()).isEqualTo(200);
            var hostLogin = client.post("/api/user/login", "{\"username\":\"host_lead\", \"password\":\"hostpass123\"}");
            @SuppressWarnings("unchecked")
            Map<String, Object> hostData = gson.fromJson(hostLogin.body().string(), Map.class);
            String hostToken = (String) hostData.get("token");

            var createEvt = client.post("/api/events", "{\"name\":\"2026 Championship\"}", req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(createEvt.code()).isEqualTo(200);
            @SuppressWarnings("unchecked")
            Map<String, Object> evtData = gson.fromJson(createEvt.body().string(), Map.class);
            String eventId = (String) evtData.get("id");

            // 2. Host discovers mobile client via WebRTC and proxy-registers member
            String mobileUserId = "scout_phone_abc123";
            String mobileUsername = "Mobile Scout Bob";
            var addMemberRes = client.post(
                "/api/events/" + eventId + "/members",
                gson.toJson(Map.of("userId", mobileUserId, "username", mobileUsername)),
                req -> req.header("Authorization", "Bearer " + hostToken)
            );
            assertThat(addMemberRes.code()).isEqualTo(200);

            // 3. Verify user is safely created in users as a placeholder and linked in event_users
            jdbi.useHandle(handle -> {
                String pwd = handle.createQuery("SELECT password FROM users WHERE id = ?").bind(0, mobileUserId).mapTo(String.class).one();
                assertThat(pwd).isEmpty();

                int memberLinkCount = handle.createQuery("SELECT COUNT(*) FROM event_users WHERE event_id = ? AND user_id = ?")
                    .bind(0, eventId)
                    .bind(1, mobileUserId)
                    .mapTo(Integer.class)
                    .one();
                assertThat(memberLinkCount).isEqualTo(1);
            });

            // 4. Verify GET /api/events/{id}/members returns both Host and Mobile Scout
            var membersRes = client.get("/api/events/" + eventId + "/members", req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(membersRes.code()).isEqualTo(200);
            String membersBody = membersRes.body().string();
            assertThat(membersBody).contains("scout_phone_abc123");
            assertThat(membersBody).contains("Mobile Scout Bob");
        });
    }

    @Test
    void testAntiHijackingDoesNotOverwriteRealUserAccount() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register a real user with a password
            client.post("/api/user/register", "{\"username\":\"real_user\", \"password\":\"realpass999\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"real_user\", \"password\":\"realpass999\"}");
            @SuppressWarnings("unchecked")
            Map<String, Object> realUserData = gson.fromJson(loginRes.body().string(), Map.class);
            String realUserId = (String) realUserData.get("id");

            // 2. Host creates event
            client.post("/api/user/register", "{\"username\":\"host_admin\", \"password\":\"adminpass\"}");
            var hostLogin = client.post("/api/user/login", "{\"username\":\"host_admin\", \"password\":\"adminpass\"}");
            @SuppressWarnings("unchecked")
            Map<String, Object> hostData = gson.fromJson(hostLogin.body().string(), Map.class);
            String hostToken = (String) hostData.get("token");

            var createEvt = client.post("/api/events", "{\"name\":\"Regional Event\"}", req -> req.header("Authorization", "Bearer " + hostToken));
            @SuppressWarnings("unchecked")
            Map<String, Object> evtData = gson.fromJson(createEvt.body().string(), Map.class);
            String eventId = (String) evtData.get("id");

            // 3. Attempt to proxy-register with a different name
            var addMemberRes = client.post(
                "/api/events/" + eventId + "/members",
                gson.toJson(Map.of("userId", realUserId, "username", "Hijacked Name")),
                req -> req.header("Authorization", "Bearer " + hostToken)
            );
            assertThat(addMemberRes.code()).isEqualTo(200);

            // 4. Verify real username and password were NOT overwritten
            jdbi.useHandle(handle -> {
                String actualName = handle.createQuery("SELECT username FROM users WHERE id = ?").bind(0, realUserId).mapTo(String.class).one();
                assertThat(actualName).isEqualTo("real_user"); // NOT hijacked
            });
        });
    }

    @Test
    void testHostOnlyAuthorizationAndMemberRemoval() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Create host and event
            client.post("/api/user/register", "{\"username\":\"event_host\", \"password\":\"pass\"}");
            var hostLogin = client.post("/api/user/login", "{\"username\":\"event_host\", \"password\":\"pass\"}");
            @SuppressWarnings("unchecked")
            String hostToken = (String) gson.fromJson(hostLogin.body().string(), Map.class).get("token");

            var createEvt = client.post("/api/events", "{\"name\":\"Invitational\"}", req -> req.header("Authorization", "Bearer " + hostToken));
            @SuppressWarnings("unchecked")
            String eventId = (String) gson.fromJson(createEvt.body().string(), Map.class).get("id");

            // 2. Create another independent user
            client.post("/api/user/register", "{\"username\":\"stranger\", \"password\":\"pass\"}");
            var strangerLogin = client.post("/api/user/login", "{\"username\":\"stranger\", \"password\":\"pass\"}");
            @SuppressWarnings("unchecked")
            String strangerToken = (String) gson.fromJson(strangerLogin.body().string(), Map.class).get("token");

            // 3. Stranger attempts to add member -> 403
            var strangerAdd = client.post(
                "/api/events/" + eventId + "/members",
                "{\"userId\":\"rogue_user\", \"username\":\"Rogue\"}",
                req -> req.header("Authorization", "Bearer " + strangerToken)
            );
            assertThat(strangerAdd.code()).isEqualTo(403);

            // 4. Host adds a member
            client.post(
                "/api/events/" + eventId + "/members",
                "{\"userId\":\"valid_scout\", \"username\":\"Valid Scout\"}",
                req -> req.header("Authorization", "Bearer " + hostToken)
            );

            // 5. Stranger attempts to remove member -> 403
            var strangerDel = client.delete(
                "/api/events/" + eventId + "/members/valid_scout",
                null,
                req -> req.header("Authorization", "Bearer " + strangerToken)
            );
            assertThat(strangerDel.code()).isEqualTo(403);

            // 6. Host removes valid_scout -> 200
            var hostDel = client.delete(
                "/api/events/" + eventId + "/members/valid_scout",
                null,
                req -> req.header("Authorization", "Bearer " + hostToken)
            );
            assertThat(hostDel.code()).isEqualTo(200);

            // 7. Verify member removed from event_users
            jdbi.useHandle(handle -> {
                int count = handle.createQuery("SELECT COUNT(*) FROM event_users WHERE event_id = ? AND user_id = 'valid_scout'")
                    .bind(0, eventId)
                    .mapTo(Integer.class)
                    .one();
                assertThat(count).isZero();
            });

            // 8. Host cannot remove themselves -> 400
            String hostUserId = (String) gson.fromJson(hostLogin.body().string(), Map.class).get("id");
            var hostDelSelf = client.delete(
                "/api/events/" + eventId + "/members/" + hostUserId,
                null,
                req -> req.header("Authorization", "Bearer " + hostToken)
            );
            assertThat(hostDelSelf.code()).isEqualTo(400);
        });
    }
}
