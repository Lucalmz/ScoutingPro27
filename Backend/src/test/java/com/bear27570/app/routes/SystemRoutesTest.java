package com.bear27570.app.routes;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SystemRoutesTest {

    private String prevSkipFirewallCheck;
    private Javalin app;

    @BeforeEach
    void setUp() {
        prevSkipFirewallCheck = System.getProperty("SKIP_FIREWALL_CHECK");
        System.setProperty("SKIP_FIREWALL_CHECK", "true");
        app = Javalin.create(config -> new SystemRoutes(new Gson()).register(config.routes));
    }

    @AfterEach
    void tearDown() {
        if (prevSkipFirewallCheck == null) {
            System.clearProperty("SKIP_FIREWALL_CHECK");
        } else {
            System.setProperty("SKIP_FIREWALL_CHECK", prevSkipFirewallCheck);
        }
    }

    @Test
    void testNetworkInfoEndpointAndRemovedHealRoute() {
        JavalinTest.test(app, (server, client) -> {
            var infoRes = client.get("/api/system/network-info");
            assertThat(infoRes.code()).isEqualTo(200);
            String body = infoRes.body().string();
            JsonObject json = JsonParser.parseString(body).getAsJsonObject();
            assertThat(json.has("primaryIp")).isTrue();
            assertThat(json.get("allIps").isJsonArray()).isTrue();
            assertThat(json.get("allIpv6s").isJsonArray()).isTrue();
            assertThat(json.has("firewallCommand")).isTrue();
            assertThat(json.has("port")).isTrue();
            assertThat(json.has("os")).isTrue();
            assertThat(json.has("joinBaseUrl")).isTrue();

            JsonArray allIpv6s = json.getAsJsonArray("allIpv6s");
            if (!allIpv6s.isEmpty()) {
                assertThat(json.has("primaryIpv6")).isTrue();
                assertThat(json.get("primaryIpv6").isJsonNull()).isFalse();
                assertThat(json.get("primaryIpv6").getAsString()).isNotBlank();
                assertThat(json.has("joinBaseUrlIpv6")).isTrue();
            } else {
                assertThat(!json.has("primaryIpv6") || json.get("primaryIpv6").isJsonNull()).isTrue();
            }

            var healRes = client.post("/api/system/heal-ipv6-routes");
            assertThat(healRes.code()).isEqualTo(404);
        });
    }

    @Test
    void testOpenFirewallCmdEndpoint() {
        JavalinTest.test(app, (server, client) -> {
            var res = client.post("/api/system/open-firewall-cmd");
            assertThat(res.code()).isEqualTo(200);
            String body = res.body().string();
            assertThat(body).contains("\"command\":");
            assertThat(body).contains("netsh advfirewall firewall add rule");
            assertThat(body).contains("\"os\":");
        });
    }

    @Test
    void testRemoteFirewallBlockedLogPayloadLimitNewlineEscapeAndTestCleanupFlag() throws Exception {
        String prevCleanup = System.getProperty("ENABLE_TEST_CLEANUP");
        try {
            System.setProperty("ENABLE_TEST_CLEANUP", "  TRUE  ");
            assertThat(ApiRoutes.isTestCleanupEnabled()).isTrue();
            System.setProperty("ENABLE_TEST_CLEANUP", "false");
            assertThat(ApiRoutes.isTestCleanupEnabled()).isFalse();
        } finally {
            if (prevCleanup == null) {
                System.clearProperty("ENABLE_TEST_CLEANUP");
            } else {
                System.setProperty("ENABLE_TEST_CLEANUP", prevCleanup);
            }
        }

        Javalin lanApp = Javalin.create(config ->
                new SystemRoutes(new Gson(), ctx -> "192.168.43.88").register(config.routes));

        JavalinTest.test(lanApp, (server, client) -> {
            // Even if remote peer spoofs X-Forwarded-For: 127.0.0.1, remoteAddr 192.168.43.88 MUST be rejected with 403
            var blockedFirewall = client.post("/api/system/open-firewall-cmd", "",
                    req -> req.header("X-Forwarded-For", "127.0.0.1"));
            assertThat(blockedFirewall.code()).isEqualTo(403);
            assertThat(blockedFirewall.body().string()).contains("restricted to local host loopback");

            // > 16 KB remote log payload MUST be rejected with 400
            var oversizedLog = client.post("/api/system/log", "L".repeat(16_385));
            assertThat(oversizedLog.code()).isEqualTo(400);
            assertThat(oversizedLog.body().string()).contains("exceeds 16 KB limit");

            // Embedded CR/LF newlines MUST be escaped into a single log entry line
            String marker = "MARKER_" + System.nanoTime();
            var okLog = client.post("/api/system/log", marker + "_line1\r\n[2099-01-01] [FORGED] injected");
            assertThat(okLog.code()).isEqualTo(200);

            java.io.File logFile = com.bear27570.app.db.AppConfig.resolveLogFile();
            String logContent = java.nio.file.Files.readString(logFile.toPath(), java.nio.charset.StandardCharsets.UTF_8);
            String matchingLine = logContent.lines()
                    .filter(l -> l.contains(marker))
                    .findFirst()
                    .orElse("");
            assertThat(matchingLine).contains(marker + "_line1\\n[2099-01-01] [FORGED] injected");
        });
    }
}
