package com.bear27570.app.routes;

import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WebRtcRoutesTest {

    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_webrtc_routes");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    @Test
    void testWebRtcHandshakeTicketIssueAndVerifySuccess() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String alicePublicKey = "04a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";

            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + alicePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticketBody = ticketReq.body().string();
            assertThat(ticketBody).contains("\"ticket\":\"");
            String ticket = ticketBody.split("\"ticket\":\"")[1].split("\"")[0];

            var verifyReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"" + ticket + "\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + alicePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(verifyReq.code()).isEqualTo(200);
            String verifyBody = verifyReq.body().string();
            assertThat(verifyBody).contains("\"valid\":true");
            assertThat(verifyBody).contains("\"userId\":\"" + f.scoutAId + "\"");
        });
    }

    @Test
    void testWebRtcTicketReplayAttackWithDifferentPublicKeyIsRejected() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String alicePublicKey = "04alice_legitimate_key_1234567890abcdef";
            String evePublicKey = "04eve_attacker_key_9999999999abcdef";

            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + alicePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticket = ticketReq.body().string().split("\"ticket\":\"")[1].split("\"")[0];

            var replayReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"" + ticket + "\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + evePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(replayReq.code()).isEqualTo(200);
            String replayBody = replayReq.body().string();
            assertThat(replayBody).contains("\"valid\":false");
            assertThat(replayBody).contains("Public key hash mismatch");
        });
    }

    @Test
    void testWebRtcVerifyTicketAnonymousCallerIsUnauthorized() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            var verifyReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"dummy.jwt.ticket\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}");
            assertThat(verifyReq.code()).isEqualTo(401);
        });
    }

    @Test
    void testWebRtcVerifyTicketNonMemberCallerIsForbidden() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            var verifyReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"dummy.jwt.ticket\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(verifyReq.code()).isEqualTo(403);
            assertThat(verifyReq.body().string()).contains("Caller is not a member of this event");
        });
    }

    @Test
    void testWebRtcTicketCannotBeUsedForGeneralApiAccess() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticket = ticketReq.body().string().split("\"ticket\":\"")[1].split("\"")[0];

            var eventsReq = client.get("/api/events", b -> b.header("Authorization", "Bearer " + ticket));
            assertThat(eventsReq.code()).isEqualTo(401);

            var recordsReq = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + ticket));
            assertThat(recordsReq.code()).isEqualTo(401);
        });
    }

    @Test
    void testWebRtcHandshakeTicketNonMemberIsForbidden() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);
            String outsiderKey = "04outsider_key_12345";

            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + outsiderKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(ticketReq.code()).isEqualTo(403);
            assertThat(ticketReq.body().string()).contains("User is not a member of this event");
        });
    }
}
