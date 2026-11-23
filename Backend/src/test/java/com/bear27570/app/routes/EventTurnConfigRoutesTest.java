package com.bear27570.app.routes;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.TurnServerConfig;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class EventTurnConfigRoutesTest {

    @TempDir
    Path tempDir;

    private Jdbi jdbi;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;
    private final Gson gson = new Gson();

    @BeforeEach
    void setUp() throws Exception {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();
        AESUtil.initMasterKey();
        String url = "jdbc:h2:mem:test_turn_cfg_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
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
        }
    }

    private Map<?, ?> registerUser(io.javalin.testtools.HttpClient client, String username) throws Exception {
        var res = client.post("/api/user/register",
                gson.toJson(Map.of("username", username, "password", "Pass123!")));
        assertThat(res.code()).isEqualTo(200);
        return gson.fromJson(res.body().string(), Map.class);
    }

    private String createEvent(io.javalin.testtools.HttpClient client, String token, String name) throws Exception {
        var res = client.post("/api/events", gson.toJson(Map.of("name", name)),
                req -> req.header("Authorization", "Bearer " + token));
        assertThat(res.code()).isEqualTo(200);
        Map<?, ?> evtMap = gson.fromJson(res.body().string(), Map.class);
        return (String) evtMap.get("id");
    }

    @Test
    void testHostSavesCustomTurnConfigEncryptedInDbAndDecryptedOnGet() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> host = registerUser(client, "turn_host");
            String hostToken = (String) host.get("token");
            String eventId = createEvent(client, hostToken, "Turn Test Event");

            String turnUrl = "turn:turn.example.com:3478";
            String turnPass = "super_secret_turn_password_99";
            var putRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("  " + turnUrl + "  ", "turns:turn.example.com:5349"),
                            "username", "  ftc_scout  ",
                            "credential", turnPass
                    )),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(putRes.code()).isEqualTo(200);

            Map<?, ?> putBody = gson.fromJson(putRes.body().string(), Map.class);
            assertThat(putBody.get("hasCustomTurn")).isEqualTo(true);

            // Verify DB stores ciphertext, NOT plaintext
            String rawDbEncrypted = jdbi.withHandle(h ->
                    h.createQuery("SELECT turn_config_encrypted FROM events WHERE id = ?")
                            .bind(0, eventId)
                            .mapTo(String.class)
                            .one());
            assertThat(rawDbEncrypted).isNotNull().isNotBlank();
            assertThat(rawDbEncrypted).doesNotContain(turnPass);
            assertThat(rawDbEncrypted).doesNotContain(turnUrl);

            // Verify GET /api/events returns decrypted customTurnConfig, hasCustomTurn=true, turnConfigEncrypted=null
            var getRes = client.get("/api/events", req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(getRes.code()).isEqualTo(200);
            String getJson = getRes.body().string();
            assertThat(getJson).doesNotContain("turnConfigEncrypted");

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> events = gson.fromJson(getJson, List.class);
            assertThat(events).hasSize(1);
            Map<String, Object> evt = events.get(0);
            assertThat(evt.get("hasCustomTurn")).isEqualTo(true);
            assertThat(evt.get("turnConfigEncrypted")).isNull();

            @SuppressWarnings("unchecked")
            Map<String, Object> cfg = (Map<String, Object>) evt.get("customTurnConfig");
            assertThat(cfg).isNotNull();
            assertThat(cfg.get("username")).isEqualTo("ftc_scout");
            assertThat(cfg.get("credential")).isEqualTo(turnPass);
            @SuppressWarnings("unchecked")
            List<String> urls = (List<String>) cfg.get("urls");
            assertThat(urls).containsExactly(turnUrl, "turns:turn.example.com:5349");
        });
    }

    @Test
    void testNonHostReceives403OnPutTurnConfig() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> host = registerUser(client, "host_user");
            String hostToken = (String) host.get("token");
            String eventId = createEvent(client, hostToken, "Host Only Event");

            Map<?, ?> other = registerUser(client, "scout_user");
            String otherToken = (String) other.get("token");

            var putRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("turn:turn.example.com:3478"),
                            "username", "user1",
                            "credential", "pass1"
                    )),
                    req -> req.header("Authorization", "Bearer " + otherToken));
            assertThat(putRes.code()).isEqualTo(403);
        });
    }

    @Test
    void testUpdatingWithMaskedCredentialPreservesExistingDbCredential() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> host = registerUser(client, "mask_host");
            String hostToken = (String) host.get("token");
            String eventId = createEvent(client, hostToken, "Masked Cred Event");

            String originalCred = "original_secret_cred_42";
            var initRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("turn:old.example.com:3478"),
                            "username", "old_user",
                            "credential", originalCred
                    )),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(initRes.code()).isEqualTo(200);

            // Update URL and username while sending masked credential
            var updateRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("turns:new.example.com:5349"),
                            "username", "new_user",
                            "credential", "********"
                    )),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(updateRes.code()).isEqualTo(200);

            String rawDbEncrypted = jdbi.withHandle(h ->
                    h.createQuery("SELECT turn_config_encrypted FROM events WHERE id = ?")
                            .bind(0, eventId)
                            .mapTo(String.class)
                            .one());
            TurnServerConfig decrypted = gson.fromJson(AESUtil.decrypt(rawDbEncrypted), TurnServerConfig.class);
            assertThat(decrypted.getUrls()).containsExactly("turns:new.example.com:5349");
            assertThat(decrypted.getUsername()).isEqualTo("new_user");
            assertThat(decrypted.getCredential()).isEqualTo(originalCred);
        });
    }

    @Test
    void testInvalidTurnUrlReturns400() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> host = registerUser(client, "badurl_host");
            String hostToken = (String) host.get("token");
            String eventId = createEvent(client, hostToken, "Invalid Url Event");

            var putRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("http://bad"),
                            "username", "user1",
                            "credential", "pass1"
                    )),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(putRes.code()).isEqualTo(400);
        });
    }

    @Test
    void testClearingTurnConfigSetsNullInDbAndHasCustomTurnFalse() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> host = registerUser(client, "clear_host");
            String hostToken = (String) host.get("token");
            String eventId = createEvent(client, hostToken, "Clear Turn Event");

            var initRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of(
                            "urls", List.of("turn:turn.example.com:3478"),
                            "username", "u",
                            "credential", "p"
                    )),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(initRes.code()).isEqualTo(200);

            var clearRes = client.put("/api/events/" + eventId + "/turn-config",
                    gson.toJson(Map.of("urls", List.of())),
                    req -> req.header("Authorization", "Bearer " + hostToken));
            assertThat(clearRes.code()).isEqualTo(200);

            Map<?, ?> clearBody = gson.fromJson(clearRes.body().string(), Map.class);
            assertThat(clearBody.get("hasCustomTurn")).isEqualTo(false);
            assertThat(clearBody.get("customTurnConfig")).isNull();

            String rawDbEncrypted = jdbi.withHandle(h ->
                    h.createQuery("SELECT turn_config_encrypted FROM events WHERE id = ?")
                            .bind(0, eventId)
                            .mapTo(String.class)
                            .one());
            assertThat(rawDbEncrypted).isNull();
        });
    }

    @Test
    void testExternalSyncEncryptsIncomingCustomTurnConfig() {
        JavalinTest.test(app, (server, client) -> {
            Map<?, ?> user = registerUser(client, "sync_scout");
            String token = (String) user.get("token");

            String syncEventId = "ext_sync_turn_evt_1";
            String turnPass = "synced_secret_77";
            Map<String, Object> payload = Map.of(
                    "id", syncEventId,
                    "name", "Synced Event",
                    "inviteCode", "SYNC77",
                    "hostId", "remote_host_1",
                    "customTurnConfig", Map.of(
                            "urls", List.of("turn:sync.example.com:3478"),
                            "username", "sync_user",
                            "credential", turnPass
                    )
            );

            var syncRes = client.post("/api/events/external-sync", gson.toJson(payload),
                    req -> req.header("Authorization", "Bearer " + token));
            assertThat(syncRes.code()).isEqualTo(200);

            Map<?, ?> syncBody = gson.fromJson(syncRes.body().string(), Map.class);
            assertThat(syncBody.get("hasCustomTurn")).isEqualTo(true);
            assertThat(syncBody.get("turnConfigEncrypted")).isNull();

            String rawDbEncrypted = jdbi.withHandle(h ->
                    h.createQuery("SELECT turn_config_encrypted FROM events WHERE id = ?")
                            .bind(0, syncEventId)
                            .mapTo(String.class)
                            .one());
            assertThat(rawDbEncrypted).isNotNull().isNotBlank();
            assertThat(rawDbEncrypted).doesNotContain(turnPass);

            TurnServerConfig decrypted = gson.fromJson(AESUtil.decrypt(rawDbEncrypted), TurnServerConfig.class);
            assertThat(decrypted.getUrls()).containsExactly("turn:sync.example.com:3478");
            assertThat(decrypted.getUsername()).isEqualTo("sync_user");
            assertThat(decrypted.getCredential()).isEqualTo(turnPass);
        });
    }
}
