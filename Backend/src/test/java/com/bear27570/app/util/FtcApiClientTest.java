package com.bear27570.app.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class FtcApiClientTest {

    private HttpServer mockServer;
    private int mockPort;

    @BeforeEach
    void setUp() throws Exception {
        mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockPort = mockServer.getAddress().getPort();
        mockServer.start();
    }

    @AfterEach
    void tearDown() {
        if (mockServer != null) {
            mockServer.stop(0);
        }
    }

    @Test
    void testPenaltyAndNonPenaltyScoreNormalization() throws Exception {
        // Mock FTC Events API response for /v2.0/2025/matches/TEST_EVENT
        String mockResponse = "{\n" +
                "  \"matches\": [\n" +
                "    {\n" +
                "      \"matchNumber\": 1,\n" +
                "      \"tournamentLevel\": \"QUALIFICATION\",\n" +
                "      \"scoreRedFinal\": 151,\n" +
                "      \"scoreRedFoul\": 5,\n" +
                "      \"scoreBlueFinal\": 157,\n" +
                "      \"scoreBlueFoul\": 15,\n" +
                "      \"teams\": [\n" +
                "        { \"teamNumber\": 19666, \"station\": \"Red1\", \"dq\": false, \"onField\": true },\n" +
                "        { \"teamNumber\": 30319, \"station\": \"Red2\", \"dq\": false, \"onField\": true },\n" +
                "        { \"teamNumber\": 25720, \"station\": \"Blue1\", \"dq\": false, \"onField\": true },\n" +
                "        { \"teamNumber\": 19705, \"station\": \"Blue2\", \"dq\": false, \"onField\": true }\n" +
                "      ]\n" +
                "    }\n" +
                "  ]\n" +
                "}";

        mockServer.createContext("/v2.0/2025/matches/TEST_EVENT", exchange -> {
            byte[] bytes = mockResponse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        JsonArray matches = client.fetchNormalizedMatches(2025, "TEST_EVENT", "qual");

        assertThat(matches).hasSize(1);
        JsonObject match = matches.get(0).getAsJsonObject();
        assertThat(match.get("matchNum").getAsInt()).isEqualTo(1);
        assertThat(match.get("tournamentLevel").getAsString()).isEqualTo("QUALIFICATION");

        JsonObject scores = match.getAsJsonObject("scores");
        assertThat(scores).isNotNull();

        // 罚分计算与净得分映射校验：
        // Red totalPointsNp = scoreRedFinal (151) - scoreBlueFoul (15) = 136
        // Red penaltyPointsCommitted = scoreRedFoul (5)
        JsonObject red = scores.getAsJsonObject("red");
        assertThat(red.get("totalPointsNp").getAsInt()).isEqualTo(136);
        assertThat(red.get("penaltyPointsCommitted").getAsInt()).isEqualTo(5);
        assertThat(red.get("finalScore").getAsInt()).isEqualTo(151);

        // Blue totalPointsNp = scoreBlueFinal (157) - scoreRedFoul (5) = 152
        // Blue penaltyPointsCommitted = scoreBlueFoul (15)
        JsonObject blue = scores.getAsJsonObject("blue");
        assertThat(blue.get("totalPointsNp").getAsInt()).isEqualTo(152);
        assertThat(blue.get("penaltyPointsCommitted").getAsInt()).isEqualTo(15);
        assertThat(blue.get("finalScore").getAsInt()).isEqualTo(157);

        // Teams check
        JsonArray teams = match.getAsJsonArray("teams");
        assertThat(teams).hasSize(4);
        assertThat(teams.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(19666);
        assertThat(teams.get(0).getAsJsonObject().get("alliance").getAsString()).isEqualTo("Red");
        assertThat(teams.get(2).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(25720);
        assertThat(teams.get(2).getAsJsonObject().get("alliance").getAsString()).isEqualTo("Blue");
    }

    @Test
    void testCacheAndIfModifiedSince304Support() throws Exception {
        AtomicInteger serverCallCount = new AtomicInteger(0);

        String responseBody = "{\n" +
                "  \"matches\": [\n" +
                "    {\n" +
                "      \"matchNumber\": 2,\n" +
                "      \"tournamentLevel\": \"QUALIFICATION\",\n" +
                "      \"scoreRedFinal\": 200,\n" +
                "      \"scoreRedFoul\": 10,\n" +
                "      \"scoreBlueFinal\": 180,\n" +
                "      \"scoreBlueFoul\": 0,\n" +
                "      \"teams\": []\n" +
                "    }\n" +
                "  ]\n" +
                "}";

        mockServer.createContext("/v2.0/2025/matches/CACHE_EVENT", exchange -> {
            serverCallCount.incrementAndGet();
            String ifModifiedSince = exchange.getRequestHeaders().getFirst("If-Modified-Since");
            if ("Thu, 20 Aug 2026 12:00:00 GMT".equals(ifModifiedSince)) {
                exchange.sendResponseHeaders(304, -1);
                return;
            }

            byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Last-Modified", "Thu, 20 Aug 2026 12:00:00 GMT");
            exchange.getResponseHeaders().set("ETag", "\"etag-12345\"");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");

        // 1st request -> fetches from server (count = 1)
        JsonArray matches1 = client.fetchNormalizedMatches(2025, "CACHE_EVENT", "qual");
        assertThat(matches1).hasSize(1);
        assertThat(serverCallCount.get()).isEqualTo(1);

        // 2nd request immediately -> hits in-memory cache without HTTP call (count stays 1)
        JsonArray matches2 = client.fetchNormalizedMatches(2025, "CACHE_EVENT", "qual");
        assertThat(matches2).hasSize(1);
        assertThat(serverCallCount.get()).isEqualTo(1);
    }

    @Test
    void testEventExistsReturnsTrueWhenEventFound() throws Exception {
        String responseBody = "{\"events\":[{\"code\":\"CNCMPLB\",\"name\":\"China Championship\"}],\"eventCount\":1}";
        mockServer.createContext("/v2.0/2025/events", exchange -> {
            byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        assertThat(client.eventExists(2025, "CNCMPLB")).isTrue();
        assertThat(client.eventExists(2025, "cncmplb")).isTrue();
    }

    @Test
    void testEventExistsReturnsFalseWhen404OrNotFound() throws Exception {
        mockServer.createContext("/v2.0/2026/events", exchange -> {
            exchange.sendResponseHeaders(404, -1);
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        assertThat(client.eventExists(2026, "BIOBUZZ26")).isFalse();
    }

    @Test
    void testEventExistsReturnsFalseWhenEmptyList() throws Exception {
        String responseBody = "{\"events\":[],\"eventCount\":0}";
        mockServer.createContext("/v2.0/2025/events", exchange -> {
            byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        assertThat(client.eventExists(2025, "NO_SUCH_EVENT")).isFalse();
    }

    @Test
    void testPascalCaseUpstreamFtcApiSupport() throws Exception {
        String pascalRankings = "{\"Rankings\":[{\"Rank\":1,\"TeamNumber\":27570,\"SortOrder1\":140.0}]}";
        mockServer.createContext("/v2.0/2026/rankings/PASCAL_EVT", exchange -> {
            byte[] bytes = pascalRankings.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String pascalAwards = "{\"Awards\":[{\"Name\":\"Inspire Award\",\"Series\":1,\"TeamNumber\":27570}]}";
        mockServer.createContext("/v2.0/2026/awards/PASCAL_EVT", exchange -> {
            byte[] bytes = pascalAwards.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String pascalAlliances = "{\"Alliances\":[{\"Number\":1,\"Captain\":27570,\"Round1\":11115}]}";
        mockServer.createContext("/v2.0/2026/alliances/PASCAL_EVT", exchange -> {
            byte[] bytes = pascalAlliances.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        JsonArray ranks = client.fetchNormalizedRankings(2026, "PASCAL_EVT");
        assertThat(ranks).hasSize(1);
        assertThat(ranks.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);
        assertThat(ranks.get(0).getAsJsonObject().get("rank").getAsInt()).isEqualTo(1);
        assertThat(ranks.get(0).getAsJsonObject().get("sortOrder1").getAsDouble()).isEqualTo(140.0);

        JsonArray awards = client.fetchAwards(2026, "PASCAL_EVT");
        assertThat(awards).hasSize(1);
        assertThat(awards.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(27570);
        assertThat(awards.get(0).getAsJsonObject().get("name").getAsString()).isEqualTo("Inspire Award");

        JsonArray alliances = client.fetchAlliances(2026, "PASCAL_EVT");
        assertThat(alliances).hasSize(1);
        assertThat(alliances.get(0).getAsJsonObject().get("captain").getAsInt()).isEqualTo(27570);
    }

    @Test
    void testLiveFtcApiV2NestedAllianceTeamObjectsAndOfficialSlots() throws Exception {
        String rankingsJson = "{\"rankings\":[" +
                "{\"rank\":1,\"teamNumber\":23400,\"sortOrder1\":160.0,\"sortOrder2\":80.0}," +
                "{\"rank\":2,\"teamNumber\":11115,\"sortOrder1\":140.0,\"sortOrder2\":70.0}," +
                "{\"rank\":3,\"teamNumber\":8417,\"sortOrder1\":130.0,\"sortOrder2\":60.0}," +
                "{\"rank\":4,\"teamNumber\":18457,\"sortOrder1\":120.0,\"sortOrder2\":50.0}," +
                "{\"rank\":5,\"teamNumber\":11260,\"sortOrder1\":110.0,\"sortOrder2\":40.0}," +
                "{\"rank\":6,\"teamNumber\":8644,\"sortOrder1\":100.0,\"sortOrder2\":30.0}" +
                "]}";
        mockServer.createContext("/v2.0/2025/rankings/AUADQ", exchange -> {
            byte[] bytes = rankingsJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String alliancesJson = "{\"alliances\":[" +
                "{\"number\":1,\"name\":\"Alliance 1\"," +
                "\"captain\":{\"teamNumber\":23400,\"displayTeamNumber\":\"23400\",\"teamName\":\"UFORCE \"}," +
                "\"round1\":{\"teamNumber\":11115,\"displayTeamNumber\":\"11115\",\"teamName\":\"Gluten Free\"}," +
                "\"round2\":null,\"round3\":null,\"backup\":null}," +
                "{\"number\":2,\"name\":\"Alliance 2\"," +
                "\"captain\":{\"teamNumber\":8417,\"displayTeamNumber\":\"8417\",\"teamName\":\"Team 8417\"}," +
                "\"round1\":{\"teamNumber\":18457,\"displayTeamNumber\":\"18457\",\"teamName\":\"Team 18457\"}," +
                "\"round2\":null,\"round3\":null,\"backup\":null}" +
                "],\"count\":2}";
        mockServer.createContext("/v2.0/2025/alliances/AUADQ", exchange -> {
            byte[] bytes = alliancesJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String awardsJson = "{\"awards\":[" +
                "{\"awardId\":10,\"name\":\"Sustain Award\",\"series\":1,\"teamNumber\":11260}," +
                "{\"awardId\":11,\"name\":\"Reach Award\",\"series\":2,\"teamNumber\":8644}" +
                "]}";
        mockServer.createContext("/v2.0/2025/awards/AUADQ", exchange -> {
            byte[] bytes = awardsJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String matchesJson = "{\"matches\":[]}";
        mockServer.createContext("/v2.0/2025/matches/AUADQ", exchange -> {
            byte[] bytes = matchesJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String officialAdvancementJson = "{\"advancesTo\":\"AU Regional\",\"slots\":5,\"fcmpReserved\":0,\"advancement\":[]}";
        mockServer.createContext("/v2.0/2025/advancement/AUADQ", exchange -> {
            byte[] bytes = officialAdvancementJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        JsonArray alliances = client.fetchAlliances(2025, "AUADQ");
        assertThat(alliances).hasSize(2);
        assertThat(alliances.get(0).getAsJsonObject().get("captain").getAsInt()).isEqualTo(23400);
        assertThat(alliances.get(0).getAsJsonObject().get("round1").getAsInt()).isEqualTo(11115);

        JsonArray adv = client.fetchAdvancement(2025, "AUADQ");
        assertThat(adv).hasSize(6);
        assertThat(adv.get(0).getAsJsonObject().get("teamNumber").getAsInt()).isEqualTo(23400);
        assertThat(adv.get(0).getAsJsonObject().get("alliancePoints").getAsInt()).isEqualTo(20);
        // Official /advancement/AUADQ reports slots=5 -> rank 5 is ADVANCING and rank 6 is BUBBLE
        assertThat(adv.get(4).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("ADVANCING");
        assertThat(adv.get(5).getAsJsonObject().get("advancementStatus").getAsString()).isEqualTo("BUBBLE");

        int sustainPts = -1;
        int reachPts = -1;
        for (int i = 0; i < adv.size(); i++) {
            JsonObject row = adv.get(i).getAsJsonObject();
            if (row.get("teamNumber").getAsInt() == 11260) sustainPts = row.get("awardPoints").getAsInt();
            if (row.get("teamNumber").getAsInt() == 8644) reachPts = row.get("awardPoints").getAsInt();
        }
        assertThat(sustainPts).isEqualTo(12);
        assertThat(reachPts).isEqualTo(6);
    }

    @Test
    void testFetchNormalizedMatchesPreservesSeriesAndDescription() throws Exception {
        String playoffMatchesJson = "{\"matches\":[" +
                "{\"matchNumber\":1,\"tournamentLevel\":\"PLAYOFF\",\"series\":3,\"description\":\"Finals 1\"," +
                "\"scoreRedFinal\":150,\"scoreBlueFinal\":120,\"teams\":[]}" +
                "]}";
        mockServer.createContext("/v2.0/2026/matches/PLAYOFF_EVT", exchange -> {
            byte[] bytes = playoffMatchesJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "testuser", "testtoken");
        JsonArray matches = client.fetchNormalizedMatches(2026, "PLAYOFF_EVT", "playoff");
        assertThat(matches).hasSize(1);
        JsonObject m = matches.get(0).getAsJsonObject();
        assertThat(m.get("series").getAsInt()).isEqualTo(3);
        assertThat(m.get("description").getAsString()).isEqualTo("Finals 1");
    }
}
