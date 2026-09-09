package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.FtcApiClient;
import com.google.gson.Gson;
import com.sun.net.httpserver.HttpServer;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class FtcProxyRoutesTournamentLevelTest {

    private HttpServer mockServer;
    private int mockPort;
    private Jdbi jdbi;
    private Javalin app;
    private Gson gson = new Gson();

    @BeforeEach
    void setUp() throws Exception {
        mockServer = HttpServer.create(new InetSocketAddress(0), 0);
        mockPort = mockServer.getAddress().getPort();
        mockServer.start();

        String dummyResponse = "{\"matches\":[]}";
        mockServer.createContext("/v2.0/2025/matches/TESTEVT", exchange -> {
            byte[] bytes = dummyResponse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });

        String url = "jdbc:h2:mem:test_ftc_proxy_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        jdbi = JdbiConfig.create(url, "sa", "");

        FtcApiClient client = new FtcApiClient("http://127.0.0.1:" + mockPort, "user", "pass");
        ApiRoutes apiRoutes = new ApiRoutes(jdbi, client);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        if (mockServer != null) {
            mockServer.stop(0);
        }
    }

    @Test
    void testTournamentLevelAcceptsQualAndPlayoffWithout400() {
        JavalinTest.test(app, (server, client) -> {
            // Register & login
            client.post("/api/user/register", "{\"username\":\"ftctester\", \"password\":\"Pass123456\"}");
            var loginRes = client.post("/api/user/login", "{\"username\":\"ftctester\", \"password\":\"Pass123456\"}");
            Map<?, ?> loginBody = gson.fromJson(loginRes.body().string(), Map.class);
            String token = (String) loginBody.get("token");

            // 1. Test ?tournamentLevel=qual (should be accepted, not return 400)
            var resQual = client.get("/api/ftc/2025/matches/TESTEVT?tournamentLevel=qual", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resQual.code()).isEqualTo(200);

            // 2. Test ?tournamentLevel=qualification (should also be accepted)
            var resQualLong = client.get("/api/ftc/2025/matches/TESTEVT?tournamentLevel=qualification", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resQualLong.code()).isEqualTo(200);

            // 3. Test ?tournamentLevel=playoff (should also be accepted)
            var resPlayoff = client.get("/api/ftc/2025/matches/TESTEVT?tournamentLevel=playoff", req -> {
                req.header("Authorization", "Bearer " + token);
            });
            assertThat(resPlayoff.code()).isEqualTo(200);
        });
    }
}
