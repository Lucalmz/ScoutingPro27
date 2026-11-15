package com.bear27570.app.routes;

import com.bear27570.app.util.FtcApiClient;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;

import java.util.Map;

public class FtcProxyRoutes {

    private final FtcApiClient ftcApiClient;
    private final Gson gson;

    public FtcProxyRoutes(FtcApiClient ftcApiClient, Gson gson) {
        this.ftcApiClient = ftcApiClient;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/ftc/{season}/matches/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }
            String tournamentLevel = ctx.queryParam("tournamentLevel");
            if (tournamentLevel != null && !tournamentLevel.isBlank() && !tournamentLevel.matches("^(?i)(QUAL|QUALIFICATION|PLAYOFF)$")) {
                ctx.status(400).result("Invalid tournamentLevel");
                return;
            }

            try {
                var matches = ftcApiClient.fetchNormalizedMatches(season, eventCode, tournamentLevel);
                ctx.result(gson.toJson(matches)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching matches: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/scores/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }
            String tournamentLevel = ctx.queryParam("tournamentLevel");
            if (tournamentLevel != null && !tournamentLevel.isBlank() && !tournamentLevel.matches("^(?i)(QUAL|QUALIFICATION|PLAYOFF)$")) {
                ctx.status(400).result("Invalid tournamentLevel");
                return;
            }

            try {
                var scores = ftcApiClient.fetchScoreBreakdown(season, eventCode, tournamentLevel);
                ctx.result(gson.toJson(scores)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching scores: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/teams/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }

            try {
                var teams = ftcApiClient.fetchNormalizedTeams(season, eventCode);
                ctx.result(gson.toJson(teams)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching teams: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/rankings/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }

            try {
                var rankings = ftcApiClient.fetchNormalizedRankings(season, eventCode);
                ctx.result(gson.toJson(rankings)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching rankings: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/awards/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }

            try {
                var awards = ftcApiClient.fetchAwards(season, eventCode);
                ctx.result(gson.toJson(awards)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching awards: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/alliances/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }

            try {
                var alliances = ftcApiClient.fetchAlliances(season, eventCode);
                ctx.result(gson.toJson(alliances)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error fetching alliances: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });

        routes.get("/api/ftc/{season}/advancement/{eventCode}", ctx -> {
            int season;
            try {
                season = Integer.parseInt(ctx.pathParam("season"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid season format");
                return;
            }
            if (season < 2000 || season > 2100) {
                ctx.status(400).result("Invalid season");
                return;
            }
            String eventCode = ctx.pathParam("eventCode");
            if (eventCode == null || !eventCode.matches("^[A-Za-z0-9_-]{1,32}$")) {
                ctx.status(400).result("Invalid eventCode format");
                return;
            }

            Integer slots = null;
            String slotsParam = ctx.queryParam("slots");
            if (slotsParam != null && !slotsParam.isBlank()) {
                try {
                    int parsed = Integer.parseInt(slotsParam);
                    if (parsed > 0) {
                        slots = parsed;
                    }
                } catch (NumberFormatException ignored) {}
            }

            try {
                var advancement = ftcApiClient.fetchAdvancement(season, eventCode, slots);
                ctx.result(gson.toJson(advancement)).contentType("application/json");
            } catch (Exception e) {
                System.err.println("[FTC API Proxy] Error calculating advancement: " + e.getMessage());
                ctx.status(500).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error"))).contentType("application/json");
            }
        });
    }
}
