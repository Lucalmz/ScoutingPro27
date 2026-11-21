package com.bear27570.app.db;

import com.bear27570.app.Main;
import com.bear27570.app.routes.ApiRoutes;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sql.DataSource;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

class AppConfigIsolationTest {

    private String prevDataDir;
    private String prevNoAutoServer;
    private String prevTestCleanup;

    @BeforeEach
    void saveAndClearProperties() {
        prevDataDir = System.getProperty("scouting.data.dir");
        prevNoAutoServer = System.getProperty("scouting.noAutoServer");
        prevTestCleanup = System.getProperty("ENABLE_TEST_CLEANUP");
        clearProps();
    }

    @AfterEach
    void restoreProperties() {
        JdbiConfig.closeDataSources();
        AppConfig.clearEnvironmentOverride();
        AppConfig.resetLogFileForTest();
        clearProps();
        if (prevDataDir != null) System.setProperty("scouting.data.dir", prevDataDir);
        if (prevNoAutoServer != null) System.setProperty("scouting.noAutoServer", prevNoAutoServer);
        if (prevTestCleanup != null) System.setProperty("ENABLE_TEST_CLEANUP", prevTestCleanup);
    }

    private void clearProps() {
        System.clearProperty("scouting.data.dir");
        System.clearProperty("scouting.noAutoServer");
        System.clearProperty("ENABLE_TEST_CLEANUP");
        AppConfig.clearEnvironmentOverride();
        AppConfig.resetLogFileForTest();
    }

    @Test
    void testExplicitDataDirAndNoAutoServerIsolation(@TempDir Path tempDir) {
        Main.applyBootstrapCliArgs(new String[]{
                "--data-dir=\"" + tempDir.toAbsolutePath() + "\"",
                "--no-auto-server"
        });

        Path expectedRoot = tempDir.toAbsolutePath().normalize();
        File baseDir = AppConfig.resolveBaseDataDir();
        File dbFile = AppConfig.resolveAppDbFile();
        File jwtFile = AppConfig.resolveJwtSecretFile();
        File keyFile = AppConfig.resolveMasterKeyFile();
        File logDir = AppConfig.resolveLogDir();
        File logFile = AppConfig.resolveLogFile();

        assertThat(baseDir.toPath().toAbsolutePath().normalize()).isEqualTo(expectedRoot);
        assertThat(dbFile.toPath().toAbsolutePath().normalize()).isEqualTo(expectedRoot.resolve("app_data"));
        assertThat(jwtFile.toPath().toAbsolutePath().normalize()).isEqualTo(expectedRoot.resolve("jwt.secret"));
        assertThat(keyFile.toPath().toAbsolutePath().normalize()).isEqualTo(expectedRoot.resolve("master.key"));
        assertThat(logDir.toPath().toAbsolutePath().normalize()).isEqualTo(expectedRoot.resolve("log"));
        assertThat(logFile.toPath().toAbsolutePath().normalize().getParent()).isEqualTo(expectedRoot.resolve("log"));

        String jdbcUrl = AppConfig.resolveAppDbUrl();
        assertThat(jdbcUrl).contains("AUTO_SERVER=FALSE");
        assertThat(jdbcUrl).doesNotContain("AUTO_SERVER=TRUE");
        assertThat(jdbcUrl).contains(expectedRoot.resolve("app_data").toString().replace('\\', '/'));
    }

    @Test
    void testIsolatedH2FlywayV8AndWindowsCleanDelete() throws Exception {
        Path isolatedDir = Files.createTempDirectory("sp27-win-lock-test-");
        try {
            System.setProperty("scouting.data.dir", isolatedDir.toAbsolutePath().toString());
            System.setProperty("scouting.noAutoServer", "true");

            String jdbcUrl = AppConfig.resolveAppDbUrl();
            assertThat(jdbcUrl).contains("AUTO_SERVER=FALSE");

            DataSource ds = JdbiConfig.getOrCreateDataSource(jdbcUrl, "sa", "");
            Flyway.configure()
                    .dataSource(ds)
                    .locations("classpath:db")
                    .load()
                    .migrate();

            Jdbi jdbi = JdbiConfig.create(ds);
            jdbi.useHandle(handle -> {
                handle.execute("INSERT INTO users (id, username, password) VALUES ('u1', 'alice', 'hash')");
                handle.execute(
                        "INSERT INTO events (id, name, invite_code, host_id, turn_config_encrypted) VALUES ('evt_1', 'Regional', 'ABC123', 'u1', 'enc_turn_payload')"
                );
                String turnEnc = handle
                        .createQuery("SELECT turn_config_encrypted FROM events WHERE id = 'evt_1'")
                        .mapTo(String.class)
                        .one();
                assertThat(turnEnc).isEqualTo("enc_turn_payload");
                handle.execute(
                        "INSERT INTO event_crdt_state (event_id, host_epoch, snapshot_revision, crdt_snapshot_json) VALUES (?, ?, ?, ?)",
                        "evt_1", 2, 7L, "{\"tables\":{}}"
                );

                Map<String, Object> crdtRow = handle
                        .createQuery("SELECT event_id, host_epoch, snapshot_revision, crdt_snapshot_json FROM event_crdt_state WHERE event_id = 'evt_1'")
                        .mapToMap()
                        .one();
                assertThat(crdtRow.get("host_epoch")).isEqualTo(2);
                assertThat(((Number) crdtRow.get("snapshot_revision")).longValue()).isEqualTo(7L);

                handle.execute("""
                    INSERT INTO scouting_records (
                        id, event_id, scout_id, scout_name, match_number, team_number,
                        author_pub_key, author_sig, host_sig
                    ) VALUES ('rec_1', 'evt_1', 'u1', 'alice', 1, 27570, 'pubHex', 'authSigHex', 'hostSigHex')
                """);

                Map<String, Object> sigRow = handle
                        .createQuery("SELECT author_pub_key, author_sig, host_sig FROM scouting_records WHERE id = 'rec_1'")
                        .mapToMap()
                        .one();
                assertThat(sigRow.get("author_pub_key")).isEqualTo("pubHex");
                assertThat(sigRow.get("author_sig")).isEqualTo("authSigHex");
                assertThat(sigRow.get("host_sig")).isEqualTo("hostSigHex");
            });

            // Close pool and H2 engine so Windows releases .mv.db locks immediately
            JdbiConfig.closeDataSources();
            deleteDirectoryRecursively(isolatedDir);
            assertThat(Files.exists(isolatedDir)).isFalse();
        } finally {
            JdbiConfig.closeDataSources();
            if (Files.exists(isolatedDir)) {
                deleteDirectoryRecursively(isolatedDir);
            }
        }
    }

    @Test
    void testShutdownEndpointGatedAndInvokesCallback() throws Exception {
        String memUrl = "jdbc:h2:mem:shutdown_gate_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(memUrl, "sa", "").locations("classpath:db").load().migrate();
        Jdbi jdbi = Jdbi.create(memUrl, "sa", "");

        // 1. Without ENABLE_TEST_CLEANUP=true -> endpoint is NOT registered and auth guard returns 401
        System.clearProperty("ENABLE_TEST_CLEANUP");
        ApiRoutes gatedRoutes = new ApiRoutes(jdbi);
        CountDownLatch deniedLatch = new CountDownLatch(1);
        gatedRoutes.setShutdownCallback(deniedLatch::countDown);
        Javalin gatedApp = Javalin.create(config -> gatedRoutes.register(config.routes));
        try {
            JavalinTest.test(gatedApp, (server, client) -> {
                var res = client.post("/api/test/shutdown", "{}");
                assertThat(res.code()).isEqualTo(401);
                assertThat(deniedLatch.await(300, TimeUnit.MILLISECONDS)).isFalse();
            });
        } finally {
            gatedRoutes.shutdown();
        }

        // 2. With ENABLE_TEST_CLEANUP=true -> returns 200 and invokes injected shutdown callback
        System.setProperty("ENABLE_TEST_CLEANUP", "true");
        ApiRoutes enabledRoutes = new ApiRoutes(jdbi);
        CountDownLatch okLatch = new CountDownLatch(1);
        enabledRoutes.setShutdownCallback(okLatch::countDown);
        Javalin enabledApp = Javalin.create(config -> enabledRoutes.register(config.routes));
        try {
            JavalinTest.test(enabledApp, (server, client) -> {
                var res = client.post("/api/test/shutdown", "{}");
                assertThat(res.code()).isEqualTo(200);
                assertThat(res.body().string()).contains("shutting_down");
                assertThat(okLatch.await(2, TimeUnit.SECONDS)).isTrue();
            });
        } finally {
            enabledRoutes.shutdown();
        }
    }

    private static void deleteDirectoryRecursively(Path dir) throws Exception {
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        }
    }
}
