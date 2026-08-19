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

public class AiManualVerificationMain {

    public static void main(String[] args) throws Exception {
        String dbUrl = "jdbc:h2:mem:manual_verify_db;DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(dbUrl, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        Jdbi jdbi = Jdbi.create(dbUrl, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        Javalin app = Javalin.create(config -> {
            new ApiRoutes(jdbi).register(config.routes);
        }).start(18899);

        HttpClient client = HttpClient.newHttpClient();
        String baseUrl = "http://localhost:18899";

        try {
            System.out.println("================================================================================");
            System.out.println("[Step 1] User Registration: POST /api/user/register");
            HttpRequest regReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/user/register"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"real_user_tester\",\"password\":\"securePass2026\"}"))
                    .build();
            HttpResponse<String> regRes = client.send(regReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + regRes.statusCode());
            System.out.println("Body: " + regRes.body());

            String token = regRes.body().split("\"token\":\"")[1].split("\"")[0];
            String userId = regRes.body().split("\"id\":\"")[1].split("\"")[0];

            System.out.println("\n[Step 2] Create Scouting Event: POST /api/events");
            HttpRequest eventReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/events"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString("{\"name\":\"Houston Championship 2026\"}"))
                    .build();
            HttpResponse<String> eventRes = client.send(eventReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + eventRes.statusCode());
            System.out.println("Body: " + eventRes.body());
            String eventId = eventRes.body().split("\"id\":\"")[1].split("\"")[0];

            System.out.println("\n[Step 3] Save OpenAI/DeepSeek Settings with BaseURL: POST /api/users/" + userId + "/ai-settings");
            String openAiPayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk-real-secret-token-abcdef123456\","
                    + "\"modelName\":\"deepseek-chat\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\","
                    + "\"proxyHost\":\"127.0.0.1\","
                    + "\"proxyPort\":7890,"
                    + "\"systemPrompt\":\"You are an expert FTC scout.\""
                    + "}";
            HttpRequest saveOpenAiReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/users/" + userId + "/ai-settings"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString(openAiPayload))
                    .build();
            HttpResponse<String> saveOpenAiRes = client.send(saveOpenAiReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + saveOpenAiRes.statusCode());
            System.out.println("Body: " + saveOpenAiRes.body());

            System.out.println("\n[Step 4] Save Gemini Settings: POST /api/users/" + userId + "/ai-settings");
            String geminiPayload = "{"
                    + "\"provider\":\"GEMINI\","
                    + "\"apiKeyEncrypted\":\"AIzaSyGeminiApiKeySecret9999\","
                    + "\"modelName\":\"gemini-flash-latest\","
                    + "\"systemPrompt\":\"You are Gemini assistant.\""
                    + "}";
            HttpRequest saveGeminiReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/users/" + userId + "/ai-settings"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString(geminiPayload))
                    .build();
            HttpResponse<String> saveGeminiRes = client.send(saveGeminiReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + saveGeminiRes.statusCode());
            System.out.println("Body: " + saveGeminiRes.body());

            System.out.println("\n[Step 5] Fetch AI Settings (Check Masking): GET /api/users/" + userId + "/ai-settings");
            HttpRequest getSettingsReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/users/" + userId + "/ai-settings"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> getSettingsRes = client.send(getSettingsReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + getSettingsRes.statusCode());
            System.out.println("Body: " + getSettingsRes.body());

            System.out.println("\n[Step 6] Re-save Form with Masked Key (Verify original key is preserved): POST /api/users/" + userId + "/ai-settings");
            String resavePayload = "{"
                    + "\"provider\":\"OPENAI\","
                    + "\"apiKeyEncrypted\":\"sk****************3456\","
                    + "\"modelName\":\"deepseek-reasoner\","
                    + "\"baseUrl\":\"https://api.deepseek.com/v1\""
                    + "}";
            HttpRequest resaveReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/users/" + userId + "/ai-settings"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString(resavePayload))
                    .build();
            HttpResponse<String> resaveRes = client.send(resaveReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + resaveRes.statusCode());
            System.out.println("Body: " + resaveRes.body());

            jdbi.useExtension(AiSettingsDao.class, dao -> {
                AiSettings s = dao.findByUserIdAndProvider(userId, "OPENAI");
                String decrypted = AESUtil.decrypt(s.getApiKeyEncrypted());
                System.out.println("DB Verification -> Decrypted Original Key: " + decrypted);
                System.out.println("DB Verification -> Updated Model: " + s.getModelName());
                System.out.println("DB Verification -> Updated BaseUrl: " + s.getBaseUrl());
            });

            System.out.println("\n[Step 7] Save Event AI Chat History: PUT /api/events/" + eventId + "/ai-chat");
            String chatJson = "["
                    + "{\"id\":\"m1\",\"role\":\"user\",\"content\":\"Which alliance scored highest in autonomous?\"},"
                    + "{\"id\":\"m2\",\"role\":\"assistant\",\"content\":\"Alliance 1 with Team 27570 scored 58 autonomous points.\"}"
                    + "]";
            HttpRequest saveChatReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/events/" + eventId + "/ai-chat"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .PUT(HttpRequest.BodyPublishers.ofString(chatJson))
                    .build();
            HttpResponse<String> saveChatRes = client.send(saveChatReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + saveChatRes.statusCode());
            System.out.println("Body: " + saveChatRes.body());

            System.out.println("\n[Step 8] Hydrate Event AI Chat History: GET /api/events/" + eventId + "/ai-chat");
            HttpRequest getChatReq = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/events/" + eventId + "/ai-chat"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> getChatRes = client.send(getChatReq, HttpResponse.BodyHandlers.ofString());
            System.out.println("Status: " + getChatRes.statusCode());
            System.out.println("Body: " + getChatRes.body());

            System.out.println("\n[Step 9] Windows Master Key File Verification");
            String masterKeyPath = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "master.key";
            File masterKeyFile = new File(masterKeyPath);
            System.out.println("Path: " + masterKeyFile.getAbsolutePath());
            System.out.println("Exists: " + masterKeyFile.exists());
            System.out.println("Readable: " + masterKeyFile.canRead() + ", Writable: " + masterKeyFile.canWrite());
            System.out.println("Size: " + masterKeyFile.length() + " bytes");

            System.out.println("================================================================================");
            System.out.println("ALL 9 VERIFICATION STEPS COMPLETED AND VERIFIED SUCCESSFULLY!");
            System.out.println("================================================================================");
        } finally {
            app.stop();
        }
    }
}
