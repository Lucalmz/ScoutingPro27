package com.bear27570.app.routes;

import com.bear27570.app.util.NetworkUtil;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;

import java.util.HashMap;
import java.util.Map;

public class SystemRoutes {
    private final Gson gson;

    public SystemRoutes(Gson gson) {
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/system/network-info", ctx -> {
            NetworkUtil.NetworkInfo info = NetworkUtil.getCompleteNetworkInfo();
            int currentPort = ctx.port();
            String osType = NetworkUtil.getOsType();
            boolean firewallAllowed = NetworkUtil.isWindowsFirewallPortAllowed(currentPort);
            Map<String, Object> data = new HashMap<>();
            data.put("os", osType);
            data.put("isWindows", "windows".equals(osType));
            data.put("isMac", "macos".equals(osType));
            data.put("primaryIp", info.primaryIp());
            data.put("allIps", info.allIps());
            data.put("primaryIpv6", info.primaryIpv6());
            data.put("allIpv6s", info.allIpv6s());
            data.put("port", currentPort);
            data.put("firewallAllowed", firewallAllowed);
            data.put("firewallCommand", NetworkUtil.getFirewallCommand(currentPort));
            data.put("macFirewallCommand", NetworkUtil.getMacFirewallCommand(currentPort));
            data.put("joinBaseUrl", "http://" + info.primaryIp() + ":" + currentPort);
            if (info.primaryIpv6() != null && !info.primaryIpv6().isBlank()) {
                data.put("joinBaseUrlIpv6", "http://[" + info.primaryIpv6() + "]:" + currentPort);
            }
            ctx.result(gson.toJson(data)).contentType("application/json");
        });

        routes.post("/api/system/open-firewall-cmd", ctx -> {
            int currentPort = ctx.port();
            boolean success = NetworkUtil.openWindowsFirewallPrompt(currentPort);
            boolean allowed = NetworkUtil.isWindowsFirewallPortAllowed(currentPort);
            String cmd = NetworkUtil.getFirewallCommand(currentPort);
            Map<String, Object> resp = new HashMap<>();
            resp.put("success", success && allowed);
            resp.put("allowed", allowed);
            resp.put("command", cmd);
            resp.put("port", currentPort);
            resp.put("os", System.getProperty("os.name", "").toLowerCase());
            ctx.result(gson.toJson(resp)).contentType("application/json");
        });
    }
}
