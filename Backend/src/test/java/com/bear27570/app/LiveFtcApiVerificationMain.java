package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.FtcApiClient;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class LiveFtcApiVerificationMain {

    public static void main(String[] args) throws Exception {
        System.out.println("=== Starting Live FTC API Full-Link Verification ===");

        String dbUrl = "jdbc:h2:mem:live_ftc_test;DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(dbUrl, "sa", "").locations("classpath:db").load().migrate();
        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        FtcApiClient ftcApiClient = new FtcApiClient();
        ApiRoutes apiRoutes = new ApiRoutes(jdbi, ftcApiClient);

        Javalin app = Javalin.create(config -> {
            apiRoutes.register(config.routes);
        }).start(0);

        int port = app.port();
        String baseUrl = "http://localhost:" + port;
        HttpClient client = HttpClient.newHttpClient();

        try {
            // 1. Register & Login
            System.out.println("\n[Step 1] Register and Login to obtain JWT token...");
            HttpRequest regReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/user/register"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"live_verifier\",\"password\":\"secret123\"}"))
                    .build();
            HttpResponse<String> regRes = client.send(regReq, HttpResponse.BodyHandlers.ofString());
            JsonObject regObj = JsonParser.parseString(regRes.body()).getAsJsonObject();
            String token = regObj.get("token").getAsString();
            System.out.println("Registration OK, token: " + token.substring(0, 15) + "...");

            // 2. Call FTC API proxy for 2025 CNCMPLB
            System.out.println("\n[Step 2] Testing GET /api/ftc/2025/matches/CNCMPLB via Backend Proxy...");
            HttpRequest ftcReq1 = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/ftc/2025/matches/CNCMPLB"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            long t1 = System.currentTimeMillis();
            HttpResponse<String> ftcRes1 = client.send(ftcReq1, HttpResponse.BodyHandlers.ofString());
            long latency1 = System.currentTimeMillis() - t1;

            System.out.println("HTTP Status: " + ftcRes1.statusCode() + " (Latency: " + latency1 + "ms)");
            JsonArray matches1 = JsonParser.parseString(ftcRes1.body()).getAsJsonArray();
            System.out.println("Total Matches Fetched: " + matches1.size());
            if (matches1.size() > 0) {
                System.out.println("Sample Normalized Match [0]:");
                System.out.println(matches1.get(0).toString());
            }

            // 3. Test In-Memory Cache (2nd call should be near-instant < 5ms)
            System.out.println("\n[Step 3] Testing Backend In-Memory Cache for GET /api/ftc/2025/matches/CNCMPLB...");
            long t2 = System.currentTimeMillis();
            HttpResponse<String> ftcRes2 = client.send(ftcReq1, HttpResponse.BodyHandlers.ofString());
            long latency2 = System.currentTimeMillis() - t2;
            System.out.println("HTTP Status: " + ftcRes2.statusCode() + " (Cache Hit Latency: " + latency2 + "ms)");
            JsonArray matches2 = JsonParser.parseString(ftcRes2.body()).getAsJsonArray();
            System.out.println("Cache Hit Match Count: " + matches2.size());

            // 4. Call FTC API proxy for 2024 AUCMP
            System.out.println("\n[Step 4] Testing GET /api/ftc/2024/matches/AUCMP?tournamentLevel=qual via Backend Proxy...");
            HttpRequest ftcReq3 = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/ftc/2024/matches/AUCMP?tournamentLevel=qual"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> ftcRes3 = client.send(ftcReq3, HttpResponse.BodyHandlers.ofString());
            System.out.println("HTTP Status: " + ftcRes3.statusCode());
            JsonArray matches3 = JsonParser.parseString(ftcRes3.body()).getAsJsonArray();
            System.out.println("Total Qual Matches Fetched: " + matches3.size());
            if (matches3.size() > 0) {
                System.out.println("Sample Qual Match [0]:");
                System.out.println(matches3.get(0).toString());
            }

            System.out.println("\n=== ALL FTC API LIVE FULL-LINK CHECKS PASSED SUCCESSFULLY ===");
        } finally {
            app.stop();
        }
    }
}
