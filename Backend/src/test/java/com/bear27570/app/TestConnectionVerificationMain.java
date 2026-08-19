package com.bear27570.app;

import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.AESUtil;
import io.javalin.Javalin;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;

public class TestConnectionVerificationMain {

    public static void main(String[] args) throws Exception {
        String dbUrl = "jdbc:h2:./app_data;AUTO_SERVER=TRUE";
        Jdbi jdbi = Jdbi.create(dbUrl, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        Javalin app = Javalin.create(config -> {
            new ApiRoutes(jdbi).register(config.routes);
        }).start(18898);

        HttpClient client = HttpClient.newHttpClient();
        String baseUrl = "http://localhost:18898";

        try {
            System.out.println("================================================================================");
            System.out.println("[Step 1] User Login: POST /api/user/login");
            HttpRequest loginReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/user/login"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"real_user_tester\",\"password\":\"securePass2026\"}"))
                    .build();
            HttpResponse<String> loginRes = client.send(loginReq, HttpResponse.BodyHandlers.ofString());
            String token;
            if (loginRes.statusCode() == 200) {
                token = loginRes.body().split("\"token\":\"")[1].split("\"")[0];
            } else {
                // Register if not exists
                HttpRequest regReq = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/api/user/register"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"real_user_tester\",\"password\":\"securePass2026\"}"))
                        .build();
                HttpResponse<String> regRes = client.send(regReq, HttpResponse.BodyHandlers.ofString());
                token = regRes.body().split("\"token\":\"")[1].split("\"")[0];
            }

            System.out.println("\n[Step 2] Testing Connection for all stored AI settings in database...");
            List<AiSettings> storedList = jdbi.withHandle(h -> {
                try {
                    return h.createQuery("SELECT * FROM ai_settings")
                            .mapToBean(AiSettings.class)
                            .list();
                } catch (Exception e) {
                    return List.of();
                }
            });

            for (AiSettings s : storedList) {
                if (s.getApiKeyEncrypted() == null || s.getApiKeyEncrypted().isBlank()) continue;
                try {
                    String decrypted = AESUtil.decrypt(s.getApiKeyEncrypted());
                    HttpRequest req = HttpRequest.newBuilder()
                            .uri(URI.create(baseUrl + "/api/ai/test-connection?provider=" + s.getProvider() + "&apiKey=" + decrypted))
                            .header("Authorization", "Bearer " + token)
                            .GET()
                            .build();
                    HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
                    System.out.println("Provider: " + s.getProvider() + ", Model: " + s.getModelName() + " -> " + res.body());
                } catch (Exception e) {
                    System.out.println("Provider: " + s.getProvider() + " Error: " + e.getMessage());
                }
            }

            System.out.println("\n[Step 3] Test Connection Anonymous (no key provided): GET /api/ai/test-connection?provider=OPENAI");
            HttpRequest testAnonReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/ai/test-connection?provider=OPENAI"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> testAnonRes = client.send(testAnonReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + testAnonRes.statusCode());
            System.out.println("Body: " + testAnonRes.body());

            System.out.println("\n[Step 4] Test Connection with Invalid Key: GET /api/ai/test-connection?provider=GEMINI&apiKey=invalid_test_key_12345");
            HttpRequest testInvalidReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/ai/test-connection?provider=GEMINI&apiKey=invalid_test_key_12345"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> testInvalidRes = client.send(testInvalidReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + testInvalidRes.statusCode());
            System.out.println("Body: " + testInvalidRes.body());

            System.out.println("================================================================================");
        } finally {
            app.stop();
        }
    }
}
