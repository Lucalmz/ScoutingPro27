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
    void testCaseInsensitiveLogin() {
        JavalinTest.test(app, (server, client) -> {
            // Register as "Alice"
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass123\"}");
            assertThat(regRes.code()).isEqualTo(200);

            // Login with "alice"
            var loginRes1 = client.post("/api/user/login", "{\"username\":\"alice\", \"password\":\"AlicePass123\"}");
            assertThat(loginRes1.code()).isEqualTo(200);
            assertThat(loginRes1.body().string()).contains("\"username\":\"Alice\"");

            // Login with "ALICE"
            var loginRes2 = client.post("/api/user/login", "{\"username\":\"ALICE\", \"password\":\"AlicePass123\"}");
            assertThat(loginRes2.code()).isEqualTo(200);
            assertThat(loginRes2.body().string()).contains("\"username\":\"Alice\"");
        });
    }

    @Test
    void testNumericPasswordAndMalformedJsonHandling() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register with numeric password passed as JSON number
            var regRes = client.post("/api/user/register", "{\"username\":\"bob\", \"password\":123456}");
            assertThat(regRes.code()).isEqualTo(200);

            // 2. Login with numeric password passed as JSON number
            var loginRes = client.post("/api/user/login", "{\"username\":\"bob\", \"password\":123456}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"username\":\"bob\"");

            // 3. Post malformed JSON
            var malformedRes = client.post("/api/user/login", "{\"username\":");
            assertThat(malformedRes.code()).isEqualTo(400);
            assertThat(malformedRes.body().string()).contains("Invalid JSON body");
        });
    }

    @Test
    void testDuplicateUsernameRegistrationIsRejected() {
        JavalinTest.test(app, (server, client) -> {
            // 1. First registration succeeds
            var reg1 = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"Pass1\"}");
            assertThat(reg1.code()).isEqualTo(200);

            // 2. Second registration with same username & different password is rejected with 409
            var reg2 = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"Pass2\"}");
            assertThat(reg2.code()).isEqualTo(409);

            // 3. Case-insensitive duplicate registration is also rejected with 409
            var reg3 = client.post("/api/user/register", "{\"username\":\"alice\", \"password\":\"Pass1\"}");
            assertThat(reg3.code()).isEqualTo(409);
        });
    }

    @Test
    void testLoginUnambiguousWithMultipleSameNamePlaceholders() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Host registers "Alice"
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String primaryId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Insert two P2P peer placeholders with empty passwords
            jdbi.useExtension(com.bear27570.app.dao.UserDao.class, dao -> {
                dao.ensureScoutUserPlaceholder("scout_peer_1", "Alice");
                dao.ensureScoutUserPlaceholder("scout_peer_2", "Alice");
            });

            // 3. Check user endpoint still recognizes registered Alice
            var checkRes = client.get("/api/user/check?username=Alice");
            assertThat(checkRes.code()).isEqualTo(200);
            assertThat(checkRes.body().string()).contains("\"exists\":true");

            // 4. Host logs in with Alice + AlicePass -> unambiguously matches primaryId
            var loginRes = client.post("/api/user/login", "{\"username\":\"Alice\", \"password\":\"AlicePass\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + primaryId + "\"");

            // 5. Wrong password returns 401
            var wrongLogin = client.post("/api/user/login", "{\"username\":\"Alice\", \"password\":\"WrongPass\"}");
            assertThat(wrongLogin.code()).isEqualTo(401);
        });
    }

    @Test
    void testSyncRecordsWithNonExistentScoutIdCreatesSafePlaceholder() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register host and create event
            var hostReg = client.post("/api/user/register", "{\"username\":\"HostUser\", \"password\":\"HostPass\"}");
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];
            String hostId = hostReg.body().string().split("\"id\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Championship 2026\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Host syncs a record from a peer whose scoutId does NOT exist in host's users table
            String unknownScoutId = "scout_uuid_unregistered_999";
            String syncPayload = "[{\"id\":\"rec_unregistered_peer_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + unknownScoutId + "\",\"scoutName\":\"RemoteScout\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":140,\"version\":1}]";

            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(syncRes.code()).isEqualTo(200);

            // 3. Verify record was safely upserted and placeholder was created in users table
            jdbi.useHandle(handle -> {
                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_unregistered_peer_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(unknownScoutId);

                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", unknownScoutId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("RemoteScout");
                assertThat(user.get("password")).isEqualTo(""); // empty password placeholder
            });
        });
    }

    @Test
    void testPreserveLegacyUserIdOnLogin() {
        JavalinTest.test(app, (server, client) -> {
            String legacyId = "legacy-random-uuid-555";
            String username = "LegacyUser";
            String rawPassword = "LegacyPassword123";

            // 1. Insert legacy user with random UUID and BCrypt hashed password
            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)",
                        legacyId, username, org.mindrot.jbcrypt.BCrypt.hashpw(rawPassword, org.mindrot.jbcrypt.BCrypt.gensalt()));
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        "evt_legacy", "Legacy Event", "LEG123", legacyId);
            });

            // 2. User logs in with raw password
            var loginRes = client.post("/api/user/login", "{\"username\":\"" + username + "\", \"password\":\"" + rawPassword + "\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + legacyId + "\"");

            // 3. Verify in DB: user ID and event host_id remain uncorrupted legacyId (immutable)
            jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", legacyId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo(username);

                var evt = handle.createQuery("SELECT * FROM events WHERE id = 'evt_legacy'").mapToMap().one();
                assertThat(evt.get("host_id")).isEqualTo(legacyId);
            });
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

    @Test
    void testAiChatStreamEndpointValidation() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Unauthenticated request -> 401
            var unauthRes = client.post("/api/ai/chat/stream", "{\"provider\":\"OPENAI\"}");
            assertThat(unauthRes.code()).isEqualTo(401);

            // Register user and login
            client.post("/api/user/register", "{\"username\":\"aichatuser\", \"password\":\"secret\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"aichatuser\", \"password\":\"secret\"}");
            String token = loginRes.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 2. Missing provider -> 400
            var missingProviderRes = client.post("/api/ai/chat/stream", "{}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(missingProviderRes.code()).isEqualTo(400);
            assertThat(missingProviderRes.body().string()).contains("Missing provider");

            // 3. Settings not configured -> 400
            var notConfiguredRes = client.post("/api/ai/chat/stream", "{\"provider\":\"OPENAI\",\"messages\":[]}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(notConfiguredRes.code()).isEqualTo(400);
            assertThat(notConfiguredRes.body().string()).contains("AI Settings not configured");
        });
    }

    @Test
    void testFtcMatchesProxyEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Unauthenticated request -> 401
            var unauthRes = client.get("/api/ftc/2025/matches/TEST_CODE");
            assertThat(unauthRes.code()).isEqualTo(401);

            // Register user and login
            client.post("/api/user/register", "{\"username\":\"ftcuser\", \"password\":\"secret\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"ftcuser\", \"password\":\"secret\"}");
            String token = loginRes.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 2. Invalid season format -> 400
            var badSeasonRes = client.get("/api/ftc/abc/matches/TEST_CODE", b -> b.header("Authorization", "Bearer " + token));
            assertThat(badSeasonRes.code()).isEqualTo(400);

            // 2.1. Invalid eventCode format -> 400
            var badEventCodeRes = client.get("/api/ftc/2025/matches/TEST%20CODE%20BAD!", b -> b.header("Authorization", "Bearer " + token));
            assertThat(badEventCodeRes.code()).isEqualTo(400);

            // 3. Valid authenticated request -> 200 (returns array)
            var validRes = client.get("/api/ftc/2025/matches/TEST_NOT_FOUND", b -> b.header("Authorization", "Bearer " + token));
            assertThat(validRes.code()).isEqualTo(200);
            assertThat(validRes.body().string()).isEqualTo("[]");
        });
    }

    @Test
    void testTeamTagEndpoints() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Setup host and event
            client.post("/api/user/register", "{\"username\":\"taghost\", \"password\":\"secret\"}");
            var hostLoginRes = client.post("/api/user/login", "{\"username\":\"taghost\", \"password\":\"secret\"}");
            String hostToken = hostLoginRes.body().string().split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Tag Event\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Setup second user (scout)
            client.post("/api/user/register", "{\"username\":\"tagscout\", \"password\":\"secret\"}");
            var scoutLoginRes = client.post("/api/user/login", "{\"username\":\"tagscout\", \"password\":\"secret\"}");
            String scoutToken = scoutLoginRes.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 3. Add tag (by scout)
            var addPresetRes = client.post(
                "/api/events/" + eventId + "/teams/27570/tags",
                "{\"tag\":\"dual_motor_hang\", \"color\":\"green\"}",
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(addPresetRes.code()).isEqualTo(200);
            assertThat(addPresetRes.body().string()).contains("dual_motor_hang");

            // 4. Add custom tag with normalization (trim + lowercase) (V26)
            var addCustomRes = client.post(
                "/api/events/" + eventId + "/teams/27570/tags",
                "{\"tag\":\"  Fast_Intake  \", \"color\":\"orange\"}",
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(addCustomRes.code()).isEqualTo(200);
            assertThat(addCustomRes.body().string()).contains("fast_intake");

            // 5. Validation: Custom tag containing '.' is rejected (V27)
            var dotCustomRes = client.post(
                "/api/events/" + eventId + "/teams/27570/tags",
                "{\"tag\":\"invalid.tag.name\", \"color\":\"red\"}",
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(dotCustomRes.code()).isEqualTo(400);

            // 6. Validation: Tag > 30 chars is rejected (V15)
            var longTagRes = client.post(
                "/api/events/" + eventId + "/teams/27570/tags",
                "{\"tag\":\"" + "a".repeat(35) + "\"}",
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(longTagRes.code()).isEqualTo(400);

            // 7. Get all tags for event
            var getTagsRes = client.get("/api/events/" + eventId + "/tags", b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(getTagsRes.code()).isEqualTo(200);
            assertThat(getTagsRes.body().string()).contains("dual_motor_hang");
            assertThat(getTagsRes.body().string()).contains("fast_intake");

            // 8. Setup third user (unauthorized third-party scout)
            client.post("/api/user/register", "{\"username\":\"other_scout\", \"password\":\"secret\"}");
            var otherLoginRes = client.post("/api/user/login", "{\"username\":\"other_scout\", \"password\":\"secret\"}");
            String otherToken = otherLoginRes.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 9. Unauthorized delete returns 403 (V30)
            var unauthDeleteRes = client.delete(
                "/api/events/" + eventId + "/teams/27570/tags/fast_intake",
                null,
                b -> b.header("Authorization", "Bearer " + otherToken)
            );
            assertThat(unauthDeleteRes.code()).isEqualTo(403);

            // 10. Creator delete succeeds (V30)
            var creatorDeleteRes = client.delete(
                "/api/events/" + eventId + "/teams/27570/tags/fast_intake",
                null,
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(creatorDeleteRes.code()).isEqualTo(200);

            // 11. Idempotent delete (deleting non-existent tag returns 200) (V23)
            var idempotentDeleteRes = client.delete(
                "/api/events/" + eventId + "/teams/27570/tags/non_existent_tag",
                null,
                b -> b.header("Authorization", "Bearer " + scoutToken)
            );
            assertThat(idempotentDeleteRes.code()).isEqualTo(200);

            // 12. Host delete succeeds even if created by scout (V30)
            var hostDeleteRes = client.delete(
                "/api/events/" + eventId + "/teams/27570/tags/dual_motor_hang",
                null,
                b -> b.header("Authorization", "Bearer " + hostToken)
            );
            assertThat(hostDeleteRes.code()).isEqualTo(200);

            // 13. Verify all deleted
            var finalTagsRes = client.get("/api/events/" + eventId + "/tags", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(finalTagsRes.body().string()).isEqualTo("[]");
        });
    }

    @Test
    void testUserRenameEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register Alice
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass123\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String oldToken = regRes.body().string().split("\"token\":\"")[1].split("\"")[0];
            String oldId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Create Event & Record
            var eventRes = client.post("/api/events", "{\"name\":\"Championship 2026\"}", b -> b.header("Authorization", "Bearer " + oldToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            String syncPayload = "[{\"id\":\"rec_alice_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldId + "\",\"scoutName\":\"Alice\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":150,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + oldToken));
            assertThat(syncRes.code()).isEqualTo(200);

            // 3. Rename Alice -> Alice-88
            String newUsername = "Alice-88";
            String renamePayload = "{\"newUsername\":\"" + newUsername + "\"}";

            var renameRes = client.post("/api/user/rename", renamePayload, b -> b.header("Authorization", "Bearer " + oldToken));
            assertThat(renameRes.code()).isEqualTo(200);
            String renameBody = renameRes.body().string();
            String newToken = renameBody.split("\"token\":\"")[1].split("\"")[0];
            assertThat(renameBody).contains("\"id\":\"" + oldId + "\"");
            assertThat(renameBody).contains("\"username\":\"Alice-88\"");

            // 4. Verify in DB that user ID remained oldId while username updated, records kept oldId as scout_id
            jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", oldId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("Alice-88");

                var evt = handle.createQuery("SELECT * FROM events WHERE id = :id").bind("id", eventId).mapToMap().one();
                assertThat(evt.get("host_id")).isEqualTo(oldId);

                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_alice_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(oldId);
                assertThat(rec.get("scout_name")).isEqualTo("Alice-88");
            });

            // 5. Verify new token works for authenticated requests
            var listEventsRes = client.get("/api/events", b -> b.header("Authorization", "Bearer " + newToken));
            assertThat(listEventsRes.code()).isEqualTo(200);
            assertThat(listEventsRes.body().string()).contains(eventId);
        });
    }

    @Test
    void testUserModifyPasswordAndUsernameEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register Bob
            var regRes = client.post("/api/user/register", "{\"username\":\"Bob\", \"password\":\"BobOldPass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String token = regRes.body().string().split("\"token\":\"")[1].split("\"")[0];
            String oldId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Try to change password with wrong old password -> 401
            String badPayload = "{\"newUsername\":\"BobSuper\",\"oldPassword\":\"WrongPass\",\"newPassword\":\"BobNewPass\"}";
            var badRes = client.post("/api/user/rename", badPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(badRes.code()).isEqualTo(401);

            // 3. Change both username and password with correct old password -> 200
            String newUsername = "BobSuper";
            String newPass = "BobNewPass";
            String goodPayload = "{\"newUsername\":\"" + newUsername + "\",\"oldPassword\":\"BobOldPass\",\"newPassword\":\"" + newPass + "\"}";

            var goodRes = client.post("/api/user/rename", goodPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(goodRes.code()).isEqualTo(200);
            assertThat(goodRes.body().string()).contains("\"id\":\"" + oldId + "\"");

            // 4. Verify login succeeds with new username and new password, returning same oldId
            var loginRes = client.post("/api/user/login", "{\"username\":\"" + newUsername + "\", \"password\":\"" + newPass + "\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + oldId + "\"");
        });
    }

    @Test
    void testHostMigrateScoutRecords() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Host creates event
            var hostReg = client.post("/api/user/register", "{\"username\":\"HostBoss\", \"password\":\"BossPass\"}");
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];
            var eventRes = client.post("/api/events", "{\"name\":\"State Championship\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 2. Scout Alice syncs 2 records to Host
            String oldScoutId = "scout_alice_old_uuid";
            String syncPayload = "[{\"id\":\"rec_alice_m1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldScoutId + "\",\"scoutName\":\"Alice\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":120,\"version\":1},"
                    + "{\"id\":\"rec_alice_m2\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldScoutId + "\",\"scoutName\":\"Alice\",\"matchNumber\":2,\"teamNumber\":27570,\"totalScore\":135,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(syncRes.code()).isEqualTo(200);

            // 3. Host receives migration request when Alice renames to Alice-88
            String newScoutId = "scout_alice_new_uuid_88";
            String migratePayload = "{\"eventId\":\"" + eventId + "\",\"oldScoutId\":\"" + oldScoutId + "\",\"newScoutId\":\"" + newScoutId + "\",\"newScoutName\":\"Alice-88\"}";

            var migrateRes = client.post("/api/records/migrate-scout", migratePayload, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(migrateRes.code()).isEqualTo(200);

            // 4. Verify in DB that all records for oldScoutId are migrated to newScoutId & newScoutName with bumped version
            jdbi.useHandle(handle -> {
                var records = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = :eventId AND scout_id = :scoutId ORDER BY match_number")
                        .bind("eventId", eventId)
                        .bind("scoutId", newScoutId)
                        .mapToMap()
                        .list();
                assertThat(records).hasSize(2);
                assertThat(records.get(0).get("scout_name")).isEqualTo("Alice-88");
                assertThat(records.get(0).get("version")).isEqualTo(2);
                assertThat(records.get(1).get("scout_name")).isEqualTo("Alice-88");
                assertThat(records.get(1).get("version")).isEqualTo(2);

                // Zero records remain under oldScoutId
                var oldRecords = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = :eventId AND scout_id = :scoutId")
                        .bind("eventId", eventId)
                        .bind("scoutId", oldScoutId)
                        .mapToMap()
                        .list();
                assertThat(oldRecords).isEmpty();
            });
        });
    }

    @Test
    void testImmutableUserIdLifecycle() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register "TestScout" with password "InitPass"
            var regRes = client.post("/api/user/register", "{\"username\":\"TestScout\", \"password\":\"InitPass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String initialId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(initialId).isNotBlank();

            // 2. Case-insensitive login 1: lowercase "testscout"
            var loginLower = client.post("/api/user/login", "{\"username\":\"testscout\", \"password\":\"InitPass\"}");
            assertThat(loginLower.code()).isEqualTo(200);
            String idLower = loginLower.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(idLower).isEqualTo(initialId);

            // 3. Case-insensitive login 2: uppercase "TESTSCOUT" with whitespace
            var loginUpper = client.post("/api/user/login", "{\"username\":\"  TESTSCOUT  \", \"password\":\"InitPass\"}");
            assertThat(loginUpper.code()).isEqualTo(200);
            String idUpper = loginUpper.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(idUpper).isEqualTo(initialId);

            String token = loginLower.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 4. Create an event and a scouting record using initialId
            var eventRes = client.post("/api/events", "{\"name\":\"Test Championship\"}", b -> b.header("Authorization", "Bearer " + token));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            String syncPayload = "[{\"id\":\"rec_immut_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + initialId + "\",\"scoutName\":\"TestScout\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":100,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(syncRes.code()).isEqualTo(200);

            // 5. Update username (rename to "TestScout-Renamed")
            var renameRes = client.post("/api/user/rename", "{\"newUsername\":\"TestScout-Renamed\"}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(renameRes.code()).isEqualTo(200);
            String renameId = renameRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(renameId).isEqualTo(initialId);

            // 6. Change password to "NewPass123"
            var passRes = client.post("/api/user/rename", "{\"oldPassword\":\"InitPass\",\"newPassword\":\"NewPass123\"}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(passRes.code()).isEqualTo(200);
            String passId = passRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(passId).isEqualTo(initialId);

            // 7. Login with new username and new password
            var loginNew = client.post("/api/user/login", "{\"username\":\"TestScout-Renamed\", \"password\":\"NewPass123\"}");
            assertThat(loginNew.code()).isEqualTo(200);
            String idFinal = loginNew.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(idFinal).isEqualTo(initialId);

            // 8. DB assertions: User ID never changed, records preserved under initialId
            jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", initialId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("TestScout-Renamed");

                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_immut_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(initialId);
                assertThat(rec.get("scout_name")).isEqualTo("TestScout-Renamed");
            });
        });
    }

    @Test
    void testIdempotentJoinEvent() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture fix = setupRoomFixture(client);

            // ScoutA joins again with the same inviteCode -> should be 200 OK without 500 duplicate key error
            var joinAgain1 = client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinAgain1.code()).isEqualTo(200);

            var joinAgain2 = client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinAgain2.code()).isEqualTo(200);

            // DB assertion: exactly 1 entry for (eventId, scoutAId) in event_users
            jdbi.useHandle(handle -> {
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
    void testAiTestConnectionSsrfAndPost() {
        // Direct unit check on isSafeUrl
        assertThat(ApiRoutes.isSafeUrl("http://192.168.1.1/api")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://10.0.0.1/api")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://169.254.169.254/latest/meta-data/")).isFalse();
        assertThat(ApiRoutes.isSafeUrl("http://localhost:7070/api")).isTrue();
        assertThat(ApiRoutes.isSafeUrl("https://api.openai.com/v1")).isTrue();

        JavalinTest.test(app, (server, client) -> {
            RoomFixture fix = setupRoomFixture(client);

            // POST /api/ai/test-connection with private IP baseUrl -> blocked by SSRF check (400)
            String ssrfPayload = "{\"provider\":\"OPENAI\",\"baseUrl\":\"http://192.168.1.100/v1\"}";
            var ssrfRes = client.post("/api/ai/test-connection", ssrfPayload, b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertThat(ssrfRes.code()).isEqualTo(400);
            assertThat(ssrfRes.body().string()).contains("SSRF");

            // POST /api/ai/test-connection missing provider -> 400
            var missingProviderRes = client.post("/api/ai/test-connection", "{}", b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertThat(missingProviderRes.code()).isEqualTo(400);
        });
    }

    @Test
    void testDistributedMultiDeviceJoinAndStubSync() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture fix = setupRoomFixture(client);

            // 1. Join with unknown inviteCode (distributed peer joining from another machine)
            String unknownCode = "EXTNET1";
            var joinRes = client.post("/api/events/join", "{\"inviteCode\":\"" + unknownCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertThat(joinRes.code()).isEqualTo(200);
            String body = joinRes.body().string();
            assertThat(body).contains("ext_EXTNET1");
            assertThat(body).contains("Remote Event (EXTNET1)");

            // 2. Official Host event metadata arrives via external-sync
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

            // 3. Verify stub is cleaned up and official event is linked to ScoutA
            jdbi.useHandle(handle -> {
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
    void testOrdinaryScoutCanSyncStampedRecords() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // ScoutA attempts to sync a record belonging to ScoutB WITH hostSeq = 10 (authoritative stamped record) -> 200 OK
            String stampedPayload = "[{\"id\":\"rec_stamped_b\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":5,\"teamNumber\":27570,\"totalScore\":155,\"version\":1,\"hostSeq\":10}]";
            var stampedRes = client.post("/api/records/sync", stampedPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(stampedRes.code()).isEqualTo(200);

            jdbi.useExtension(com.bear27570.app.dao.RecordDao.class, dao -> {
                var saved = dao.findById("rec_stamped_b");
                assertThat(saved).isNotNull();
                assertThat(saved.getHostSeq()).isEqualTo(10);
            });
        });
    }

    @Test
    void testOrdinaryScoutCannotAlterAuthorOfExistingRecordEvenWithHostSeq() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);

            // 1. Legitimate stamped record for ScoutB is synced
            String stampedPayload = "[{\"id\":\"rec_stamped_b2\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutBId + "\",\"matchNumber\":6,\"teamNumber\":27570,\"totalScore\":155,\"version\":1,\"hostSeq\":10}]";
            var res1 = client.post("/api/records/sync", stampedPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(res1.code()).isEqualTo(200);

            // 2. ScoutA attempts to alter the author of rec_stamped_b2 to scoutAId, forging hostSeq = 11 -> 403 Forbidden!
            String spoofPayload = "[{\"id\":\"rec_stamped_b2\",\"eventId\":\"" + f.eventId + "\",\"scoutId\":\"" + f.scoutAId + "\",\"matchNumber\":6,\"teamNumber\":27570,\"totalScore\":180,\"version\":2,\"hostSeq\":11}]";
            var spoofRes = client.post("/api/records/sync", spoofPayload, b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(spoofRes.code()).isEqualTo(403);
            assertThat(spoofRes.body().string()).contains("Cannot alter the author of an existing record");
        });
    }

    @Test
    void testWebRtcHandshakeTicketIssueAndVerifySuccess() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String alicePublicKey = "04a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";

            // 1. ScoutA requests a handshake ticket for the event with her public key
            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + alicePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticketBody = ticketReq.body().string();
            assertThat(ticketBody).contains("\"ticket\":\"");
            String ticket = ticketBody.split("\"ticket\":\"")[1].split("\"")[0];

            // 2. Host verifies ticket with matching public key
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
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String alicePublicKey = "04alice_legitimate_key_1234567890abcdef";
            String evePublicKey = "04eve_attacker_key_9999999999abcdef";

            // 1. Alice obtains legitimate ticket bound to alicePublicKey
            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + alicePublicKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticket = ticketReq.body().string().split("\"ticket\":\"")[1].split("\"")[0];

            // 2. Eve intercepts ticket and tries to use it with Eve's public key (Host checks with Host's session)
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
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            // Anonymous caller without Authorization header must be rejected with 401
            var verifyReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"dummy.jwt.ticket\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}");
            assertThat(verifyReq.code()).isEqualTo(401);
        });
    }

    @Test
    void testWebRtcVerifyTicketNonMemberCallerIsForbidden() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            // Authenticated user who is not a member of the event must be rejected with 403
            var verifyReq = client.post("/api/webrtc/verify-ticket",
                    "{\"ticket\":\"dummy.jwt.ticket\",\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(verifyReq.code()).isEqualTo(403);
            assertThat(verifyReq.body().string()).contains("Caller is not a member of this event");
        });
    }

    @Test
    void testWebRtcTicketCannotBeUsedForGeneralApiAccess() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String clientKey = "04test_key_12345";

            // 1. Get WebRTC handshake ticket
            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + clientKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.scoutAToken));
            assertThat(ticketReq.code()).isEqualTo(200);
            String ticket = ticketReq.body().string().split("\"ticket\":\"")[1].split("\"")[0];

            // 2. Attempt to use this scoped ticket to access /api/events
            var eventsReq = client.get("/api/events", b -> b.header("Authorization", "Bearer " + ticket));
            assertThat(eventsReq.code()).isEqualTo(401);

            // 3. Attempt to use this scoped ticket to access /api/records
            var recordsReq = client.get("/api/records?eventId=" + f.eventId, b -> b.header("Authorization", "Bearer " + ticket));
            assertThat(recordsReq.code()).isEqualTo(401);
        });
    }

    @Test
    void testWebRtcHandshakeTicketNonMemberIsForbidden() {
        JavalinTest.test(app, (server, client) -> {
            RoomFixture f = setupRoomFixture(client);
            String outsiderKey = "04outsider_key_12345";

            // Outsider attempts to request a ticket for an event they haven't joined
            var ticketReq = client.post("/api/webrtc/handshake-ticket",
                    "{\"eventId\":\"" + f.eventId + "\",\"ecdhPublicKey\":\"" + outsiderKey + "\"}",
                    b -> b.header("Authorization", "Bearer " + f.outsiderToken));
            assertThat(ticketReq.code()).isEqualTo(403);
            assertThat(ticketReq.body().string()).contains("User is not a member of this event");
        });
    }
}


