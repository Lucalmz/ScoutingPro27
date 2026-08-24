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
}
