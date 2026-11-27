package com.bear27570.app.routes;

import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.UserUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mindrot.jbcrypt.BCrypt;

import static org.assertj.core.api.Assertions.assertThat;

class UserRoutesTest {

    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("test_user_routes");
    }

    @AfterEach
    void tearDown() {
        if (support != null) {
            support.close();
        }
    }

    @Test
    void testLogin() {
        JavalinTest.test(support.app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"alice\", \"password\":\"secret\"}");
            var response = client.post("/api/user/login", "{\"username\":\"alice\", \"password\":\"secret\"}");
            assertThat(response.code()).isEqualTo(200);
            assertThat(response.body().string()).contains("alice");
        });
    }

    @Test
    void testCaseInsensitiveLogin() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass123\"}");
            assertThat(regRes.code()).isEqualTo(200);

            var loginRes1 = client.post("/api/user/login", "{\"username\":\"alice\", \"password\":\"AlicePass123\"}");
            assertThat(loginRes1.code()).isEqualTo(200);
            assertThat(loginRes1.body().string()).contains("\"username\":\"Alice\"");

            var loginRes2 = client.post("/api/user/login", "{\"username\":\"ALICE\", \"password\":\"AlicePass123\"}");
            assertThat(loginRes2.code()).isEqualTo(200);
            assertThat(loginRes2.body().string()).contains("\"username\":\"Alice\"");
        });
    }

    @Test
    void testNumericPasswordAndMalformedJsonHandling() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"bob\", \"password\":123456}");
            assertThat(regRes.code()).isEqualTo(200);

            var loginRes = client.post("/api/user/login", "{\"username\":\"bob\", \"password\":123456}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"username\":\"bob\"");

            var malformedRes = client.post("/api/user/login", "{\"username\":");
            assertThat(malformedRes.code()).isEqualTo(400);
            assertThat(malformedRes.body().string()).contains("Invalid JSON body");
        });
    }

    @Test
    void testDuplicateUsernameRegistrationIsRejected() {
        JavalinTest.test(support.app, (server, client) -> {
            var reg1 = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"Pass1\"}");
            assertThat(reg1.code()).isEqualTo(200);

            var reg2 = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"Pass2\"}");
            assertThat(reg2.code()).isEqualTo(409);

            var reg3 = client.post("/api/user/register", "{\"username\":\"alice\", \"password\":\"Pass1\"}");
            assertThat(reg3.code()).isEqualTo(409);
        });
    }

    @Test
    void testLoginUnambiguousWithMultipleSameNamePlaceholders() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String primaryId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            support.jdbi.useExtension(UserDao.class, dao -> {
                dao.ensureScoutUserPlaceholder("scout_peer_1", "Alice");
                dao.ensureScoutUserPlaceholder("scout_peer_2", "Alice");
            });

            var checkRes = client.get("/api/user/check?username=Alice");
            assertThat(checkRes.code()).isEqualTo(200);
            assertThat(checkRes.body().string()).contains("\"exists\":true");

            var loginRes = client.post("/api/user/login", "{\"username\":\"Alice\", \"password\":\"AlicePass\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + primaryId + "\"");

            var wrongLogin = client.post("/api/user/login", "{\"username\":\"Alice\", \"password\":\"WrongPass\"}");
            assertThat(wrongLogin.code()).isEqualTo(401);
        });
    }

    @Test
    void testOrphanTokenReturns401AndDoesNotCrashWith500() {
        JavalinTest.test(support.app, (server, client) -> {
            String orphanToken = JwtUtil.generateToken("9601957e-2221-47a1-9e6f-5fe3ed518982", "NonExistentUser");

            var res = client.post("/api/events", "{\"name\":\"Should Fail Cleanly\"}", b -> b.header("Authorization", "Bearer " + orphanToken));
            assertThat(res.code()).isEqualTo(401);
            assertThat(res.body().string()).contains("User does not exist or database was reset");
        });
    }

    @Test
    void testMigratedUserTokenSelfHealsByUsernameAndUpdatesHostId() {
        JavalinTest.test(support.app, (server, client) -> {
            String oldLegacyUuid = "9601957e-2221-47a1-9e6f-5fe3ed518982";
            String username = "Lucalmz";
            String passwordHash = BCrypt.hashpw("123456", BCrypt.gensalt());

            support.jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", oldLegacyUuid, username, passwordHash);
            });

            String cachedClientToken = JwtUtil.generateToken(oldLegacyUuid, username);
            UserDeterministicIdMigrator.migrate(support.jdbi);

            String expectedDeterministicId = UserUtil.generateDeterministicUserId(username);
            support.jdbi.useHandle(handle -> {
                var oldUser = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", oldLegacyUuid).mapToMap().findOne();
                assertThat(oldUser).isEmpty();
                var newUser = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", expectedDeterministicId).mapToMap().findOne();
                assertThat(newUser).isPresent();
            });

            var res = client.post("/api/events", "{\"name\":\"Auto Healed Event\"}", b -> b.header("Authorization", "Bearer " + cachedClientToken));
            assertThat(res.code()).isEqualTo(200);
            assertThat(res.headers().get("X-Refreshed-Token")).isNotNull();

            String eventId = res.body().string().split("\"id\":\"")[1].split("\"")[0];
            support.jdbi.useHandle(handle -> {
                var evt = handle.createQuery("SELECT * FROM events WHERE id = :id").bind("id", eventId).mapToMap().one();
                assertThat(evt.get("host_id")).isEqualTo(expectedDeterministicId);
            });
        });
    }

    @Test
    void testPreserveLegacyUserIdOnLogin() {
        JavalinTest.test(support.app, (server, client) -> {
            String legacyId = "legacy-random-uuid-555";
            String username = "LegacyUser";
            String rawPassword = "LegacyPassword123";

            support.jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)",
                        legacyId, username, BCrypt.hashpw(rawPassword, BCrypt.gensalt()));
                handle.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        "evt_legacy", "Legacy Event", "LEG123", legacyId);
            });

            var loginRes = client.post("/api/user/login", "{\"username\":\"" + username + "\", \"password\":\"" + rawPassword + "\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + legacyId + "\"");

            support.jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", legacyId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo(username);

                var evt = handle.createQuery("SELECT * FROM events WHERE id = 'evt_legacy'").mapToMap().one();
                assertThat(evt.get("host_id")).isEqualTo(legacyId);
            });
        });
    }

    @Test
    void testVerifyTokenEndpoint() {
        JavalinTest.test(support.app, (server, client) -> {
            var regResponse = client.post("/api/user/register", "{\"username\":\"eva\", \"password\":\"secret\"}");
            String body = regResponse.body().string();
            String token = body.split("\"token\":\"")[1].split("\"")[0];
            String userId = body.split("\"id\":\"")[1].split("\"")[0];

            var validRes = client.post("/api/user/verify-token", "{\"token\":\"" + token + "\"}");
            assertThat(validRes.code()).isEqualTo(200);
            String validBody = validRes.body().string();
            assertThat(validBody).contains("\"valid\":true");
            assertThat(validBody).contains(userId);
            assertThat(validBody).contains("eva");

            String tamperedToken = token.substring(0, token.length() - 5) + "abcde";
            var tamperedRes = client.post("/api/user/verify-token", "{\"token\":\"" + tamperedToken + "\"}");
            assertThat(tamperedRes.code()).isEqualTo(401);

            var emptyRes = client.post("/api/user/verify-token", "{}");
            assertThat(emptyRes.code()).isEqualTo(400);
        });
    }

    @Test
    void testUserRenameEndpoint() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"Alice\", \"password\":\"AlicePass123\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String regBody = regRes.body().string();
            String oldToken = regBody.split("\"token\":\"")[1].split("\"")[0];
            String oldId = regBody.split("\"id\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Championship 2026\"}", b -> b.header("Authorization", "Bearer " + oldToken));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            String syncPayload = "[{\"id\":\"rec_alice_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + oldId + "\",\"scoutName\":\"Alice\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":150,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + oldToken));
            assertThat(syncRes.code()).isEqualTo(200);

            String renamePayload = "{\"newUsername\":\"Alice-88\"}";
            var renameRes = client.post("/api/user/rename", renamePayload, b -> b.header("Authorization", "Bearer " + oldToken));
            assertThat(renameRes.code()).isEqualTo(200);
            String renameBody = renameRes.body().string();
            String newToken = renameBody.split("\"token\":\"")[1].split("\"")[0];
            assertThat(renameBody).contains("\"id\":\"" + oldId + "\"");
            assertThat(renameBody).contains("\"username\":\"Alice-88\"");

            support.jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", oldId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("Alice-88");

                var evt = handle.createQuery("SELECT * FROM events WHERE id = :id").bind("id", eventId).mapToMap().one();
                assertThat(evt.get("host_id")).isEqualTo(oldId);

                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_alice_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(oldId);
                assertThat(rec.get("scout_name")).isEqualTo("Alice-88");
            });

            var listEventsRes = client.get("/api/events", b -> b.header("Authorization", "Bearer " + newToken));
            assertThat(listEventsRes.code()).isEqualTo(200);
            assertThat(listEventsRes.body().string()).contains(eventId);
        });
    }

    @Test
    void testUserModifyPasswordAndUsernameEndpoint() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"Bob\", \"password\":\"BobOldPass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String regBody = regRes.body().string();
            String token = regBody.split("\"token\":\"")[1].split("\"")[0];
            String oldId = regBody.split("\"id\":\"")[1].split("\"")[0];

            String badPayload = "{\"newUsername\":\"BobSuper\",\"oldPassword\":\"WrongPass\",\"newPassword\":\"BobNewPass\"}";
            var badRes = client.post("/api/user/rename", badPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(badRes.code()).isEqualTo(401);

            String goodPayload = "{\"newUsername\":\"BobSuper\",\"oldPassword\":\"BobOldPass\",\"newPassword\":\"BobNewPass\"}";
            var goodRes = client.post("/api/user/rename", goodPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(goodRes.code()).isEqualTo(200);
            assertThat(goodRes.body().string()).contains("\"id\":\"" + oldId + "\"");

            var loginRes = client.post("/api/user/login", "{\"username\":\"BobSuper\", \"password\":\"BobNewPass\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            assertThat(loginRes.body().string()).contains("\"id\":\"" + oldId + "\"");
        });
    }

    @Test
    void testImmutableUserIdLifecycle() {
        JavalinTest.test(support.app, (server, client) -> {
            var regRes = client.post("/api/user/register", "{\"username\":\"TestScout\", \"password\":\"InitPass\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String initialId = regRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            assertThat(initialId).isNotBlank();

            var loginLower = client.post("/api/user/login", "{\"username\":\"testscout\", \"password\":\"InitPass\"}");
            assertThat(loginLower.code()).isEqualTo(200);
            String lowerBody = loginLower.body().string();
            assertThat(lowerBody.split("\"id\":\"")[1].split("\"")[0]).isEqualTo(initialId);

            var loginUpper = client.post("/api/user/login", "{\"username\":\"  TESTSCOUT  \", \"password\":\"InitPass\"}");
            assertThat(loginUpper.code()).isEqualTo(200);
            assertThat(loginUpper.body().string().split("\"id\":\"")[1].split("\"")[0]).isEqualTo(initialId);

            String token = lowerBody.split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Test Championship\"}", b -> b.header("Authorization", "Bearer " + token));
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];
            String syncPayload = "[{\"id\":\"rec_immut_1\",\"eventId\":\"" + eventId + "\",\"scoutId\":\"" + initialId + "\",\"scoutName\":\"TestScout\",\"matchNumber\":1,\"teamNumber\":27570,\"totalScore\":100,\"version\":1}]";
            var syncRes = client.post("/api/records/sync", syncPayload, b -> b.header("Authorization", "Bearer " + token));
            assertThat(syncRes.code()).isEqualTo(200);

            var renameRes = client.post("/api/user/rename", "{\"newUsername\":\"TestScout-Renamed\"}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(renameRes.code()).isEqualTo(200);
            assertThat(renameRes.body().string().split("\"id\":\"")[1].split("\"")[0]).isEqualTo(initialId);

            var passRes = client.post("/api/user/rename", "{\"oldPassword\":\"InitPass\",\"newPassword\":\"NewPass123\"}", b -> b.header("Authorization", "Bearer " + token));
            assertThat(passRes.code()).isEqualTo(200);
            assertThat(passRes.body().string().split("\"id\":\"")[1].split("\"")[0]).isEqualTo(initialId);

            var loginNew = client.post("/api/user/login", "{\"username\":\"TestScout-Renamed\", \"password\":\"NewPass123\"}");
            assertThat(loginNew.code()).isEqualTo(200);
            assertThat(loginNew.body().string().split("\"id\":\"")[1].split("\"")[0]).isEqualTo(initialId);

            support.jdbi.useHandle(handle -> {
                var user = handle.createQuery("SELECT * FROM users WHERE id = :id").bind("id", initialId).mapToMap().one();
                assertThat(user.get("username")).isEqualTo("TestScout-Renamed");

                var rec = handle.createQuery("SELECT * FROM scouting_records WHERE id = 'rec_immut_1'").mapToMap().one();
                assertThat(rec.get("scout_id")).isEqualTo(initialId);
                assertThat(rec.get("scout_name")).isEqualTo("TestScout-Renamed");
            });
        });
    }

    @Test
    void testWhitespacePasswordMergeRename72CharLimitAndTrimmedUsernameLength() {
        JavalinTest.test(support.app, (server, client) -> {
            // 1. Trimmed username length <= 50 succeeds even with padding spaces; 51 trimmed chars fails with 400
            String fiftyCharName = "u".repeat(50);
            var paddedOk = client.post("/api/user/register",
                    "{\"username\":\"  " + fiftyCharName + "  \", \"password\":\"ValidPass1\"}");
            assertThat(paddedOk.code()).isEqualTo(200);

            var fiftyOneFail = client.post("/api/user/register",
                    "{\"username\":\"" + "z".repeat(51) + "\", \"password\":\"ValidPass1\"}");
            assertThat(fiftyOneFail.code()).isEqualTo(400);

            // 2. Password with leading/trailing spaces works consistently across register -> login -> merge
            var targetReg = client.post("/api/user/register",
                    "{\"username\":\"SpaceTarget\", \"password\":\"  SpaceSecret99  \"}");
            assertThat(targetReg.code()).isEqualTo(200);
            String targetId = targetReg.body().string().split("\"id\":\"")[1].split("\"")[0];

            // Trimmed password MUST fail login (proving spaces are part of password)
            assertThat(client.post("/api/user/login",
                    "{\"username\":\"SpaceTarget\", \"password\":\"SpaceSecret99\"}").code()).isEqualTo(401);
            assertThat(client.post("/api/user/login",
                    "{\"username\":\"SpaceTarget\", \"password\":\"  SpaceSecret99  \"}").code()).isEqualTo(200);

            var sourceReg = client.post("/api/user/register",
                    "{\"username\":\"SpaceSource\", \"password\":\"TempPass\"}");
            assertThat(sourceReg.code()).isEqualTo(200);
            String sourceToken = sourceReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            // Rename > 72-char newPassword MUST return 400 instead of silently truncating
            var overlongRename = client.post("/api/user/rename",
                    "{\"oldPassword\":\"TempPass\",\"newPassword\":\"" + "P".repeat(73) + "\"}",
                    b -> b.header("Authorization", "Bearer " + sourceToken));
            assertThat(overlongRename.code()).isEqualTo(400);
            assertThat(overlongRename.body().string()).contains("newPassword too long");

            // Merge with exact untrimmed targetPassword succeeds
            var mergeRes = client.post("/api/user/merge",
                    "{\"targetUsername\":\"SpaceTarget\",\"targetPassword\":\"  SpaceSecret99  \"}",
                    b -> b.header("Authorization", "Bearer " + sourceToken));
            assertThat(mergeRes.code()).isEqualTo(200);
            assertThat(mergeRes.body().string()).contains("\"id\":\"" + targetId + "\"");
        });
    }

    @Test
    void testGlobalAuthFilterAndVerifyTokenDeletedUser404() {
        JavalinTest.test(support.app, (server, client) -> {
            // Missing or invalid JWT returns 401 on protected endpoint
            assertThat(client.get("/api/events").code()).isEqualTo(401);
            assertThat(client.get("/api/events", b -> b.header("Authorization", "Bearer invalid.jwt.token")).code()).isEqualTo(401);

            // Register, verify 200, then delete user from DB -> verify-token returns 404
            var regRes = client.post("/api/user/register", "{\"username\":\"ghost_check\",\"password\":\"Pass123\"}");
            assertThat(regRes.code()).isEqualTo(200);
            String regBody = regRes.body().string();
            String token = regBody.split("\"token\":\"")[1].split("\"")[0];
            String userId = regBody.split("\"id\":\"")[1].split("\"")[0];

            assertThat(client.post("/api/user/verify-token", "{\"token\":\"" + token + "\"}").code()).isEqualTo(200);

            support.jdbi.useHandle(h -> h.createUpdate("DELETE FROM users WHERE id = :id").bind("id", userId).execute());
            assertThat(client.post("/api/user/verify-token", "{\"token\":\"" + token + "\"}").code()).isEqualTo(404);
            assertThat(client.get("/api/events", b -> b.header("Authorization", "Bearer " + token)).code()).isEqualTo(401);
        });
    }

    @Test
    void testRegisterReclaimsExternalSyncHostPlaceholderWithoutBreakingCollisionFallback() {
        JavalinTest.test(support.app, (server, client) -> {
            // 1. Register a scout client who syncs an external event authored by HostB before HostB registers
            var scoutReg = client.post("/api/user/register", "{\"username\":\"ClientScout\",\"password\":\"ClientPass123\"}");
            assertThat(scoutReg.code()).isEqualTo(200);
            String scoutToken = JsonParser.parseString(scoutReg.body().string())
                    .getAsJsonObject().get("token").getAsString();

            String hostUsername = "HostB";
            String deterministicHostId = UserUtil.generateDeterministicUserId(hostUsername);
            String expectedPlaceholderName = "Host " + deterministicHostId.substring(0, 6);

            String syncBody = "{\"id\":\"evt-external-hostb\",\"name\":\"HostB Championship\",\"inviteCode\":\"SYNC99\",\"hostId\":\""
                    + deterministicHostId + "\"}";
            var syncRes = client.post("/api/events/external-sync", syncBody,
                    b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(syncRes.code()).isEqualTo(200);

            support.jdbi.useHandle(h -> {
                var placeholder = h.createQuery("SELECT username, password FROM users WHERE id = :id")
                        .bind("id", deterministicHostId).mapToMap().one();
                assertThat(placeholder.get("username")).isEqualTo(expectedPlaceholderName);
                assertThat((String) placeholder.get("password")).isBlank();
            });

            // Positive precondition: non-host scout is rejected from host-only actions
            var scoutBanAttempt = client.post("/api/events/evt-external-hostb/banned-teams",
                    "{\"teamNumber\":27570}",
                    b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(scoutBanAttempt.code()).isEqualTo(403);

            // 2. HostB registers and MUST reclaim the deterministic hostId placeholder
            var hostReg = client.post("/api/user/register",
                    "{\"username\":\"" + hostUsername + "\",\"password\":\"HostBPass123\"}");
            assertThat(hostReg.code()).isEqualTo(200);
            JsonObject hostJson = JsonParser.parseString(hostReg.body().string()).getAsJsonObject();
            String reclaimedHostId = hostJson.get("id").getAsString();
            String hostToken = hostJson.get("token").getAsString();

            assertThat(reclaimedHostId).isEqualTo(deterministicHostId);
            assertThat(hostJson.get("username").getAsString()).isEqualTo(hostUsername);

            // HostB sees the synced event via GET /api/events with matching hostId and succeeds on host-only actions
            var hostEventsRes = client.get("/api/events", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(hostEventsRes.code()).isEqualTo(200);
            JsonArray events = JsonParser.parseString(hostEventsRes.body().string()).getAsJsonArray();
            assertThat(events).hasSize(1);
            JsonObject syncedEvent = events.get(0).getAsJsonObject();
            assertThat(syncedEvent.get("id").getAsString()).isEqualTo("evt-external-hostb");
            assertThat(syncedEvent.get("hostId").getAsString()).isEqualTo(deterministicHostId);

            var hostBanRes = client.post("/api/events/evt-external-hostb/banned-teams",
                    "{\"teamNumber\":27570}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(hostBanRes.code()).isEqualTo(200);

            // 3. Contrast A: Password-bearing account at deterministic ID (e.g. renamed user) must NOT be reclaimed
            var origReg = client.post("/api/user/register", "{\"username\":\"RenamedSource\",\"password\":\"OrigPass123\"}");
            assertThat(origReg.code()).isEqualTo(200);
            JsonObject origJson = JsonParser.parseString(origReg.body().string()).getAsJsonObject();
            String origId = origJson.get("id").getAsString();
            String origToken = origJson.get("token").getAsString();
            assertThat(client.post("/api/user/rename",
                    "{\"newUsername\":\"RenamedTarget\",\"oldPassword\":\"OrigPass123\"}",
                    b -> b.header("Authorization", "Bearer " + origToken)).code()).isEqualTo(200);

            var newcomerReg = client.post("/api/user/register", "{\"username\":\"RenamedSource\",\"password\":\"NewPass123\"}");
            assertThat(newcomerReg.code()).isEqualTo(200);
            String newcomerId = JsonParser.parseString(newcomerReg.body().string())
                    .getAsJsonObject().get("id").getAsString();
            assertThat(newcomerId).isNotEqualTo(origId);

            // 4. Contrast B: Unrelated passwordless username placeholder at deterministic ID must NOT be reclaimed
            String otherHostName = "OtherHost";
            String otherHostDetId = UserUtil.generateDeterministicUserId(otherHostName);
            support.jdbi.useExtension(UserDao.class, dao ->
                    dao.ensureScoutUserPlaceholder(otherHostDetId, "UnrelatedScoutName"));

            var otherHostReg = client.post("/api/user/register",
                    "{\"username\":\"" + otherHostName + "\",\"password\":\"OtherPass123\"}");
            assertThat(otherHostReg.code()).isEqualTo(200);
            String allocatedId = JsonParser.parseString(otherHostReg.body().string())
                    .getAsJsonObject().get("id").getAsString();
            assertThat(allocatedId).isNotEqualTo(otherHostDetId);

            support.jdbi.useHandle(h -> {
                var untouched = h.createQuery("SELECT username FROM users WHERE id = :id")
                        .bind("id", otherHostDetId).mapTo(String.class).one();
                assertThat(untouched).isEqualTo("UnrelatedScoutName");
            });
        });
    }
}
