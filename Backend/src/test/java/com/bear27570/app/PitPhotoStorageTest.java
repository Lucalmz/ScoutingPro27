package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.db.AppConfig;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.routes.ApiRoutes;
import com.google.gson.Gson;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class PitPhotoStorageTest {

    private Jdbi jdbi;
    private Javalin app;
    private Gson gson = new Gson();
    private String testEventId = "test-event-" + System.nanoTime();
    private File testPhotoDir;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_photo_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        app = Javalin.create(config -> {
            config.http.maxRequestSize = 15_000_000L;
            new ApiRoutes(jdbi).register(config.routes);
        });

        testPhotoDir = new File(AppConfig.resolveBaseDataDir(), "pit_photos" + File.separator + testEventId);
    }

    @AfterEach
    void tearDown() {
        if (testPhotoDir != null && testPhotoDir.exists()) {
            File[] files = testPhotoDir.listFiles();
            if (files != null) {
                for (File f : files) f.delete();
            }
            testPhotoDir.delete();
        }
    }

    @Test
    void testUploadAndStreamPhotoLifecycle() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register & Login to get token
            client.post("/api/user/register", "{\"username\":\"phototesteer\", \"password\":\"Pass123456\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"phototesteer\", \"password\":\"Pass123456\"}");
            assertThat(loginRes.code()).isEqualTo(200);
            Map<?, ?> loginBody = gson.fromJson(loginRes.body().string(), Map.class);
            String token = (String) loginBody.get("token");
            String userId = (String) loginBody.get("id");
            assertThat(token).isNotBlank();

            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent evt = new ScoutingEvent();
                evt.setId(testEventId);
                evt.setName("Test Pit Event");
                evt.setHostId(userId);
                evt.setInviteCode("PITTEST1");
                dao.insert(evt);
            });

            // 2. Upload photo without token -> 401 Unauthorized
            String dummyBase64 = Base64.getEncoder().encodeToString("fake-webp-binary-content".getBytes());
            String uploadJson = gson.toJson(Map.of(
                    "key", "pit_27570_photo1",
                    "dataUrl", "data:image/webp;base64," + dummyBase64
            ));

            var unauthRes = client.post("/api/events/" + testEventId + "/pit/photos", uploadJson);
            assertThat(unauthRes.code()).isEqualTo(401);

            // 3. Upload photo WITH token -> 200 OK
            var authUploadRes = client.post("/api/events/" + testEventId + "/pit/photos", uploadJson, req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(authUploadRes.code()).isEqualTo(200);
            assertThat(authUploadRes.body().string()).contains("\"success\":true");

            // 4. Verify physical file is written on computer disk
            File savedFile = new File(testPhotoDir, "pit_27570_photo1.webp");
            assertThat(savedFile.exists()).isTrue();
            byte[] diskBytes = Files.readAllBytes(savedFile.toPath());
            assertThat(new String(diskBytes)).isEqualTo("fake-webp-binary-content");

            // 5. Stream photo GET WITHOUT token (simulating browser <img> tag) -> 200 OK
            var getRes = client.get("/api/events/" + testEventId + "/pit/photos/pit_27570_photo1");
            assertThat(getRes.code()).isEqualTo(200);
            assertThat(getRes.headers().get("Content-Type")).contains("image/webp");
            assertThat(getRes.headers().get("Cache-Control")).anyMatch(h -> h.contains("immutable"));
            assertThat(getRes.body().string()).isEqualTo("fake-webp-binary-content");

            // 6. Request non-existent photo -> 404
            var notFoundRes = client.get("/api/events/" + testEventId + "/pit/photos/non_existent_key");
            assertThat(notFoundRes.code()).isEqualTo(404);

            // 7. Path traversal attack -> 400 Bad Request
            var traversalRes = client.post("/api/events/" + testEventId + "/pit/photos",
                    gson.toJson(Map.of("key", "../malicious", "dataUrl", "data:image/webp;base64," + dummyBase64)),
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(traversalRes.code()).isEqualTo(400);
        });
    }

    @Test
    void testNetworkInfoEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            var res = client.get("/api/system/network-info");
            assertThat(res.code()).isEqualTo(200);
            String body = res.body().string();
            assertThat(body).contains("primaryIp");
            assertThat(body).contains("allIps");
            assertThat(body).contains("port");
        });
    }

    @Test
    void testUploadLargePhotoPayload() {
        JavalinTest.test(app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"largephotouser\", \"password\":\"Pass123456\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"largephotouser\", \"password\":\"Pass123456\"}");
            Map<?, ?> loginBody = gson.fromJson(loginRes.body().string(), Map.class);
            String token = (String) loginBody.get("token");
            String userId = (String) loginBody.get("id");

            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent evt = new ScoutingEvent();
                evt.setId(testEventId);
                evt.setName("Test Large Photo Event");
                evt.setHostId(userId);
                evt.setInviteCode("PITTEST2");
                dao.insert(evt);
            });

            // Generate ~2MB payload (exceeds default Javalin 1MB maxRequestSize)
            byte[] largeData = new byte[2 * 1024 * 1024];
            java.util.Arrays.fill(largeData, (byte) 'A');
            String dummyBase64 = Base64.getEncoder().encodeToString(largeData);
            String uploadJson = gson.toJson(Map.of(
                    "key", "pit_27570_large_photo",
                    "dataUrl", "data:image/webp;base64," + dummyBase64
            ));

            var authUploadRes = client.post("/api/events/" + testEventId + "/pit/photos", uploadJson, req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(authUploadRes.code()).isEqualTo(200);
            assertThat(authUploadRes.body().string()).contains("\"success\":true");

            File savedFile = new File(testPhotoDir, "pit_27570_large_photo.webp");
            assertThat(savedFile.exists()).isTrue();
            assertThat(savedFile.length()).isEqualTo(2 * 1024 * 1024);
        });
    }

    @Test
    void testDeletePhotoSuccessAndForbidden() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Register Member and Outsider
            client.post("/api/user/register", "{\"username\":\"photohost\", \"password\":\"Pass123456\"}");
            var hostLogin = client.post("/api/user/login", "{\"username\":\"photohost\", \"password\":\"Pass123456\"}");
            Map<?, ?> hostBody = gson.fromJson(hostLogin.body().string(), Map.class);
            String hostToken = (String) hostBody.get("token");
            String hostId = (String) hostBody.get("id");

            client.post("/api/user/register", "{\"username\":\"photooutsider\", \"password\":\"Pass123456\"}");
            var outLogin = client.post("/api/user/login", "{\"username\":\"photooutsider\", \"password\":\"Pass123456\"}");
            Map<?, ?> outBody = gson.fromJson(outLogin.body().string(), Map.class);
            String outsiderToken = (String) outBody.get("token");

            // Create event for host
            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent evt = new ScoutingEvent();
                evt.setId(testEventId);
                evt.setName("Test Photo Event");
                evt.setHostId(hostId);
                evt.setInviteCode("DELTEST");
                dao.insert(evt);
            });

            // 2. Upload a photo as host
            String dummyBase64 = Base64.getEncoder().encodeToString("delete-me-bytes".getBytes());
            String uploadJson = gson.toJson(Map.of(
                    "key", "photo_to_delete",
                    "dataUrl", "data:image/webp;base64," + dummyBase64
            ));
            var uploadRes = client.post("/api/events/" + testEventId + "/pit/photos", uploadJson,
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(uploadRes.code()).isEqualTo(200);

            File savedFile = new File(testPhotoDir, "photo_to_delete.webp");
            assertThat(savedFile.exists()).isTrue();

            // 3. Outsider attempts to DELETE photo -> 403 Forbidden
            var forbiddenDelRes = client.delete("/api/events/" + testEventId + "/pit/photos/photo_to_delete", null,
                    req -> req.header("Authorization", "Bearer " + outsiderToken));
            assertThat(forbiddenDelRes.code()).isEqualTo(403);
            assertThat(savedFile.exists()).isTrue(); // File must still exist!

            // 4. Host calls DELETE photo -> 200 OK
            var successDelRes = client.delete("/api/events/" + testEventId + "/pit/photos/photo_to_delete", null,
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(successDelRes.code()).isEqualTo(200);
            assertThat(savedFile.exists()).isFalse(); // File must be physically deleted!
        });
    }

    @Test
    void testUploadNegativeAuthAndCorrupted() {
        JavalinTest.test(app, (server, client) -> {
            client.post("/api/user/register", "{\"username\":\"owneruser\", \"password\":\"Pass123456\"}");
            var ownerLogin = client.post("/api/user/login", "{\"username\":\"owneruser\", \"password\":\"Pass123456\"}");
            Map<?, ?> ownerBody = gson.fromJson(ownerLogin.body().string(), Map.class);
            String ownerToken = (String) ownerBody.get("token");
            String ownerId = (String) ownerBody.get("id");

            client.post("/api/user/register", "{\"username\":\"alienuser\", \"password\":\"Pass123456\"}");
            var alienLogin = client.post("/api/user/login", "{\"username\":\"alienuser\", \"password\":\"Pass123456\"}");
            Map<?, ?> alienBody = gson.fromJson(alienLogin.body().string(), Map.class);
            String alienToken = (String) alienBody.get("token");

            jdbi.useExtension(EventDao.class, dao -> {
                ScoutingEvent evt = new ScoutingEvent();
                evt.setId(testEventId);
                evt.setName("Negative Test Event");
                evt.setHostId(ownerId);
                evt.setInviteCode("NEGTEST");
                dao.insert(evt);
            });

            String validBase64 = Base64.getEncoder().encodeToString("content".getBytes());

            // 1. Alien user (not a member) attempts to upload -> 403 Forbidden
            var alienUpload = client.post("/api/events/" + testEventId + "/pit/photos",
                    gson.toJson(Map.of("key", "alien_key", "dataUrl", "data:image/webp;base64," + validBase64)),
                    req -> req.header("Authorization", "Bearer " + alienToken));
            assertThat(alienUpload.code()).isEqualTo(403);

            // 2. Owner uploads with invalid corrupted base64 -> 400 Bad Request
            var corruptedUpload = client.post("/api/events/" + testEventId + "/pit/photos",
                    gson.toJson(Map.of("key", "bad_base64", "dataUrl", "data:image/webp;base64,!!!invalid_base64!!!")),
                    req -> req.header("Authorization", "Bearer " + ownerToken));
            assertThat(corruptedUpload.code()).isEqualTo(400);
            assertThat(corruptedUpload.body().string()).contains("Invalid base64 encoding");
        });
    }
}
