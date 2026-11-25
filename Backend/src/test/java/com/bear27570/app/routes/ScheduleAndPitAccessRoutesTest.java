package com.bear27570.app.routes;

import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ScheduleAndPitAccessRoutesTest {

    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_schedule_pit_routes");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    @Test
    void testScheduleAndPitRecordsNonMemberForbidden() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            var schedRes = client.get("/api/events/" + f.eventId + "/schedule",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(schedRes.code()).isEqualTo(403);

            var pitRes = client.get("/api/events/" + f.eventId + "/pit-records",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(pitRes.code()).isEqualTo(403);

            var memberSchedRes = client.get("/api/events/" + f.eventId + "/schedule",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(memberSchedRes.code()).isEqualTo(200);

            var memberPitRes = client.get("/api/events/" + f.eventId + "/pit-records",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(memberPitRes.code()).isEqualTo(200);
        });
    }

    @Test
    void testScheduleBatchHostOnlyAndValidation() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            String validBatch = """
                {
                    "clearExisting": false,
                    "items": [
                        {
                            "matchNumber": 1,
                            "tournamentLevel": "QUALIFICATION",
                            "red1": 11111,
                            "red2": 22222,
                            "blue1": 33333,
                            "blue2": 44444
                        }
                    ],
                    "assignments": [
                        {
                            "matchNumber": 1,
                            "tournamentLevel": "QUALIFICATION",
                            "station": "red1",
                            "teamNumber": 11111,
                            "scoutId": "%s",
                            "scoutName": "Scout Alice"
                        }
                    ]
                }
            """.formatted(f.scoutAId);

            var nonHostRes = client.post("/api/events/" + f.eventId + "/schedule/batch", validBatch,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(nonHostRes.code()).isEqualTo(403);
            assertThat(nonHostRes.body().string()).contains("Only the event host can modify match schedule");

            var malformedRes = client.post("/api/events/" + f.eventId + "/schedule/batch", "{\"clearExisting\":false}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(malformedRes.code()).isEqualTo(400);

            var hostRes = client.post("/api/events/" + f.eventId + "/schedule/batch", validBatch,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostRes.code()).isEqualTo(200);
            assertThat(hostRes.body().string()).contains("\"count\":1");

            var fetchRes = client.get("/api/events/" + f.eventId + "/schedule",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(fetchRes.code()).isEqualTo(200);
            String fetchBody = fetchRes.body().string();
            assertThat(fetchBody).contains("11111");
            assertThat(fetchBody).contains("Scout Alice");

            // Nonexistent event MUST return 404 (not unreachable 403) across all write routes
            var missingBatch = client.post("/api/events/evt_nonexistent_404/schedule/batch", validBatch,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(missingBatch.code()).isEqualTo(404);
            assertThat(missingBatch.body().string()).contains("Event not found");

            var missingDel = client.delete("/api/events/evt_nonexistent_404/schedule", null,
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(missingDel.code()).isEqualTo(404);

            var missingAssign = client.put("/api/events/evt_nonexistent_404/assignments", "{\"assignments\":[]}",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(missingAssign.code()).isEqualTo(404);
        });
    }
}
