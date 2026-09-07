package com.bear27570.app;

import com.bear27570.app.db.AppConfig;
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
            assertThat(token).isNotBlank();

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
}
