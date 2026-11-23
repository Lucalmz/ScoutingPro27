package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.FtcApiClient;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.sun.net.httpserver.HttpServer;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

class FtcProxyRoutesTest {

    @TempDir
    Path tempDir;

    private HttpServer mockServer;
    private int mockPort;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;
    private final Gson gson = new Gson();
    private final List<String> recordedUpstreamUris = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();

        mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockPort = mockServer.getAddress().getPort();
        mockServer.start();

        String rankingsJson = "{\"rankings\":[" +
                "{\"rank\":1,\"teamNumber\":27570,\"sortOrder1\":140.0,\"sortOrder2\":120.0,\"wins\":5,\"losses\":0,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":2,\"teamNumber\":11115,\"sortOrder1\":130.0,\"sortOrder2\":110.0,\"wins\":4,\"losses\":1,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":3,\"teamNumber\":8417,\"sortOrder1\":115.0,\"sortOrder2\":90.0,\"wins\":3,\"losses\":2,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":4,\"teamNumber\":18457,\"sortOrder1\":105.0,\"sortOrder2\":85.0,\"wins\":2,\"losses\":3,\"ties\":0,\"qualMatchesPlayed\":5}" +
                "]}";
        mockServer.createContext("/v2.0/2026/rankings/TESTEVT", exchange -> writeJson(exchange, 200, rankingsJson));

        String alliancesJson = "{\"alliances\":[" +
                "{\"number\":1,\"captain\":27570,\"round1\":11115,\"name\":\"Alliance 1\"}," +
                "{\"number\":2,\"captain\":8417,\"round1\":18457,\"name\":\"Alliance 2\"}" +
                "]}";
        mockServer.createContext("/v2.0/2026/alliances/TESTEVT", exchange -> writeJson(exchange, 200, alliancesJson));

        String awardsJson = "{\"awards\":[" +
                "{\"name\":\"Inspire Award\",\"series\":1,\"teamNumber\":27570}," +
                "{\"name\":\"Winning Alliance Captain\",\"series\":1,\"teamNumber\":27570}," +
                "{\"name\":\"Winning Alliance 1st Pick\",\"series\":1,\"teamNumber\":11115}" +
                "]}";
        mockServer.createContext("/v2.0/2026/awards/TESTEVT", exchange -> writeJson(exchange, 200, awardsJson));
        mockServer.createContext("/v2.0/2026/matches/TESTEVT", exchange -> writeJson(exchange, 200, "{\"matches\":[]}"));

        mockServer.createContext("/v2.0/2025/matches/", exchange -> {
            recordedUpstreamUris.add(exchange.getRequestURI().toString());
            if (exchange.getRequestURI().getPath().endsWith("/TEST_NOT_FOUND")) {
                writeJson(exchange, 404, "{\"error\":\"not found\"}");
            } else {
                writeJson(exchange, 200, "{\"matches\":[]}");
            }
        });
        mockServer.createContext("/v2.0/2025/scores/", exchange -> {
            recordedUpstreamUris.add(exchange.getRequestURI().toString());
            writeJson(exchange, 200, "{\"matchScores\":[]}");
        });

        String url = "jdbc:h2:mem:test_ftc_proxy_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        Jdbi jdbi = JdbiConfig.create(url, "sa", "");

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "user", "pass");
        apiRoutes = new ApiRoutes(jdbi, client);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        try {
            if (apiRoutes != null) {
                apiRoutes.shutdown();
            }
            JdbiConfig.closeDataSources();
            if (mockServer != null) {
                mockServer.stop(0);
            }
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) {
                System.clearProperty("scouting.data.dir");
            } else {
                System.setProperty("scouting.data.dir", prevDataDir);
            }
        }
    }

    private static void writeJson(com.sun.net.httpserver.HttpExchange exchange, int status, String body) throws java.io.IOException {
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
    void testRankingsAndAdvancementRoutesEndToEnd() {
        JavalinTest.test(app, (server, client) -> {
            String token = registerAndLogin(client, "advtester");

            var resRankings = client.get("/api/ftc/2026/rankings/TESTEVT", req -> req.header("Authorization", "Bearer " + token));
            assertThat(resRankings.code()).isEqualTo(200);
            JsonArray rankingsArr = gson.fromJson(resRankings.body().string(), JsonArray.class);
            assertThat(rankingsArr.size()).isEqualTo(4);
            assertThat(rankingsArr.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);

            var resAwards = client.get("/api/ftc/2026/awards/TESTEVT", req -> req.header("Authorization", "Bearer " + token));
            assertThat(resAwards.code()).isEqualTo(200);
            JsonArray awardsArr = gson.fromJson(resAwards.body().string(), JsonArray.class);
            assertThat(awardsArr.size()).isEqualTo(3);

            var resAdv = client.get("/api/ftc/2026/advancement/TESTEVT", req -> req.header("Authorization", "Bearer " + token));
            assertThat(resAdv.code()).isEqualTo(200);
            JsonArray advArr = gson.fromJson(resAdv.body().string(), JsonArray.class);
            assertThat(advArr.size()).isEqualTo(4);

            var top = advArr.get(0).getAsJsonObject();
            assertThat(top.get("teamNumber").getAsInt()).isEqualTo(27570);
            assertThat(top.get("advancementRank").getAsInt()).isEqualTo(1);
            assertThat(top.get("totalAdvancementPoints").getAsInt()).isEqualTo(136);
            assertThat(top.get("advancementStatus").getAsString()).isEqualTo("ADVANCING");

            var second = advArr.get(1).getAsJsonObject();
            assertThat(second.get("teamNumber").getAsInt()).isEqualTo(11115);
            assertThat(second.get("advancementRank").getAsInt()).isEqualTo(2);
            assertThat(second.get("advancementStatus").getAsString()).isEqualTo("ADVANCING");

            var resAdv1 = client.get("/api/ftc/2026/advancement/TESTEVT?slots=1", req -> req.header("Authorization", "Bearer " + token));
            assertThat(resAdv1.code()).isEqualTo(200);
            JsonArray advArr1 = gson.fromJson(resAdv1.body().string(), JsonArray.class);
            assertThat(advArr1.get(0).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("ADVANCING");
            assertThat(advArr1.get(1).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("BUBBLE");

            mockServer.createContext("/v2.0/2026/rankings/TESTROLL", exchange -> writeJson(exchange, 200, "{\"rankings\":[" +
                    "{\"rank\":1,\"teamNumber\":27570,\"wins\":5,\"losses\":0,\"ties\":0,\"qualMatchesPlayed\":5}," +
                    "{\"rank\":2,\"teamNumber\":11115,\"wins\":4,\"losses\":1,\"ties\":0,\"qualMatchesPlayed\":5}," +
                    "{\"rank\":3,\"teamNumber\":8417,\"wins\":3,\"losses\":2,\"ties\":0,\"qualMatchesPlayed\":5}," +
                    "{\"rank\":4,\"teamNumber\":18457,\"wins\":2,\"losses\":3,\"ties\":0,\"qualMatchesPlayed\":5}" +
                    "]}"));
            mockServer.createContext("/v2.0/2026/alliances/TESTROLL", exchange -> writeJson(exchange, 200, "{\"alliances\":[]}"));
            mockServer.createContext("/v2.0/2026/awards/TESTROLL", exchange -> writeJson(exchange, 200, "{\"awards\":[]}"));
            mockServer.createContext("/v2.0/2026/matches/TESTROLL", exchange -> writeJson(exchange, 200, "{\"matches\":[]}"));
            mockServer.createContext("/v2.0/2026/advancement/TESTROLL", exchange -> writeJson(exchange, 200,
                    "{\"advancesTo\":\"CMP\",\"slots\":1,\"fcmpReserved\":0,\"advancement\":[" +
                    "{\"team\":27570,\"displayTeam\":\"27570\",\"slot\":1,\"criteria\":\"Points\",\"declined\":false,\"status\":\"ALREADY_ADVANCING\"}," +
                    "{\"team\":11115,\"displayTeam\":\"11115\",\"slot\":2,\"criteria\":\"Points\",\"declined\":false,\"status\":\"FIRST\"}" +
                    "]}"));

            var resRoll = client.get("/api/ftc/2026/advancement/TESTROLL", req -> req.header("Authorization", "Bearer " + token));
            assertThat(resRoll.code()).isEqualTo(200);
            JsonArray rollArr = gson.fromJson(resRoll.body().string(), JsonArray.class);
            assertThat(rollArr.size()).isEqualTo(4);
            var first = rollArr.get(0).getAsJsonObject();
            var secondRoll = rollArr.get(1).getAsJsonObject();
            var thirdRoll = rollArr.get(2).getAsJsonObject();
            assertThat(first.get("teamNumber").getAsInt()).isEqualTo(27570);
            assertThat(first.get("advancementStatus").getAsString()).isEqualTo("ALREADY_ADVANCING");
            assertThat(first.get("rolledDown").getAsBoolean()).isFalse();
            assertThat(secondRoll.get("teamNumber").getAsInt()).isEqualTo(11115);
            assertThat(secondRoll.get("advancementStatus").getAsString()).isEqualTo("ADVANCING");
            assertThat(secondRoll.get("rolledDown").getAsBoolean()).isTrue();
            assertThat(thirdRoll.get("advancementStatus").getAsString()).isEqualTo("BUBBLE");
        });
    }

    @Test
    void testTournamentLevelNormalizationAndInvalidRejection() {
        JavalinTest.test(app, (server, client) -> {
            String token = registerAndLogin(client, "ftctester");
            recordedUpstreamUris.clear();

            var resQual = client.get("/api/ftc/2025/matches/EVT_Q1?tournamentLevel=qual",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(resQual.code()).isEqualTo(200);

            var resQualLong = client.get("/api/ftc/2025/matches/EVT_Q2?tournamentLevel=qualification",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(resQualLong.code()).isEqualTo(200);

            var resPlayoff = client.get("/api/ftc/2025/matches/EVT_P1?tournamentLevel=playoff",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(resPlayoff.code()).isEqualTo(200);

            var resOmitted = client.get("/api/ftc/2025/matches/EVT_NONE",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(resOmitted.code()).isEqualTo(200);

            var resScoresPlayoff = client.get("/api/ftc/2025/scores/EVT_S1?tournamentLevel=PLAYOFF",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(resScoresPlayoff.code()).isEqualTo(200);

            assertThat(recordedUpstreamUris).containsExactly(
                    "/v2.0/2025/matches/EVT_Q1?tournamentLevel=qual",
                    "/v2.0/2025/matches/EVT_Q2?tournamentLevel=qual",
                    "/v2.0/2025/matches/EVT_P1?tournamentLevel=playoff",
                    "/v2.0/2025/matches/EVT_NONE",
                    "/v2.0/2025/scores/EVT_S1/playoff"
            );

            recordedUpstreamUris.clear();
            var badMatches = client.get("/api/ftc/2025/matches/EVT_BAD?tournamentLevel=invalid",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(badMatches.code()).isEqualTo(400);

            var badScores = client.get("/api/ftc/2025/scores/EVT_BAD?tournamentLevel=invalid",
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(badScores.code()).isEqualTo(400);

            assertThat(recordedUpstreamUris).isEmpty();
        });
    }

    @Test
    void testFtcMatchesProxyAuthAndValidation() {
        JavalinTest.test(app, (server, client) -> {
            var unauthRes = client.get("/api/ftc/2025/matches/TEST_CODE");
            assertThat(unauthRes.code()).isEqualTo(401);

            String token = registerAndLogin(client, "ftcuser");

            var badSeasonRes = client.get("/api/ftc/abc/matches/TEST_CODE",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badSeasonRes.code()).isEqualTo(400);

            var badEventCodeRes = client.get("/api/ftc/2025/matches/TEST%20CODE%20BAD!",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(badEventCodeRes.code()).isEqualTo(400);

            var validRes = client.get("/api/ftc/2025/matches/TEST_NOT_FOUND",
                    b -> b.header("Authorization", "Bearer " + token));
            assertThat(validRes.code()).isEqualTo(200);
            assertThat(validRes.body().string()).isEqualTo("[]");
            assertThat(recordedUpstreamUris).contains("/v2.0/2025/matches/TEST_NOT_FOUND");
        });
    }
}
