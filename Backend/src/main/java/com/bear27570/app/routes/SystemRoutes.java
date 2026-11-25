package com.bear27570.app.routes;

import com.bear27570.app.util.NetworkUtil;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;

import java.net.InetAddress;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

public class SystemRoutes {
    public static final int MAX_REMOTE_LOG_CHARS = 16_384;

    private final Gson gson;
    private final Function<Context, String> remoteAddrResolver;

    public SystemRoutes(Gson gson) {
        this(gson, ctx -> ctx.req().getRemoteAddr());
    }

    SystemRoutes(Gson gson, Function<Context, String> remoteAddrResolver) {
        this.gson = gson;
        this.remoteAddrResolver = remoteAddrResolver != null ? remoteAddrResolver : (ctx -> ctx.req().getRemoteAddr());
    }

    static boolean isLoopbackAddress(String rawAddr) {
        if (rawAddr == null || rawAddr.isBlank()) {
            return false;
        }
        String clean = rawAddr.trim();
        if (clean.startsWith("[") && clean.endsWith("]") && clean.length() > 2) {
            clean = clean.substring(1, clean.length() - 1);
        }
        int scopeIdx = clean.indexOf('%');
        if (scopeIdx >= 0) {
            clean = clean.substring(0, scopeIdx);
        }
        if ("127.0.0.1".equals(clean)
                || "::1".equals(clean)
                || "0:0:0:0:0:0:0:1".equals(clean)
                || "localhost".equalsIgnoreCase(clean)) {
            return true;
        }
        if (clean.startsWith("127.")) {
            try {
                return InetAddress.getByName(clean).isLoopbackAddress();
            } catch (Exception ignored) {
                return false;
            }
        }
        return false;
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
            String remoteAddr = remoteAddrResolver.apply(ctx);
            if (!isLoopbackAddress(remoteAddr)) {
                ctx.status(403)
                        .result("{\"error\":\"Firewall configuration is restricted to local host loopback\"}")
                        .contentType("application/json");
                return;
            }
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

        routes.post("/api/system/log", ctx -> {
            String body = ctx.body();
            if (body != null && body.length() > MAX_REMOTE_LOG_CHARS) {
                ctx.status(400)
                        .result("{\"error\":\"Log payload exceeds 16 KB limit\"}")
                        .contentType("application/json");
                return;
            }
            if (body != null && !body.isBlank()) {
                java.io.File logFile = com.bear27570.app.db.AppConfig.resolveLogFile();
                String time = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME);
                String sanitizedBody = body.trim().replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n");
                String remoteIp = remoteAddrResolver.apply(ctx);
                String formatted = String.format("[%s] [RemoteClient-%s] %s%n", time, remoteIp, sanitizedBody);
                synchronized (com.bear27570.app.db.AppConfig.class) {
                    try {
                        java.nio.file.Files.writeString(
                            logFile.toPath(),
                            formatted,
                            java.nio.file.StandardOpenOption.CREATE,
                            java.nio.file.StandardOpenOption.APPEND
                        );
                    } catch (Exception e) {
                        System.err.println("写入客户端上报日志失败: " + e.getMessage());
                    }
                }
            }
            ctx.result("{\"success\":true}").contentType("application/json");
        });
    }
}
