package com.bear27570.app;

import com.bear27570.app.routes.ApiRoutes;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ApiRoutesTest {

    private Jdbi jdbi;
    private Javalin app;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_api_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        
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
    void testLogin() {
        JavalinTest.test(app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"alice\", \"password\":\"secret\"}");
            var response = client.post("/api/user/login", "{\"username\":\"alice\", \"password\":\"secret\"}");
            assertThat(response.code()).isEqualTo(200);
            assertThat(response.body().string()).contains("alice");
        });
    }

    @Test
    void testVerifyTokenEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            var regResponse = client.post("/api/user/register", "{\"username\":\"eva\", \"password\":\"secret\"}");
            String body = regResponse.body().string();
            String token = body.split("\"token\":\"")[1].split("\"")[0];
            String userId = body.split("\"id\":\"")[1].split("\"")[0];

            // 1. Valid token returns valid: true, userId, and username
            var validRes = client.post("/api/user/verify-token", "{\"token\":\"" + token + "\"}");
            assertThat(validRes.code()).isEqualTo(200);
            assertThat(validRes.body().string()).contains("\"valid\":true");
            assertThat(validRes.body().string()).contains(userId);
            assertThat(validRes.body().string()).contains("eva");

            // 2. Tampered signature returns 401
            String tamperedToken = token.substring(0, token.length() - 5) + "abcde";
            var tamperedRes = client.post("/api/user/verify-token", "{\"token\":\"" + tamperedToken + "\"}");
            assertThat(tamperedRes.code()).isEqualTo(401);

            // 3. Empty or missing token returns 400
            var emptyRes = client.post("/api/user/verify-token", "{}");
            assertThat(emptyRes.code()).isEqualTo(400);
        });
    }

    @Test
    void testCreateEvent() {
        JavalinTest.test(app, (server, client) -> {
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
    void testAiSettingsLifecycleAndMasking() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register user
            var regResponse = client.post("/api/user/register", "{\"username\":\"charlie\", \"password\":\"secret\"}");
            String body = regResponse.body().string();
            String token = body.split("\"token\":\"")[1].split("\"")[0];
            String userId = body.split("\"id\":\"")[1].split("\"")[0];

            // 2. Save OpenAI settings with custom baseUrl
            String openAiPayload = "{"
                + "\"provider\":\"OPENAI\","
                + "\"apiKeyEncrypted\":\"sk-abcdef1234567890xyz\","
                + "\"modelName\":\"deepseek-chat\","
                + "\"baseUrl\":\"https://api.deepseek.com/v1\","
                + "\"proxyHost\":\"127.0.0.1\","
                + "\"proxyPort\":7890,"
                + "\"systemPrompt\":\"You are FTC expert.\""
                + "}";
            var saveRes = client.post("/api/users/" + userId + "/ai-settings", openAiPayload, builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(saveRes.code()).isEqualTo(200);

            // 3. Fetch settings and check mask
            var getRes = client.get("/api/users/" + userId + "/ai-settings", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(getRes.code()).isEqualTo(200);
            String getBody = getRes.body().string();
            assertThat(getBody).contains("deepseek-chat");
            assertThat(getBody).contains("https://api.deepseek.com/v1");
            assertThat(getBody).contains("sk****************0xyz"); // masked

            // 4. Re-save sending masked key, ensure original key is not corrupted
            String resavePayload = "{"
                + "\"provider\":\"OPENAI\","
                + "\"apiKeyEncrypted\":\"sk****************0xyz\","
                + "\"modelName\":\"deepseek-chat-v2\","
                + "\"baseUrl\":\"https://api.deepseek.com/v2\""
                + "}";
            var resaveRes = client.post("/api/users/" + userId + "/ai-settings", resavePayload, builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(resaveRes.code()).isEqualTo(200);

            // 5. Check in DB that decryption still works and recovers original key
            jdbi.useExtension(com.bear27570.app.dao.AiSettingsDao.class, dao -> {
                com.bear27570.app.model.AiSettings s = dao.findByUserIdAndProvider(userId, "OPENAI");
                assertThat(s).isNotNull();
                assertThat(s.getModelName()).isEqualTo("deepseek-chat-v2");
                assertThat(s.getBaseUrl()).isEqualTo("https://api.deepseek.com/v2");
                String decrypted = com.bear27570.app.util.AESUtil.decrypt(s.getApiKeyEncrypted());
                assertThat(decrypted).isEqualTo("sk-abcdef1234567890xyz"); // original key preserved!
            });
        });
    }

    @Test
    void testAiChatSessionPersistence() {
        JavalinTest.test(app, (server, client) -> {
            // Register and create event
            var regResponse = client.post("/api/user/register", "{\"username\":\"david\", \"password\":\"secret\"}");
            String body = regResponse.body().string();
            String token = body.split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"State Tournament\"}", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 1. Initial chat history should be empty array
            var initialChatRes = client.get("/api/events/" + eventId + "/ai-chat", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(initialChatRes.code()).isEqualTo(200);
            assertThat(initialChatRes.body().string()).isEqualTo("[]");

            // 2. Save chat history
            String chatJson = "[{\"id\":\"1\",\"role\":\"user\",\"content\":\"How is team 27570 performing?\"},{\"id\":\"2\",\"role\":\"assistant\",\"content\":\"They rank #1 in auto score!\"}]";
            var saveChatRes = client.put("/api/events/" + eventId + "/ai-chat", chatJson, builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(saveChatRes.code()).isEqualTo(200);

            // 3. Fetch chat history
            var fetchChatRes = client.get("/api/events/" + eventId + "/ai-chat", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(fetchChatRes.code()).isEqualTo(200);
            assertThat(fetchChatRes.body().string()).isEqualTo(chatJson);

            // 4. Invalid non-array JSON should return 400
            var invalidRes = client.put("/api/events/" + eventId + "/ai-chat", "{\"invalid\":\"not an array\"}", builder -> {
                builder.header("Authorization", "Bearer " + token);
            });
            assertThat(invalidRes.code()).isEqualTo(400);
        });
    }

    // Helper to setup a standard room with Host, ScoutA, ScoutB, and Outsider
    private static class RoomFixture {
        String hostToken, hostId;
        String scoutAToken, scoutAId;
        String scoutBToken, scoutBId;
        String outsiderToken, outsiderId;
        String eventId, inviteCode;
    }

    private RoomFixture setupRoomFixture(io.javalin.testtools.HttpClient client) {
        RoomFixture fix = new RoomFixture();
        
        var hostReg = client.post("/api/user/register", "{\"username\":\"host_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        fix.hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];
        fix.hostId = hostReg.body().string().split("\"id\":\"")[1].split("\"")[0];

        var scoutAReg = client.post("/api/user/register", "{\"username\":\"scouta_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        fix.scoutAToken = scoutAReg.body().string().split("\"token\":\"")[1].split("\"")[0];
        fix.scoutAId = scoutAReg.body().string().split("\"id\":\"")[1].split("\"")[0];

        var scoutBReg = client.post("/api/user/register", "{\"username\":\"scoutb_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        fix.scoutBToken = scoutBReg.body().string().split("\"token\":\"")[1].split("\"")[0];
        fix.scoutBId = scoutBReg.body().string().split("\"id\":\"")[1].split("\"")[0];

        var outsiderReg = client.post("/api/user/register", "{\"username\":\"out_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        fix.outsiderToken = outsiderReg.body().string().split("\"token\":\"")[1].split("\"")[0];
        fix.outsiderId = outsiderReg.body().string().split("\"id\":\"")[1].split("\"")[0];

        var eventRes = client.post("/api/events", "{\"name\":\"Super Regional\"}", b -> b.header("Authorization", "Bearer " + fix.hostToken));
        String eventBody = eventRes.body().string();
        fix.eventId = eventBody.split("\"id\":\"")[1].split("\"")[0];
        fix.inviteCode = eventBody.split("\"inviteCode\":\"")[1].split("\"")[0];

        client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
        client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutBToken));
        return fix;
    }

    @Test
    void testNonMemberForbiddenOnGetAndPostRecords() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // 1. vuln-0004: Outsider GET /api/records -> 403 Forbidden
            var outsiderGet = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderGet.code()).isEqualTo(403);

            // ScoutA GET /api/records -> 200 OK
            var scoutAGet = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutAGet.code()).isEqualTo(200);

            // 2. vuln-0001 (Cross-Event): Outsider POST /api/records -> 403 Forbidden
            String outsiderRecordJson = "{\"id\":\"rec_out\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":100}";
            var outsiderPost = client.post("/api/records", outsiderRecordJson, b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(outsiderPost.code()).isEqualTo(403);
        });
    }

    @Test
    void testScoutIdSpoofingForcedToAuthenticatedUser() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // ScoutA passes scoutId = scoutBId in JSON body, backend MUST force scout_id = scoutAId
            String spoofedRecordJson = "{"
                + "\"id\":\"rec_a1\","
                + "\"eventId\":\"" + f.eventId + "\","
                + "\"scoutId\":\"" + f.scoutBId + "\","
                + "\"scoutName\":\"Scout A\","
                + "\"matchNumber\":1,"
                + "\"teamNumber\":27570,"
                + "\"totalScore\":120,"
                + "\"version\":1"
                + "}";
            var scoutAPost = client.post("/api/records", spoofedRecordJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutAPost.code()).isEqualTo(200);

            // Verify in DB that scout_id is ScoutA, not the spoofed ScoutB
            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r).isNotNull();
                assertThat(r.getScoutId()).isEqualTo(f.scoutAId);
                assertThat(r.getTotalScore()).isEqualTo(120);
            });
        });
    }

    @Test
    void testNonOwnerAndFakeHostCannotOverwriteExistingRecord() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // ScoutA creates rec_a1
            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            // vuln-0001: ScoutB tries to overwrite ScoutA's record "rec_a1" and falsely passes "isHost": true
            String attackPayload = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"isHost\":true,\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":999,\"version\":2}";
            var attackRes = client.post("/api/records", attackPayload, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(attackRes.code()).isEqualTo(403); // Blocked by authoritative backend check!

            // Verify in DB that totalScore was NOT modified
            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getTotalScore()).isEqualTo(120);
                assertThat(r.getVersion()).isEqualTo(1);
            });
        });
    }

    @Test
    void testHostCanUpdateAnyEventRecord() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // ScoutA creates rec_a1
            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            // Host updates ScoutA's record
            String hostEditPayload = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":130,\"version\":2}";
            var hostEditRes = client.post("/api/records", hostEditPayload, b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostEditRes.code()).isEqualTo(200);

            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getTotalScore()).isEqualTo(130);
                assertThat(r.getVersion()).isEqualTo(2);
            });
        });
    }

    @Test
    void testSoftDeleteTombstoneOwnershipEnforcement() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // ScoutA creates rec_a1
            String recJson = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1}";
            client.post("/api/records", recJson, b -> b.header("Authorization", "Bearer " + f.scoutAToken));

            // 1. ScoutB tries to soft-delete ScoutA's record -> 403 Forbidden
            String deleteAttempt = "{\"id\":\"rec_a1\",\"eventId\":\"" + f.eventId + "\",\"isDeleted\":true,\"matchNumber\":1,\"teamNumber\":27570,\"version\":3}";
            var deleteAttemptRes = client.post("/api/records", deleteAttempt, b -> b.header("Authorization", "Bearer " + f.scoutBToken));
            assertThat(deleteAttemptRes.code()).isEqualTo(403);

            // 2. ScoutA soft-deletes own record -> 200 OK
            var scoutADeleteRes = client.post("/api/records", deleteAttempt, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(scoutADeleteRes.code()).isEqualTo(200);

            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                var r = dao.findById("rec_a1");
                assertThat(r.getIsDeleted()).isTrue();
            });
        });
    }

    @Test
    void testBatchSyncOwnershipEnforcement() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // 1. ScoutA batch syncs own record -> 200 OK
            String scoutASyncPayload = "[{\"id\":\"rec_a2\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":2,\"teamNumber\":27570,\"totalScore\":140,\"version\":1}]";
            var syncRes1 = client.post("/api/records/sync", scoutASyncPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(syncRes1.code()).isEqualTo(200);

            // 2. ScoutA batch syncs payload containing ScoutB's record -> 403 Forbidden
            String invalidSyncPayload = "[{\"id\":\"rec_b1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":3,\"teamNumber\":27570,\"totalScore\":150,\"version\":1}]";
            var syncRes2 = client.post("/api/records/sync", invalidSyncPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(syncRes2.code()).isEqualTo(403);

            // 3. Host batch syncs mixed records -> 200 OK
            String hostBatchSyncPayload = "["
                + "{\"id\":\"rec_b1\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":3,\"teamNumber\":27570,\"totalScore\":150,\"version\":1},"
                + "{\"id\":\"rec_a3\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":4,\"teamNumber\":27570,\"totalScore\":160,\"version\":1}"
                + "]";
            var hostBatchRes = client.post("/api/records/sync", hostBatchSyncPayload, b -> b.header("Authorization", "Bearer " + f.hostToken));
            assertThat(hostBatchRes.code()).isEqualTo(200);

            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                assertThat(dao.findById("rec_b1")).isNotNull();
                assertThat(dao.findById("rec_a3")).isNotNull();
            });
        });
    }
}
