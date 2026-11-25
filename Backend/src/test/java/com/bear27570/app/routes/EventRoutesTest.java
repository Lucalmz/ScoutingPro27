package com.bear27570.app.routes;

import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import com.bear27570.app.util.FtcApiClient;
import com.sun.net.httpserver.HttpServer;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class EventRoutesTest {

    private HttpServer mockFtcServer;
    private AtomicInteger upstreamEventCalls;
    private RouteTestSupport support;

    @BeforeEach
    void setUp() throws Exception {
        upstreamEventCalls = new AtomicInteger(0);
        mockFtcServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockFtcServer.createContext("/v2.0/2026/events", exchange -> {
            upstreamEventCalls.incrementAndGet();
            byte[] bytes = "{\"events\":[{\"code\":\"CNCMP\",\"name\":\"China Championship\"}],\"eventCount\":1}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        mockFtcServer.start();
        int mockPort = mockFtcServer.getAddress().getPort();

        FtcApiClient mockFtcClient = new FtcApiClient("http://127.0.0.1:" + mockPort, "user", "pass");
        support = new RouteTestSupport("test_event_routes", mockFtcClient);
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
        if (mockFtcServer != null) {
            mockFtcServer.stop(0);
        }
    }

    @Test
    void testCreateEvent() {
        JavalinTest.test(support.app, (server, client) -> {
            var regResponse = client.post("/api/user/register", "{\"username\":\"bob\", \"password\":\"secret\"}");
            String body = regResponse.body().string();
            String token = body.split("\"token\":\"")[1].split("\"")[0];

            var response = client.post("/api/events", "{\"name\":\"Championship\"}", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(response.code()).isEqualTo(200);
            assertThat(response.body().string()).contains("inviteCode");
        });
    }

    @Test
    void testIdempotentJoinEvent() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            var joinAgain1 = client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinAgain1.code()).isEqualTo(200);

            var joinAgain2 = client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinAgain2.code()).isEqualTo(200);

            support.jdbi.useHandle(handle -> {
                Long count = handle.createQuery("SELECT COUNT(*) FROM event_users WHERE event_id = :eventId AND user_id = :userId")
                        .bind("eventId", fix.eventId)
                        .bind("userId", fix.scoutAId)
                        .mapTo(Long.class)
                        .one();
                assertThat(count).isEqualTo(1L);
            });
        });
    }

    @Test
    void testDistributedMultiDeviceJoinAndStubSync() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            String unknownCode = "EXTNET1";
            var joinRes = client.post("/api/events/join", "{\"inviteCode\":\"" + unknownCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinRes.code()).isEqualTo(200);
            String body = joinRes.body().string();
            assertThat(body).contains("ext_EXTNET1");
            assertThat(body).contains("Remote Event (EXTNET1)");

            String officialSyncPayload = "{"
                    + "\"id\":\"evt_official_999\","
                    + "\"name\":\"Official FTC Championship\","
                    + "\"inviteCode\":\"EXTNET1\","
                    + "\"hostId\":\"host_external_uuid\","
                    + "\"ftcYear\":2026,"
                    + "\"ftcEventCode\":\"CNCMP\""
                    + "}";
            var syncRes = client.post("/api/events/external-sync", officialSyncPayload, b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(syncRes.code()).isEqualTo(200);
            String syncBody = syncRes.body().string();
            assertThat(syncBody).contains("evt_official_999");
            assertThat(syncBody).contains("Official FTC Championship");

            support.jdbi.useHandle(handle -> {
                var stub = handle.createQuery("SELECT * FROM events WHERE id = 'ext_EXTNET1'").mapToMap().findOne();
                assertThat(stub).isEmpty();

                var official = handle.createQuery("SELECT * FROM events WHERE id = 'evt_official_999'").mapToMap().one();
                assertThat(official.get("name")).isEqualTo("Official FTC Championship");

                Long count = handle.createQuery("SELECT COUNT(*) FROM event_users WHERE event_id = 'evt_official_999' AND user_id = :u")
                        .bind("u", fix.scoutAId).mapTo(Long.class).one();
                assertThat(count).isEqualTo(1L);
            });
        });
    }

    @Test
    void testFtcConfigInvalidYearReturns400() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            var invalidRes = client.put("/api/events/" + f.eventId + "/ftc-config",
                    "{\"ftcYear\":\"invalid_year\",\"ftcEventCode\":\"TEST\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(invalidRes.code()).isEqualTo(400);
            assertThat(invalidRes.body().string()).contains("Invalid ftcYear format");
        });
    }

    @Test
    void testFtcConfigRejectsNonExistentEventCodeBiobuzz26() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            var res = client.put("/api/events/" + f.eventId + "/ftc-config",
                    "{\"ftcYear\":2026,\"ftcEventCode\":\"BIOBUZZ26\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(res.code()).isEqualTo(400);
            assertThat(res.body().string()).contains("FTC 官方赛事代码不存在: BIOBUZZ26 (赛季 2026)");
            assertThat(upstreamEventCalls.get()).isGreaterThanOrEqualTo(1);

            support.jdbi.useHandle(handle -> {
                var code = handle.createQuery("SELECT ftc_event_code FROM events WHERE id = ?")
                        .bind(0, f.eventId)
                        .mapTo(String.class)
                        .findOne();
                assertThat(code).isEmpty();
            });
        });
    }

    @Test
    void testFtcConfigUnbindClearsEventCode() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            var bindRes = client.put("/api/events/" + f.eventId + "/ftc-config",
                    "{\"ftcYear\":2026,\"ftcEventCode\":\"CNCMP\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(bindRes.code()).isEqualTo(200);

            support.jdbi.useHandle(handle -> {
                var boundCode = handle.createQuery("SELECT ftc_event_code FROM events WHERE id = ?")
                        .bind(0, f.eventId)
                        .mapTo(String.class)
                        .findOne();
                assertThat(boundCode).contains("CNCMP");
            });

            var unbindRes = client.put("/api/events/" + f.eventId + "/ftc-config",
                    "{\"ftcYear\":null,\"ftcEventCode\":null}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(unbindRes.code()).isEqualTo(200);

            support.jdbi.useHandle(handle -> {
                var code = handle.createQuery("SELECT ftc_event_code FROM events WHERE id = ?")
                        .bind(0, f.eventId)
                        .mapTo(String.class)
                        .findOne();
                assertThat(code).isEmpty();
            });
        });
    }

    @Test
    void testCreateEventNameBoundsExternalSyncAntiHijackAndMemberIsolation() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            // 1. POST /api/events rejects blank and >100-char names with 400
            var blankRes = client.post("/api/events", "{\"name\":\"   \"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(blankRes.code()).isEqualTo(400);
            assertThat(blankRes.body().string()).contains("Event name is required");

            var overlongRes = client.post("/api/events", "{\"name\":\"" + "X".repeat(101) + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(overlongRes.code()).isEqualTo(400);
            assertThat(overlongRes.body().string()).contains("Event name cannot exceed 100 characters");

            // 2. Positive precondition: Host bans team 11115; ScoutA (member) can read banned-teams & members
            assertThat(client.post("/api/events/" + f.eventId + "/banned-teams", "{\"teamNumber\":11115}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken)).code()).isEqualTo(200);

            var memberBannedRes = client.get("/api/events/" + f.eventId + "/banned-teams",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(memberBannedRes.code()).isEqualTo(200);
            assertThat(memberBannedRes.body().string()).contains("11115");

            var memberListRes = client.get("/api/events/" + f.eventId + "/members",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(memberListRes.code()).isEqualTo(200);
            assertThat(memberListRes.body().string()).contains(f.hostId);

            // Negative assertions: Outsider (authenticated non-member) receives 403 on both
            var outsiderBannedRes = client.get("/api/events/" + f.eventId + "/banned-teams",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderBannedRes.code()).isEqualTo(403);

            var outsiderMembersRes = client.get("/api/events/" + f.eventId + "/members",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderMembersRes.code()).isEqualTo(403);

            // 3. POST /api/events/external-sync anti-hijack guards
            String hijackHostPayload = "{\"id\":\"" + f.eventId + "\",\"name\":\"Hijacked\",\"inviteCode\":\"" + f.inviteCode + "\",\"hostId\":\"" + f.scoutAId + "\"}";
            var hijackRes = client.post("/api/events/external-sync", hijackHostPayload,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(hijackRes.code()).isEqualTo(403);
            assertThat(hijackRes.body().string()).contains("Cannot hijack host ownership");

            String overwriteLocalHostEvent = "{\"id\":\"" + f.eventId + "\",\"name\":\"Tampered Name\",\"inviteCode\":\"" + f.inviteCode + "\",\"hostId\":\"" + f.hostId + "\"}";
            var overwriteRes = client.post("/api/events/external-sync", overwriteLocalHostEvent,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(overwriteRes.code()).isEqualTo(403);
            assertThat(overwriteRes.body().string()).contains("Only the event host can modify an authoritative local event");

            String stealInviteCodePayload = "{\"id\":\"evt_rogue_steal\",\"name\":\"Rogue Event\",\"inviteCode\":\"" + f.inviteCode + "\",\"hostId\":\"" + f.scoutAId + "\"}";
            var stealCodeRes = client.post("/api/events/external-sync", stealInviteCodePayload,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(stealCodeRes.code()).isEqualTo(403);
            assertThat(stealCodeRes.body().string()).contains("cannot overwrite invite code of an existing event");

            // Even the event Host CANNOT mutate an existing event's inviteCode or reassign it to another event ID
            String hostMutateInviteCode = "{\"id\":\"" + f.eventId + "\",\"name\":\"Host Rename\",\"inviteCode\":\"NEW999\",\"hostId\":\"" + f.hostId + "\"}";
            var hostMutateRes = client.post("/api/events/external-sync", hostMutateInviteCode,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostMutateRes.code()).isEqualTo(400);
            assertThat(hostMutateRes.body().string()).contains("inviteCode is immutable");

            String hostReassignInviteCode = "{\"id\":\"evt_host_second\",\"name\":\"Second Event\",\"inviteCode\":\"" + f.inviteCode + "\",\"hostId\":\"" + f.hostId + "\"}";
            var hostReassignRes = client.post("/api/events/external-sync", hostReassignInviteCode,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostReassignRes.code()).isEqualTo(403);
            assertThat(hostReassignRes.body().string()).contains("inviteCode is immutable");

            // Verify authoritative event remains intact in DB
            support.jdbi.useHandle(h -> {
                var row = h.createQuery("SELECT host_id, invite_code FROM events WHERE id = ?")
                        .bind(0, f.eventId).mapToMap().one();
                assertThat(row.get("host_id")).isEqualTo(f.hostId);
                assertThat(row.get("invite_code")).isEqualTo(f.inviteCode);
            });
        });
    }
}
