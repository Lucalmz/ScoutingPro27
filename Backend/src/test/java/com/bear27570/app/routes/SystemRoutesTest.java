package com.bear27570.app.routes;

import com.google.gson.Gson;
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
            assertThat(body).contains("\"primaryIp\":");
            assertThat(body).contains("\"allIps\":");
            assertThat(body).contains("\"primaryIpv6\":");
            assertThat(body).contains("\"allIpv6s\":");
            assertThat(body).contains("\"firewallCommand\":");
            assertThat(body).contains("\"port\":");

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
}
