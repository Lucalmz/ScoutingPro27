package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.AdvancementCalculator;
import com.bear27570.app.util.FtcApiClient;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class FtcProxyAndClientExtendedTest {

    @TempDir
    Path tempDir;

    private HttpServer mockServer;
    private int mockPort;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;
    private final Gson gson = new Gson();
    private final AtomicInteger teamPageCalls = new AtomicInteger(0);

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();

        mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockPort = mockServer.getAddress().getPort();
        mockServer.start();

        // Multi-page teams endpoint (page 1 & page 2, plus skipping teamNumber <= 0)
        mockServer.createContext("/v2.0/2026/teams", exchange -> {
            teamPageCalls.incrementAndGet();
            String query = exchange.getRequestURI().getQuery();
            if (query != null && query.contains("eventCode=ERR500")) {
                writeJson(exchange, 500, "{\"error\":\"upstream boom\"}");
                return;
            }
            if (query != null && query.contains("page=2")) {
                writeJson(exchange, 200, "{\"pageTotal\":2,\"teams\":[{\"teamNumber\":11115,\"nameFull\":\"Gluten Free\"}]}");
            } else {
                writeJson(exchange, 200, "{\"pageTotal\":2,\"teams\":[{\"teamNumber\":0,\"nameFull\":\"Invalid\"},{\"teamNumber\":27570,\"nameFull\":\"Team 27570\",\"robotName\":\"Nova\",\"city\":\"SH\",\"country\":\"CN\"}]}");
            }
        });

        mockServer.createContext("/v2.0/2026/matches/TIPS_EVT", exchange -> writeJson(exchange, 200,
                "{\"matches\":[{\"matchNumber\":1,\"tournamentLevel\":\"QUALIFICATION\",\"scoreRedFinal\":80,\"scoreRedFoul\":5,\"scoreBlueFinal\":70,\"scoreBlueFoul\":10,\"totalTipsRed\":3,\"totalTipsBlue\":2,\"teams\":[]},{\"matchNumber\":2,\"tournamentLevel\":\"QUALIFICATION\",\"teams\":[]}]}"));

        mockServer.createContext("/v2.0/2026/matches/ERR500", exchange -> writeJson(exchange, 500, "err"));
        mockServer.createContext("/v2.0/2026/scores/ERR500/qual", exchange -> writeJson(exchange, 500, "err"));
        mockServer.createContext("/v2.0/2026/rankings/ERR500", exchange -> writeJson(exchange, 500, "err"));
        mockServer.createContext("/v2.0/2026/awards/ERR500", exchange -> writeJson(exchange, 500, "err"));
        mockServer.createContext("/v2.0/2026/alliances/ERR500", exchange -> writeJson(exchange, 500, "err"));

        // Advancement fallback to teams when rankings are empty
        mockServer.createContext("/v2.0/2026/rankings/TEAM_ONLY", exchange -> writeJson(exchange, 200, "{\"rankings\":[]}"));
        mockServer.createContext("/v2.0/2026/alliances/TEAM_ONLY", exchange -> writeJson(exchange, 200, "{\"alliances\":[]}"));
        mockServer.createContext("/v2.0/2026/awards/TEAM_ONLY", exchange -> writeJson(exchange, 200, "{\"awards\":[]}"));
        mockServer.createContext("/v2.0/2026/matches/TEAM_ONLY", exchange -> writeJson(exchange, 200, "{\"matches\":[]}"));

        mockServer.createContext("/v2.0/2026/alliances/FULL_ALLIANCE", exchange -> writeJson(exchange, 200,
                "{\"alliances\":[{\"number\":1,\"captain\":27570,\"round1\":11115,\"round2\":8417,\"round3\":18457,\"backup\":19600,\"name\":\"A1\"}]}"));

        String url = "jdbc:h2:mem:test_ftc_ext_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        Jdbi jdbi = JdbiConfig.create(url, "sa", "");
        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "user", "pass");
        apiRoutes = new ApiRoutes(jdbi, client);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        try {
            if (apiRoutes != null) apiRoutes.shutdown();
            JdbiConfig.closeDataSources();
            if (mockServer != null) mockServer.stop(0);
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) System.clearProperty("scouting.data.dir");
            else System.setProperty("scouting.data.dir", prevDataDir);
        }
    }

    private static void writeJson(com.sun.net.httpserver.HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private String registerAndLogin(io.javalin.testtools.HttpClient client, String username) throws Exception {
        client.post("/api/user/register", "{\"username\":\"" + username + "\", \"password\":\"Pass123456\"}");
        var loginRes = client.post("/api/user/login", "{\"username\":\"" + username + "\", \"password\":\"Pass123456\"}");
        Map<?, ?> loginBody = gson.fromJson(loginRes.body().string(), Map.class);
        return (String) loginBody.get("token");
    }

    @Test
    void testAllFtcProxyEndpointsValidationPaginationSyntheticAnd500Errors() {
        JavalinTest.test(app, (server, client) -> {
            String token = registerAndLogin(client, "ftcext");

            // 1. Season & eventCode validation across all routes
            for (String route : new String[]{"matches", "scores", "teams", "rankings", "awards", "alliances", "advancement"}) {
                assertThat(client.get("/api/ftc/notanint/" + route + "/EVT1", r -> r.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);
                assertThat(client.get("/api/ftc/1999/" + route + "/EVT1", r -> r.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);
                assertThat(client.get("/api/ftc/2101/" + route + "/EVT1", r -> r.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);
                assertThat(client.get("/api/ftc/2026/" + route + "/BAD!CODE", r -> r.header("Authorization", "Bearer " + token)).code()).isEqualTo(400);
            }

            // 2. Multi-page teams pagination
            var teamsRes = client.get("/api/ftc/2026/teams/TEAM_ONLY", r -> r.header("Authorization", "Bearer " + token));
            assertThat(teamsRes.code()).isEqualTo(200);
            JsonArray teamsArr = gson.fromJson(teamsRes.body().string(), JsonArray.class);
            assertThat(teamsArr).hasSize(2);
            assertThat(teamsArr.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);
            assertThat(teamsArr.get(1).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(11115);

            // 3. Matches with totalTips & null unplayed scores
            var tipsRes = client.get("/api/ftc/2026/matches/TIPS_EVT", r -> r.header("Authorization", "Bearer " + token));
            assertThat(tipsRes.code()).isEqualTo(200);
            JsonArray tipsArr = gson.fromJson(tipsRes.body().string(), JsonArray.class);
            assertThat(tipsArr).hasSize(2);
            assertThat(tipsArr.get(0).getAsJsonObject().getAsJsonObject("scores").getAsJsonObject("red").get("totalTips").getAsInt()).isEqualTo(3);
            JsonObject unplayedMatch = tipsArr.get(1).getAsJsonObject();
            assertThat(!unplayedMatch.has("scores") || unplayedMatch.get("scores").isJsonNull()).isTrue();

            // 4. Alliances with round2/round3/backup/name
            var allRes = client.get("/api/ftc/2026/alliances/FULL_ALLIANCE", r -> r.header("Authorization", "Bearer " + token));
            assertThat(allRes.code()).isEqualTo(200);
            JsonArray allArr = gson.fromJson(allRes.body().string(), JsonArray.class);
            assertThat(allArr.get(0).getAsJsonObject().get("round3").getAsInt()).isEqualTo(18457);
            assertThat(allArr.get(0).getAsJsonObject().get("backup").getAsInt()).isEqualTo(19600);

            // 5. Synthetic rankings, awards, alliances
            assertThat(gson.fromJson(client.get("/api/ftc/2026/rankings/BIOBUZZ_SYNTHETIC", r -> r.header("Authorization", "Bearer " + token)).body().string(), JsonArray.class)).hasSize(16);
            assertThat(gson.fromJson(client.get("/api/ftc/2026/awards/SYNTHETIC", r -> r.header("Authorization", "Bearer " + token)).body().string(), JsonArray.class)).isNotEmpty();
            assertThat(gson.fromJson(client.get("/api/ftc/2026/alliances/SYNTHETIC", r -> r.header("Authorization", "Bearer " + token)).body().string(), JsonArray.class)).isNotEmpty();

            // 6. Advancement when rankings empty falls back to teams + slots<=0 ignored
            var advTeamsOnly = client.get("/api/ftc/2026/advancement/TEAM_ONLY?slots=0", r -> r.header("Authorization", "Bearer " + token));
            assertThat(advTeamsOnly.code()).isEqualTo(200);
            JsonArray advArr = gson.fromJson(advTeamsOnly.body().string(), JsonArray.class);
            assertThat(advArr).hasSize(2);

            // 7. Upstream 500 propagation across proxy endpoints
            for (String route : new String[]{"matches", "scores", "teams", "rankings", "awards", "alliances", "advancement"}) {
                var errRes = client.get("/api/ftc/2026/" + route + "/ERR500", r -> r.header("Authorization", "Bearer " + token));
                assertThat(errRes.code()).isEqualTo(500);
                assertThat(errRes.body().string()).contains("\"error\"");
            }
        });
    }

    @Test
    void testFtcApiClientCacheClearAndEventExistsEdgeCases() throws Exception {
        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "", "");
        assertThat(client.eventExists(2026, "   ")).isFalse();
        assertThat(client.fetchOfficialAdvancementSlots(2026, "SYNTHETIC")).isEqualTo(AdvancementCalculator.DEFAULT_ADVANCEMENT_SLOTS);
        assertThat(client.fetchOfficialAdvancementSlots(2026, "MISSING_EVT")).isEqualTo(AdvancementCalculator.DEFAULT_ADVANCEMENT_SLOTS);

        teamPageCalls.set(0);
        client.fetchNormalizedTeams(2026, "TEAM_ONLY");
        int callsAfterFirst = teamPageCalls.get();
        client.fetchNormalizedTeams(2026, "TEAM_ONLY");
        assertThat(teamPageCalls.get()).isEqualTo(callsAfterFirst); // cache hit

        client.clearCache();
        client.fetchNormalizedTeams(2026, "TEAM_ONLY");
        assertThat(teamPageCalls.get()).isGreaterThan(callsAfterFirst);
    }

    @Test
    void testAdvancementCalculatorChineseAwardsTiebreakersAndRound3EdgeCases() {
        assertThat(Double.isNaN(AdvancementCalculator.invErf(Double.NaN))).isTrue();
        assertThat(AdvancementCalculator.erf(0.0)).isEqualTo(0.0);
        assertThat(AdvancementCalculator.calcRound3AlliancePoints(0, 4)).isEqualTo(0);
        assertThat(AdvancementCalculator.calcRound3AlliancePoints(1, 4)).isEqualTo(12); // 21 - (8 + 1)
        assertThat(AdvancementCalculator.calcAlliancePoints(1, false, true, 0)).isEqualTo(13); // fallback 4 alliances

        // Playoff numeric & string tokens
        assertThat(AdvancementCalculator.calcPlayoffPoints("1ST")).isEqualTo(40);
        assertThat(AdvancementCalculator.calcPlayoffPoints("RUNNER")).isEqualTo(20);
        assertThat(AdvancementCalculator.calcPlayoffPoints("3")).isEqualTo(10);
        assertThat(AdvancementCalculator.calcPlayoffPoints("4")).isEqualTo(5);

        // Chinese awards & series inference from name
        assertThat(AdvancementCalculator.calcAwardPoints("启迪奖", 1)).isEqualTo(60);
        assertThat(AdvancementCalculator.calcAwardPoints("启迪奖 第二名", 1)).isEqualTo(30);
        assertThat(AdvancementCalculator.calcAwardPoints("思考奖 第3名", 1)).isEqualTo(3);
        assertThat(AdvancementCalculator.calcAwardPoints("Safety Award", 1)).isEqualTo(0);

        // 7-level tiebreaker check: same total=20, sort by award -> playoff -> alliance -> qual -> sort1 -> sort2 -> teamNumber asc
        JsonArray rankings = new JsonArray();
        for (int[] pair : new int[][]{{300, 100}, {200, 100}, {100, 100}}) {
            JsonObject r = new JsonObject();
            r.addProperty("teamNumber", pair[0]);
            r.addProperty("rank", 1);
            r.addProperty("sortOrder1", pair[0] == 200 ? 150.0 : 120.0);
            r.addProperty("sortOrder2", pair[0] == 100 ? 90.0 : 80.0);
            rankings.add(r);
        }

        // Team 100 & 300 tie on everything except sortOrder2 / teamNumber -> 200 wins via sortOrder1=150
        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), new JsonArray(), 1);
        assertThat(adv).hasSize(3);
        assertThat(adv.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(200);
        assertThat(adv.get(1).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(100); // sortOrder2=90 > 80
        assertThat(adv.get(2).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(300);

        // ALREADY_ADVANCED normalized to ALREADY_ADVANCING; declined without status -> DECLINED
        JsonObject rawOff = new JsonObject();
        JsonArray offArr = new JsonArray();
        JsonObject s1 = new JsonObject();
        s1.addProperty("team", 200);
        s1.addProperty("status", "ALREADY_ADVANCED");
        s1.addProperty("criteria", "Host");
        JsonObject s2 = new JsonObject();
        s2.addProperty("team", 100);
        s2.addProperty("declined", true);
        offArr.add(s1);
        offArr.add(s2);
        rawOff.add("advancement", offArr);

        JsonArray advRoll = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), new JsonArray(), 1, rawOff, false);
        assertThat(advRoll.get(0).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("ALREADY_ADVANCING");
        assertThat(advRoll.get(0).getAsJsonObject().get("advancementCriteria").getAsString()).isEqualTo("Host");
        assertThat(advRoll.get(1).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("DECLINED");
        assertThat(advRoll.get(2).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("ADVANCING");
    }
}
