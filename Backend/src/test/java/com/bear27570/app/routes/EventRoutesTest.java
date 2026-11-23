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
}
