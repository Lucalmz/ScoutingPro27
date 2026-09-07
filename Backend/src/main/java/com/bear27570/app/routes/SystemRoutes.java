package com.bear27570.app.routes;

import com.bear27570.app.util.NetworkUtil;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;

import java.util.Map;

public class SystemRoutes {
    private final Gson gson;

    public SystemRoutes(Gson gson) {
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/system/network-info", ctx -> {
            NetworkUtil.NetworkInfo info = NetworkUtil.getLanIpv4Info();
            int currentPort = ctx.port();
            ctx.result(gson.toJson(Map.of(
                    "primaryIp", info.primaryIp(),
                    "allIps", info.allIps(),
                    "port", currentPort,
                    "joinBaseUrl", "http://" + info.primaryIp() + ":" + currentPort
            ))).contentType("application/json");
        });
    }
}
