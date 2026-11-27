package com.bear27570.app.routes;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Anti-regression tests for adjudicated production bugs (#15 on swarm board).
 * Each test asserts positive baseline preconditions before exercising negative/security paths.
 */
class BugFixRegressionTest {

    private static final Gson GSON = new Gson();
    private RouteTestSupport support;

    @BeforeEach
    void setUp() {
        support = new RouteTestSupport("bug_fix_reg");
    }

    @AfterEach
    void tearDown() {
        support.close();
    }

    @Test
    void registerAfterRename_allocatesFreshUuidWithoutOverwritingRenamedUserAccount() {
        JavalinTest.test(support.app, (server, client) -> {
            // Precondition: register Alice, verify login and rename to alice_new
            var regAlice = client.post("/api/user/register",
                    "{\"username\":\"alice\",\"password\":\"AlicePass123\"}");
            assertEquals(200, regAlice.code());
            JsonObject aliceObj = JsonParser.parseString(regAlice.body().string()).getAsJsonObject();
            String aliceId = aliceObj.get("id").getAsString();
            String aliceToken = aliceObj.get("token").getAsString();

            var renameRes = client.post("/api/user/rename",
                    "{\"newUsername\":\"alice_new\",\"oldPassword\":\"AlicePass123\"}",
                    b -> b.header("Authorization", "Bearer " + aliceToken));
            assertEquals(200, renameRes.code());

            // Precondition: Alice creates a private event owned by aliceId
            var createEvt = client.post("/api/events", "{\"name\":\"Alice Private Event\"}",
                    b -> b.header("Authorization", "Bearer " + aliceToken));
            assertEquals(200, createEvt.code());
            String eventId = JsonParser.parseString(createEvt.body().string()).getAsJsonObject().get("id").getAsString();

            // Precondition: alice_new logs in cleanly, old username login fails
            var loginNew = client.post("/api/user/login",
                    "{\"username\":\"alice_new\",\"password\":\"AlicePass123\"}");
            assertEquals(200, loginNew.code());
            assertEquals(aliceId, JsonParser.parseString(loginNew.body().string()).getAsJsonObject().get("id").getAsString());
            assertEquals(401, client.post("/api/user/login",
                    "{\"username\":\"alice\",\"password\":\"AlicePass123\"}").code());

            // Attack / collision: another user registers the now-free username "alice"
            var regAttacker = client.post("/api/user/register",
                    "{\"username\":\"alice\",\"password\":\"AttackerPass999\"}");
            assertEquals(200, regAttacker.code());
            JsonObject attackerObj = JsonParser.parseString(regAttacker.body().string()).getAsJsonObject();
            String attackerId = attackerObj.get("id").getAsString();
            String attackerToken = attackerObj.get("token").getAsString();

            // Anti-regression: deterministic ID collision must allocate a fresh UUID, never overwrite aliceId
            assertNotEquals(aliceId, attackerId);

            // Alice's renamed account and password must remain intact
            var aliceStillLogsIn = client.post("/api/user/login",
                    "{\"username\":\"alice_new\",\"password\":\"AlicePass123\"}");
            assertEquals(200, aliceStillLogsIn.code());
            assertEquals(aliceId, JsonParser.parseString(aliceStillLogsIn.body().string())
                    .getAsJsonObject().get("id").getAsString());

            // Attacker must NOT inherit host privileges on Alice's event
            var hijackSchedule = client.post("/api/events/" + eventId + "/schedule/batch",
                    "{\"items\":[]}",
                    b -> b.header("Authorization", "Bearer " + attackerToken));
            assertEquals(403, hijackSchedule.code());
        });
    }

    @Test
    void migrateScout_enforcesEventExistence_callerAuth_andPreservesRegisteredUsers() {
        JavalinTest.test(support.app, (server, client) -> {
            RouteTestSupport.RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            // Precondition: scoutA saves a scouting record in fix.eventId
            String recId = "rec-mig-1";
            var saveRec = client.post("/api/records", GSON.toJson(Map.of(
                    "id", recId,
                    "eventId", fix.eventId,
                    "matchNumber", 3,
                    "teamNumber", 254,
                    "scoutId", fix.scoutAId,
                    "scoutName", "ScoutA"
            )), b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertEquals(200, saveRec.code());

            // 1) Non-existent event must return 404
            var missingEventRes = client.post("/api/records/migrate-scout", GSON.toJson(Map.of(
                    "eventId", "non-existent-event-999",
                    "oldScoutId", fix.scoutAId,
                    "newScoutId", fix.hostId,
                    "newScoutName", "Host"
            )), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(404, missingEventRes.code());

            // 2) Outsider specifying callerId == newScoutId must be rejected 403
            var outsiderRes = client.post("/api/records/migrate-scout", GSON.toJson(Map.of(
                    "eventId", fix.eventId,
                    "oldScoutId", fix.scoutAId,
                    "newScoutId", fix.outsiderId,
                    "newScoutName", "Outsider"
            )), b -> b.header("Authorization", "Bearer " + fix.outsiderToken));
            assertEquals(403, outsiderRes.code());

            // 3) Fellow member scoutB specifying callerId == newScoutId (but not oldScoutId or host) must be rejected 403
            var memberStealRes = client.post("/api/records/migrate-scout", GSON.toJson(Map.of(
                    "eventId", fix.eventId,
                    "oldScoutId", fix.scoutAId,
                    "newScoutId", fix.scoutBId,
                    "newScoutName", "ScoutB"
            )), b -> b.header("Authorization", "Bearer " + fix.scoutBToken));
            assertEquals(403, memberStealRes.code());

            // Positive precondition check: record still owned by scoutA
            String ownerBefore = support.jdbi.withHandle(h ->
                    h.createQuery("SELECT scout_id FROM scouting_records WHERE id = :id")
                            .bind("id", recId).mapTo(String.class).one());
            assertEquals(fix.scoutAId, ownerBefore);

            // 4) Host migrates registered user scoutA -> placeholder "placeholder_target"
            var hostMigrateRes = client.post("/api/records/migrate-scout", GSON.toJson(Map.of(
                    "eventId", fix.eventId,
                    "oldScoutId", fix.scoutAId,
                    "newScoutId", "placeholder_target",
                    "newScoutName", "Migrated Scout"
            )), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(200, hostMigrateRes.code());

            String ownerAfter = support.jdbi.withHandle(h ->
                    h.createQuery("SELECT scout_id FROM scouting_records WHERE id = :id")
                            .bind("id", recId).mapTo(String.class).one());
            assertEquals("placeholder_target", ownerAfter);

            // Registered user scoutA MUST NOT be deleted by UserDeterministicIdMigrator.mergeUserInto
            Integer scoutAUserCount = support.jdbi.withHandle(h ->
                    h.createQuery("SELECT COUNT(*) FROM users WHERE id = :id")
                            .bind("id", fix.scoutAId).mapTo(Integer.class).one());
            assertEquals(1, scoutAUserCount);

            // 5) Self-migration: scoutB migrates own scoutB -> "scoutB_alias" succeeds
            var selfMigrateRes = client.post("/api/records/migrate-scout", GSON.toJson(Map.of(
                    "eventId", fix.eventId,
                    "oldScoutId", fix.scoutBId,
                    "newScoutId", "scoutB_alias",
                    "newScoutName", "Scout B Alias"
            )), b -> b.header("Authorization", "Bearer " + fix.scoutBToken));
            assertEquals(200, selfMigrateRes.code());
        });
    }

    @Test
    void crossEventRecordIdOverwrite_blockedAcrossRestPitAndCrdt() {
        JavalinTest.test(support.app, (server, client) -> {
            RouteTestSupport.RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            // Create second event B hosted by same host, joined by scoutA
            var eventBRes = client.post("/api/events", "{\"name\":\"Event Bravo\"}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(200, eventBRes.code());
            JsonObject eventBObj = JsonParser.parseString(eventBRes.body().string()).getAsJsonObject();
            String eventBId = eventBObj.get("id").getAsString();
            String eventBCode = eventBObj.get("inviteCode").getAsString();
            assertEquals(200, client.post("/api/events/join", "{\"inviteCode\":\"" + eventBCode + "\"}",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            // Precondition: create match record, pit record, and CRDT-projected record in eventA
            String recId = "shared-rec-id-1";
            String pitId = "shared-pit-id-1";
            assertEquals(200, client.post("/api/records", GSON.toJson(Map.of(
                    "id", recId,
                    "eventId", fix.eventId,
                    "matchNumber", 1,
                    "teamNumber", 1111,
                    "scoutId", fix.scoutAId,
                    "scoutName", "ScoutA"
            )), b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            assertEquals(200, client.post("/api/events/" + fix.eventId + "/pit-records", GSON.toJson(Map.of(
                    "id", pitId,
                    "teamNumber", 1111,
                    "scoutId", fix.scoutAId,
                    "robotName", "Event A Pit Bot"
            )), b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            // Verify positive control: both exist under eventA
            assertTrue(client.get("/api/records?eventId=" + fix.eventId,
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).body().string().contains(recId));
            assertTrue(client.get("/api/events/" + fix.eventId + "/pit-records",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).body().string().contains(pitId));

            // 1) POST /api/records trying to reuse recId in eventB -> 403
            var crossRec = client.post("/api/records", GSON.toJson(Map.of(
                    "id", recId,
                    "eventId", eventBId,
                    "matchNumber", 9,
                    "teamNumber", 9999,
                    "scoutId", fix.scoutAId
            )), b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertEquals(403, crossRec.code());

            // 2) POST /api/records/sync trying to reuse recId in eventB -> 403
            var crossSync = client.post("/api/records/sync", GSON.toJson(List.of(Map.of(
                    "id", recId,
                    "eventId", eventBId,
                    "matchNumber", 9,
                    "teamNumber", 9999,
                    "scoutId", fix.scoutAId
            ))), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(403, crossSync.code());

            // 3) POST pit-records & pit-records/batch trying to reuse pitId in eventB -> 403
            var crossPit = client.post("/api/events/" + eventBId + "/pit-records", GSON.toJson(Map.of(
                    "id", pitId,
                    "teamNumber", 9999,
                    "robotName", "Hijacked Pit Bot"
            )), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(403, crossPit.code());

            var crossPitBatch = client.post("/api/events/" + eventBId + "/pit-records/batch", GSON.toJson(List.of(Map.of(
                    "id", pitId,
                    "teamNumber", 9999,
                    "robotName", "Hijacked Batch Pit Bot"
            ))), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(403, crossPitBatch.code());

            // 4) CRDT project on eventB with recId must ignore cross-event row even when called by Host
            JsonObject rowFields = new JsonObject();
            rowFields.addProperty("id", recId);
            rowFields.addProperty("matchNumber", 88);
            rowFields.addProperty("teamNumber", 8888);
            rowFields.addProperty("scoutId", fix.hostId);
            rowFields.addProperty("scoutName", "Host");
            rowFields.addProperty("version", 99);
            JsonArray rowStamp = new JsonArray();
            rowStamp.add(rowFields);
            JsonObject rowsObj = new JsonObject();
            rowsObj.add(recId, rowStamp);
            JsonArray tableStamp = new JsonArray();
            tableStamp.add(rowsObj);
            JsonObject tablesObj = new JsonObject();
            tablesObj.add("scouting_records", tableStamp);
            JsonArray tablesStamp = new JsonArray();
            tablesStamp.add(tablesObj);
            JsonArray snapshotRoot = new JsonArray();
            snapshotRoot.add(tablesStamp);

            JsonObject crdtBody = new JsonObject();
            crdtBody.add("snapshot", snapshotRoot);
            crdtBody.addProperty("hostEpoch", 1);
            crdtBody.addProperty("snapshotRevision", 1);
            crdtBody.addProperty("fullProjection", true);

            var crossCrdt = client.put("/api/events/" + eventBId + "/crdt-state", crdtBody.toString(),
                    b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(200, crossCrdt.code());

            // Verify both recId and pitId remain untouched in eventA with original teamNumber 1111
            Map<String, Object> recRow = support.jdbi.withHandle(h ->
                    h.createQuery("SELECT event_id, team_number FROM scouting_records WHERE id = :id")
                            .bind("id", recId).mapToMap().one());
            assertEquals(fix.eventId, recRow.get("event_id"));
            assertEquals(1111, ((Number) recRow.get("team_number")).intValue());

            Map<String, Object> pitRow = support.jdbi.withHandle(h ->
                    h.createQuery("SELECT event_id, team_number, robot_name FROM pit_scouting_records WHERE id = :id")
                            .bind("id", pitId).mapToMap().one());
            assertEquals(fix.eventId, pitRow.get("event_id"));
            assertEquals(1111, ((Number) pitRow.get("team_number")).intValue());
            assertEquals("Event A Pit Bot", pitRow.get("robot_name"));
        });
    }

    @Test
    void externalSync_cannotHijackAuthoritativeEvtEventOrRegisteredExtStub() {
        JavalinTest.test(support.app, (server, client) -> {
            RouteTestSupport.RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            // Precondition 1: Create authoritative evt-* event owned by host with inviteCode "AUTH01"
            support.jdbi.useHandle(h -> {
                h.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        "evt-authoritative-1", "Auth Evt", "AUTH01", fix.hostId);
                h.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)",
                        "evt-authoritative-1", fix.hostId);
            });

            // Precondition 2: Create ext_* event owned by registered host with inviteCode "REGEXT"
            support.jdbi.useHandle(h -> {
                h.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        "ext_REGEXT", "Registered Ext Stub", "REGEXT", fix.hostId);
                h.execute("INSERT INTO event_users (event_id, user_id) VALUES (?, ?)",
                        "ext_REGEXT", fix.hostId);
            });

            // Precondition 3: Create true external_host placeholder stub with inviteCode "OPEN03"
            support.jdbi.useHandle(h -> {
                h.execute("MERGE INTO users (id, username) KEY(id) VALUES ('external_host', 'external_host')");
                h.execute("INSERT INTO events (id, name, invite_code, host_id) VALUES (?, ?, ?, ?)",
                        "ext_OPEN03", "Unclaimed Stub", "OPEN03", "external_host");
            });

            // Attack 1: Host itself or outsider tries to steal AUTH01 via external-sync on evt-authoritative-1
            var stealEvt = client.post("/api/events/external-sync", GSON.toJson(Map.of(
                    "id", "evt-hijacker-new",
                    "name", "Hijacked",
                    "inviteCode", "AUTH01"
            )), b -> b.header("Authorization", "Bearer " + fix.outsiderToken));
            assertEquals(403, stealEvt.code());

            // Attack 2: Outsider tries to steal REGEXT from registered host
            var stealRegExt = client.post("/api/events/external-sync", GSON.toJson(Map.of(
                    "id", "evt-hijacker-ext",
                    "name", "Hijacked Ext",
                    "inviteCode", "REGEXT"
            )), b -> b.header("Authorization", "Bearer " + fix.outsiderToken));
            assertEquals(403, stealRegExt.code());

            // Verify inviteCodes on evt-authoritative-1 and ext_REGEXT are still intact
            assertEquals("AUTH01", support.jdbi.withHandle(h ->
                    h.createQuery("SELECT invite_code FROM events WHERE id = 'evt-authoritative-1'")
                            .mapTo(String.class).one()));
            assertEquals("REGEXT", support.jdbi.withHandle(h ->
                    h.createQuery("SELECT invite_code FROM events WHERE id = 'ext_REGEXT'")
                            .mapTo(String.class).one()));

            // Positive control: legitimate reparenting of external_host stub OPEN03 succeeds 200
            var legitReparent = client.post("/api/events/external-sync", GSON.toJson(Map.of(
                    "id", "11111111-2222-3333-4444-555555555555",
                    "name", "Claimed Event",
                    "inviteCode", "OPEN03"
            )), b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(200, legitReparent.code());
            assertEquals("OPEN03", support.jdbi.withHandle(h ->
                    h.createQuery("SELECT invite_code FROM events WHERE id = '11111111-2222-3333-4444-555555555555'")
                            .mapTo(String.class).one()));
        });
    }

    @Test
    void scheduleNullAndInvalidTypes_pitAndTagInvalidTeamNumber_andTagDoubleDecode() {
        JavalinTest.test(support.app, (server, client) -> {
            RouteTestSupport.RoomFixture fix = RouteTestSupport.setupRoomFixture(client);

            // 1) ScheduleRoutes: JSON null fields handled cleanly (200), non-primitive/bad types return 400 (never 500)
            var nullFieldsSchedule = client.post("/api/events/" + fix.eventId + "/schedule/batch",
                    "{\"replace\":null,\"items\":[{\"matchNumber\":1,\"tournamentLevel\":null,\"red1\":null,\"red2\":1234,\"id\":null}]}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken));
            assertEquals(200, nullFieldsSchedule.code());

            assertEquals(400, client.post("/api/events/" + fix.eventId + "/schedule/batch",
                    "{\"replace\":\"not-a-bool\",\"items\":[]}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).code());
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/schedule/batch",
                    "{\"items\":[{\"matchNumber\":\"abc\"}]}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).code());
            assertEquals(400, client.put("/api/events/" + fix.eventId + "/assignments",
                    "{\"assignments\":[{\"matchNumber\":1,\"station\":\"red1\",\"teamNumber\":[1]}]}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).code());
            assertEquals(200, client.put("/api/events/" + fix.eventId + "/assignments",
                    "{\"assignments\":[{\"matchNumber\":1,\"station\":\"red1\",\"teamNumber\":null,\"scoutId\":null}]}",
                    b -> b.header("Authorization", "Bearer " + fix.hostToken)).code());

            // 2) PitScoutRoutes: teamNumber <= 0 rejected with 400 (single & batch), positive succeeds 200
            assertEquals(200, client.post("/api/events/" + fix.eventId + "/pit-records",
                    GSON.toJson(Map.of("teamNumber", 254, "notes", "Valid")),
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/pit-records",
                    GSON.toJson(Map.of("teamNumber", 0, "notes", "Zero")),
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/pit-records",
                    GSON.toJson(Map.of("teamNumber", -10, "notes", "Neg")),
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/pit-records/batch",
                    GSON.toJson(List.of(Map.of("teamNumber", 254), Map.of("teamNumber", 0))),
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            // 3) TeamTagRoutes: teamNumber <= 0 rejected with 400 on POST & DELETE
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/teams/0/tags",
                    "{\"tag\":\"fast\"}",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());
            assertEquals(400, client.post("/api/events/" + fix.eventId + "/teams/-5/tags",
                    "{\"tag\":\"fast\"}",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());
            assertEquals(400, client.delete("/api/events/" + fix.eventId + "/teams/0/tags/fast",
                    null, b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            // 4) TeamTagRoutes DELETE must NOT double URL-decode (both '+'->space bug and '%25'->500 IllegalArgumentException)
            assertEquals(200, client.post("/api/events/" + fix.eventId + "/teams/254/tags",
                    "{\"tag\":\"fast auto\"}",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).code());

            // Precondition: tag exists
            JsonArray tagsBefore = JsonParser.parseString(client.get("/api/events/" + fix.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).body().string()).getAsJsonArray();
            assertEquals(1, tagsBefore.size());

            // Deleting with '+' must NOT decode '+' to space and delete "fast auto"
            var plusDelete = client.delete("/api/events/" + fix.eventId + "/teams/254/tags/fast+auto",
                    null, b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertNotEquals(500, plusDelete.code());

            JsonArray tagsStillPresent = JsonParser.parseString(client.get("/api/events/" + fix.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).body().string()).getAsJsonArray();
            assertEquals(1, tagsStillPresent.size());

            // Deleting with literal encoded '%' (%25) must NOT throw 500 URLDecoder IllegalArgumentException
            var pctDelete = client.delete("/api/events/" + fix.eventId + "/teams/254/tags/foo%25bar",
                    null, b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertEquals(200, pctDelete.code());

            // Deleting with real %20 encoding properly deletes "fast auto"
            var realDelete = client.delete("/api/events/" + fix.eventId + "/teams/254/tags/fast%20auto",
                    null, b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
            assertEquals(200, realDelete.code());

            JsonArray tagsAfter = JsonParser.parseString(client.get("/api/events/" + fix.eventId + "/tags",
                    b -> b.header("Authorization", "Bearer " + fix.scoutAToken)).body().string()).getAsJsonArray();
            assertEquals(0, tagsAfter.size());
        });
    }
}
