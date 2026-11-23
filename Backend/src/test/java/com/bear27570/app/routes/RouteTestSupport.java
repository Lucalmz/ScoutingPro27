package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.FtcApiClient;
import com.bear27570.app.util.JwtUtil;
import io.javalin.Javalin;
import io.javalin.testtools.HttpClient;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

final class RouteTestSupport {

    final Jdbi jdbi;
    final ApiRoutes apiRoutes;
    final Javalin app;
    private final Path tempDir;
    private final String prevDataDir;

    RouteTestSupport(String dbPrefix) {
        this(dbPrefix, null);
    }

    RouteTestSupport(String dbPrefix, FtcApiClient ftcApiClient) {
        this.prevDataDir = System.getProperty("scouting.data.dir");
        try {
            this.tempDir = Files.createTempDirectory("sp27-route-test-");
        } catch (IOException e) {
            throw new RuntimeException("Failed to create temp data dir for RouteTestSupport", e);
        }
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();

        String url = "jdbc:h2:mem:" + dbPrefix + "_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();
        this.jdbi = JdbiConfig.create(url, "sa", "");
        this.apiRoutes = ftcApiClient != null ? new ApiRoutes(jdbi, ftcApiClient) : new ApiRoutes(jdbi);
        this.app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    void close() {
        try {
            if (apiRoutes != null) {
                apiRoutes.shutdown();
            }
            JdbiConfig.closeDataSources();
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) {
                System.clearProperty("scouting.data.dir");
            } else {
                System.setProperty("scouting.data.dir", prevDataDir);
            }
            deleteRecursively(tempDir);
        }
    }

    private static void deleteRecursively(Path root) {
        if (root == null || !Files.exists(root)) return;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }

    static final class RoomFixture {
        String hostToken, hostId;
        String scoutAToken, scoutAId;
        String scoutBToken, scoutBId;
        String outsiderToken, outsiderId;
        String eventId, inviteCode;
    }

    static RoomFixture setupRoomFixture(HttpClient client) {
        RoomFixture fix = new RoomFixture();

        var hostReg = client.post("/api/user/register", "{\"username\":\"host_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        String hostBody = hostReg.body().string();
        fix.hostToken = hostBody.split("\"token\":\"")[1].split("\"")[0];
        fix.hostId = hostBody.split("\"id\":\"")[1].split("\"")[0];

        var scoutAReg = client.post("/api/user/register", "{\"username\":\"scouta_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        String scoutABody = scoutAReg.body().string();
        fix.scoutAToken = scoutABody.split("\"token\":\"")[1].split("\"")[0];
        fix.scoutAId = scoutABody.split("\"id\":\"")[1].split("\"")[0];

        var scoutBReg = client.post("/api/user/register", "{\"username\":\"scoutb_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        String scoutBBody = scoutBReg.body().string();
        fix.scoutBToken = scoutBBody.split("\"token\":\"")[1].split("\"")[0];
        fix.scoutBId = scoutBBody.split("\"id\":\"")[1].split("\"")[0];

        var outsiderReg = client.post("/api/user/register", "{\"username\":\"out_" + System.nanoTime() + "\", \"password\":\"secret\"}");
        String outsiderBody = outsiderReg.body().string();
        fix.outsiderToken = outsiderBody.split("\"token\":\"")[1].split("\"")[0];
        fix.outsiderId = outsiderBody.split("\"id\":\"")[1].split("\"")[0];

        var eventRes = client.post("/api/events", "{\"name\":\"Super Regional\"}", b -> b.header("Authorization", "Bearer " + fix.hostToken));
        String eventBody = eventRes.body().string();
        fix.eventId = eventBody.split("\"id\":\"")[1].split("\"")[0];
        fix.inviteCode = eventBody.split("\"inviteCode\":\"")[1].split("\"")[0];

        client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutAToken));
        client.post("/api/events/join", "{\"inviteCode\":\"" + fix.inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + fix.scoutBToken));
        return fix;
    }
}
