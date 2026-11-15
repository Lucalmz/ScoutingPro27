package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.FtcApiClient;
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

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class FtcAdvancementRoutesTest {

    private HttpServer mockServer;
    private int mockPort;
    private Jdbi jdbi;
    private Javalin app;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() throws Exception {
        mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockPort = mockServer.getAddress().getPort();
        mockServer.start();

        // 1. Mock rankings
        String rankingsJson = "{\"rankings\":[" +
                "{\"rank\":1,\"teamNumber\":27570,\"sortOrder1\":140.0,\"sortOrder2\":120.0,\"wins\":5,\"losses\":0,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":2,\"teamNumber\":11115,\"sortOrder1\":130.0,\"sortOrder2\":110.0,\"wins\":4,\"losses\":1,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":3,\"teamNumber\":8417,\"sortOrder1\":115.0,\"sortOrder2\":90.0,\"wins\":3,\"losses\":2,\"ties\":0,\"qualMatchesPlayed\":5}," +
                "{\"rank\":4,\"teamNumber\":18457,\"sortOrder1\":105.0,\"sortOrder2\":85.0,\"wins\":2,\"losses\":3,\"ties\":0,\"qualMatchesPlayed\":5}" +
                "]}";
        mockServer.createContext("/v2.0/2026/rankings/TESTEVT", exchange -> {
            byte[] bytes = rankingsJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        // 2. Mock alliances
        String alliancesJson = "{\"alliances\":[" +
                "{\"number\":1,\"captain\":27570,\"round1\":11115,\"name\":\"Alliance 1\"}," +
                "{\"number\":2,\"captain\":8417,\"round1\":18457,\"name\":\"Alliance 2\"}" +
                "]}";
        mockServer.createContext("/v2.0/2026/alliances/TESTEVT", exchange -> {
            byte[] bytes = alliancesJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        // 3. Mock awards
        String awardsJson = "{\"awards\":[" +
                "{\"name\":\"Inspire Award\",\"series\":1,\"teamNumber\":27570}," +
                "{\"name\":\"Winning Alliance Captain\",\"series\":1,\"teamNumber\":27570}," +
                "{\"name\":\"Winning Alliance 1st Pick\",\"series\":1,\"teamNumber\":11115}" +
                "]}";
        mockServer.createContext("/v2.0/2026/awards/TESTEVT", exchange -> {
            byte[] bytes = awardsJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        // 4. Mock matches
        String matchesJson = "{\"matches\":[]}";
        mockServer.createContext("/v2.0/2026/matches/TESTEVT", exchange -> {
            byte[] bytes = matchesJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String url = "jdbc:h2:mem:test_ftc_adv_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        jdbi = JdbiConfig.create(url, "sa", "");

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "user", "pass");
        ApiRoutes apiRoutes = new ApiRoutes(jdbi, client);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        if (mockServer != null) {
            mockServer.stop(0);
        }
    }

    @Test
    void testRankingsAndAdvancementRoutesEndToEnd() {
        JavalinTest.test(app, (server, client) -> {
            // Register & login
            client.post("/api/user/register", "{\"username\":\"advtester\", \"password\":\"Pass123456\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"advtester\", \"password\":\"Pass123456\"}");
            Map<?, ?> loginBody = gson.fromJson(loginRes.body().string(), Map.class);
            String token = (String) loginBody.get("token");

            // 1. Test GET /api/ftc/2026/rankings/TESTEVT
            var resRankings = client.get("/api/ftc/2026/rankings/TESTEVT", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resRankings.code()).isEqualTo(200);
            JsonArray rankingsArr = gson.fromJson(resRankings.body().string(), JsonArray.class);
            assertThat(rankingsArr.size()).isEqualTo(4);
            assertThat(rankingsArr.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);

            // 2. Test GET /api/ftc/2026/awards/TESTEVT
            var resAwards = client.get("/api/ftc/2026/awards/TESTEVT", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resAwards.code()).isEqualTo(200);
            JsonArray awardsArr = gson.fromJson(resAwards.body().string(), JsonArray.class);
            assertThat(awardsArr.size()).isEqualTo(3);

            // 3. Test GET /api/ftc/2026/advancement/TESTEVT
            var resAdv = client.get("/api/ftc/2026/advancement/TESTEVT", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resAdv.code()).isEqualTo(200);
            JsonArray advArr = gson.fromJson(resAdv.body().string(), JsonArray.class);
            assertThat(advArr.size()).isEqualTo(4);

            // Team 27570: Qual 16 + Alliance 20 + Playoff 40 + Inspire 60 = 136 pts, rank 1, ADVANCING
            var top = advArr.get(0).getAsJsonObject();
            assertThat(top.get("teamNumber").getAsInt()).isEqualTo(27570);
            assertThat(top.get("advancementRank").getAsInt()).isEqualTo(1);
            assertThat(top.get("totalAdvancementPoints").getAsInt()).isEqualTo(136);
            assertThat(top.get("advancementStatus").getAsString()).isEqualTo("ADVANCING");

            // Team 11115: rank 2, ADVANCING
            var second = advArr.get(1).getAsJsonObject();
            assertThat(second.get("teamNumber").getAsInt()).isEqualTo(11115);
            assertThat(second.get("advancementRank").getAsInt()).isEqualTo(2);
            assertThat(second.get("advancementStatus").getAsString()).isEqualTo("ADVANCING");

            // 4. Test GET /api/ftc/2026/advancement/TESTEVT?slots=1
            var resAdv1 = client.get("/api/ftc/2026/advancement/TESTEVT?slots=1", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resAdv1.code()).isEqualTo(200);
            JsonArray advArr1 = gson.fromJson(resAdv1.body().string(), JsonArray.class);
            assertThat(advArr1.get(0).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("ADVANCING");
            assertThat(advArr1.get(1).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("BUBBLE");

            // 5. Register official /v2.0/2026/advancement/TESTROLL endpoint with roll-down (1 slot, #1 ALREADY_ADVANCING -> #2 FIRST)
            mockServer.createContext("/v2.0/2026/rankings/TESTROLL", exchange -> {
                byte[] bytes = ("{\"rankings\":[" +
                        "{\"rank\":1,\"teamNumber\":27570,\"wins\":5,\"losses\":0,\"ties\":0,\"qualMatchesPlayed\":5}," +
                        "{\"rank\":2,\"teamNumber\":11115,\"wins\":4,\"losses\":1,\"ties\":0,\"qualMatchesPlayed\":5}," +
                        "{\"rank\":3,\"teamNumber\":8417,\"wins\":3,\"losses\":2,\"ties\":0,\"qualMatchesPlayed\":5}," +
                        "{\"rank\":4,\"teamNumber\":18457,\"wins\":2,\"losses\":3,\"ties\":0,\"qualMatchesPlayed\":5}" +
                        "]}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });
            mockServer.createContext("/v2.0/2026/alliances/TESTROLL", exchange -> {
                byte[] bytes = "{\"alliances\":[]}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });
            mockServer.createContext("/v2.0/2026/awards/TESTROLL", exchange -> {
                byte[] bytes = "{\"awards\":[]}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });
            mockServer.createContext("/v2.0/2026/matches/TESTROLL", exchange -> {
                byte[] bytes = "{\"matches\":[]}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });
            mockServer.createContext("/v2.0/2026/advancement/TESTROLL", exchange -> {
                byte[] bytes = ("{\"advancesTo\":\"CMP\",\"slots\":1,\"fcmpReserved\":0,\"advancement\":[" +
                        "{\"team\":27570,\"displayTeam\":\"27570\",\"slot\":1,\"criteria\":\"Points\",\"declined\":false,\"status\":\"ALREADY_ADVANCING\"}," +
                        "{\"team\":11115,\"displayTeam\":\"11115\",\"slot\":2,\"criteria\":\"Points\",\"declined\":false,\"status\":\"FIRST\"}" +
                        "]}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });

            var resRoll = client.get("/api/ftc/2026/advancement/TESTROLL", req -> {
                req.header("Authorization", "Bearer " + token);
            });
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
}
