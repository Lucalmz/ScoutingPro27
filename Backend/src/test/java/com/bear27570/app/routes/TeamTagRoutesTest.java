package com.bear27570.app.routes;

import com.bear27570.app.routes.RouteTestSupport.RoomFixture;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TeamTagRoutesTest {

    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_team_tag_routes");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    @Test
    void testTeamTagLifecycleNormalizationCaseInsensitiveDeleteAndPermissions() {
        JavalinTest.test(support.app, (server, client) -> {
            RoomFixture f = RouteTestSupport.setupRoomFixture(client);

            // 1. Add preset-style tag by ScoutA
            var addPresetRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"dual_motor_hang\", \"color\":\"green\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(addPresetRes.code()).isEqualTo(200);
            assertThat(addPresetRes.body().string()).contains("dual_motor_hang");

            // 2. Add custom tag with normalization (trim + lowercase)
            var addCustomRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"  Fast-Shooter  \", \"color\":\"orange\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(addCustomRes.code()).isEqualTo(200);
            assertThat(addCustomRes.body().string()).contains("\"tag\":\"fast-shooter\"");

            // 3. Reject dot in custom tag & > 30 char tag
            var dotCustomRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"invalid.tag.name\", \"color\":\"red\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(dotCustomRes.code()).isEqualTo(400);

            var longTagRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"" + "a".repeat(35) + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(longTagRes.code()).isEqualTo(400);

            // 4. Get all tags for event
            var getTagsRes = client.get("/api/events/" + f.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(getTagsRes.code()).isEqualTo(200);
            String allTagsBody = getTagsRes.body().string();
            assertThat(allTagsBody).contains("dual_motor_hang");
            assertThat(allTagsBody).contains("\"tag\":\"fast-shooter\"");

            // 5. Non-creator member (ScoutB) cannot delete (even with mixed-case path param) -> 403
            var unauthDeleteRes = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/Fast-Shooter",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.scoutBToken)
            );
            assertThat(unauthDeleteRes.code()).isEqualTo(403);
            assertThat(unauthDeleteRes.body().string()).contains("Only the tag creator or event host can delete this tag");

            // 6. Creator (ScoutA) deletes with mixed-case path param "Fast-Shooter" -> 200
            var creatorDeleteRes = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/Fast-Shooter",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(creatorDeleteRes.code()).isEqualTo(200);

            // 7. Idempotent delete on missing tag -> 200
            var idempotentDeleteRes = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/non_existent_tag",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(idempotentDeleteRes.code()).isEqualTo(200);

            // 8. Host deletes mixed-case tag created by ScoutA -> 200
            var addMixedRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"Mecanum_Drive\",\"color\":\"red\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(addMixedRes.code()).isEqualTo(200);

            var hostDelMixedRes = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/Mecanum_Drive",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.hostToken)
            );
            assertThat(hostDelMixedRes.code()).isEqualTo(200);

            var hostDeleteRes = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/dual_motor_hang",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.hostToken)
            );
            assertThat(hostDeleteRes.code()).isEqualTo(200);

            // 9. Verify all deleted
            var finalTagsRes = client.get("/api/events/" + f.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(finalTagsRes.code()).isEqualTo(200);
            assertThat(finalTagsRes.body().string()).isEqualTo("[]");

            // 10. Member vs Non-member (outsider) isolation across GET / POST / DELETE
            var seedRes = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"protected_tag\",\"color\":\"blue\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken)
            );
            assertThat(seedRes.code()).isEqualTo(200);

            var outsiderGet = client.get("/api/events/" + f.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderGet.code()).isEqualTo(403);
            assertThat(outsiderGet.body().string()).contains("Not a member of this event");

            var outsiderPost = client.post(
                    "/api/events/" + f.eventId + "/teams/27570/tags",
                    "{\"tag\":\"outsider_injected\",\"color\":\"red\"}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)
            );
            assertThat(outsiderPost.code()).isEqualTo(403);

            var outsiderDelete = client.delete(
                    "/api/events/" + f.eventId + "/teams/27570/tags/protected_tag",
                    null,
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken)
            );
            assertThat(outsiderDelete.code()).isEqualTo(403);

            var memberConfirm = client.get("/api/events/" + f.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(memberConfirm.code()).isEqualTo(200);
            String confirmBody = memberConfirm.body().string();
            assertThat(confirmBody).contains("protected_tag");
            assertThat(confirmBody).doesNotContain("outsider_injected");
        });
    }
}
