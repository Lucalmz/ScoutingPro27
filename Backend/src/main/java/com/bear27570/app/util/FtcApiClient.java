package com.bear27570.app.util;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * FTC 官方 API 客户端 (v2.0)
 * 提供 Basic Auth 鉴权、内存 TTL 缓存与 304 协商缓存保护，并将官方数据格式归一化为应用内部模型。
 */
public class FtcApiClient {

    private static final String DEFAULT_BASE_URL = "https://ftc-api.firstinspires.org";
    private static final String DEFAULT_USER = "bear27570";
    private static final String DEFAULT_TOKEN = "BC8EEC78-7003-4890-871E-D1736F0F3F95";
    private static final long CACHE_TTL_MS = 45_000L; // 45 秒内存缓存，避免赛场高频轮询触发速率限制

    private final String baseUrl;
    private final String basicAuthHeader;
    private final HttpClient httpClient;
    private final Gson gson = new Gson();

    private static class CacheEntry {
        final long expiresAt;
        final String lastModified;
        final String etag;
        final JsonElement data;

        CacheEntry(long ttlMs, String lastModified, String etag, JsonElement data) {
            this.expiresAt = System.currentTimeMillis() + ttlMs;
            this.lastModified = lastModified;
            this.etag = etag;
            this.data = data;
        }

        boolean isExpired() {
            return System.currentTimeMillis() > expiresAt;
        }
    }

    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public FtcApiClient() {
        this(resolveBaseUrl(), resolveUser(), resolveToken());
    }

    public FtcApiClient(String baseUrl, String user, String token) {
        this.baseUrl = (baseUrl != null && !baseUrl.isBlank()) ? baseUrl.replaceAll("/+$", "") : DEFAULT_BASE_URL;
        String resolvedUser = (user != null && !user.isBlank()) ? user : DEFAULT_USER;
        String resolvedToken = (token != null && !token.isBlank()) ? token : DEFAULT_TOKEN;
        String userToken = resolvedUser + ":" + resolvedToken;
        this.basicAuthHeader = "Basic " + Base64.getEncoder().encodeToString(userToken.getBytes(StandardCharsets.UTF_8));
        this.httpClient = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.ALWAYS)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    private static String resolveBaseUrl() {
        String env = System.getenv("FTC_API_BASE_URL");
        if (env != null && !env.isBlank()) return env;
        return System.getProperty("ftc.api.base.url", DEFAULT_BASE_URL);
    }

    private static String resolveUser() {
        String env = System.getenv("FTC_API_USER");
        if (env != null && !env.isBlank()) return env;
        return System.getProperty("ftc.api.user", DEFAULT_USER);
    }

    private static String resolveToken() {
        String env = System.getenv("FTC_API_TOKEN");
        if (env != null && !env.isBlank()) return env;
        return System.getProperty("ftc.api.token", DEFAULT_TOKEN);
    }

    /**
     * 获取指定赛季与赛事代码的比赛结果列表，并转换为规整的 OfficialMatch 列表
     *
     * @param season          FTC 赛季年份 (如 2024, 2025)
     * @param eventCode       赛事代码 (如 CNCMPLB, AUCMP)
     * @param tournamentLevel 可选赛程级别 (如 qual, qualification, playoff)
     * @return 归一化后的比赛列表 JsonArray
     */
    public JsonArray fetchNormalizedMatches(int season, String eventCode, String tournamentLevel) throws Exception {
        String path = "/v2.0/" + season + "/matches/" + eventCode;
        if (tournamentLevel != null && !tournamentLevel.isBlank()) {
            path += "?tournamentLevel=" + tournamentLevel;
        }

        JsonObject rawObj = fetchJsonWithCache(path);
        if (rawObj == null || !rawObj.has("matches") || rawObj.get("matches").isJsonNull()) {
            return new JsonArray();
        }

        JsonArray rawMatches = rawObj.getAsJsonArray("matches");
        JsonArray normalizedMatches = new JsonArray();

        for (JsonElement mElem : rawMatches) {
            if (!mElem.isJsonObject()) continue;
            JsonObject m = mElem.getAsJsonObject();

            int matchNum = m.has("matchNumber") && !m.get("matchNumber").isJsonNull() ? m.get("matchNumber").getAsInt() : 0;
            String level = m.has("tournamentLevel") && !m.get("tournamentLevel").isJsonNull() ? m.get("tournamentLevel").getAsString() : "QUALIFICATION";

            // 罚分计算与净得分映射 (Penalty Scoring Nuance):
            // scoreRedFinal: 红方最终总得分（包含蓝方犯规送给红方的加分）
            // scoreBlueFinal: 蓝方最终总得分（包含红方犯规送给蓝方的加分）
            // scoreRedFoul: 红方犯规失分 / 送给蓝方的加分 (Red foul points committed)
            // scoreBlueFoul: 蓝方犯规失分 / 送给红方的加分 (Blue foul points committed)
            //
            // 红队净得分 totalPointsNp = scoreRedFinal - scoreBlueFoul (扣除对方送的犯规分)
            // 蓝队净得分 totalPointsNp = scoreBlueFinal - scoreRedFoul (扣除对方送的犯规分)
            // 红队犯规扣分 penaltyPointsCommitted = scoreRedFoul
            // 蓝队犯规扣分 penaltyPointsCommitted = scoreBlueFoul

            JsonObject normMatch = new JsonObject();
            normMatch.addProperty("matchNum", matchNum);
            normMatch.addProperty("tournamentLevel", level);

            boolean hasScores = m.has("scoreRedFinal") && !m.get("scoreRedFinal").isJsonNull();
            if (hasScores) {
                int scoreRedFinal = m.get("scoreRedFinal").getAsInt();
                int scoreRedFoul = m.has("scoreRedFoul") && !m.get("scoreRedFoul").isJsonNull() ? m.get("scoreRedFoul").getAsInt() : 0;
                int scoreBlueFinal = m.has("scoreBlueFinal") && !m.get("scoreBlueFinal").isJsonNull() ? m.get("scoreBlueFinal").getAsInt() : 0;
                int scoreBlueFoul = m.has("scoreBlueFoul") && !m.get("scoreBlueFoul").isJsonNull() ? m.get("scoreBlueFoul").getAsInt() : 0;

                int redTotalNp = Math.max(0, scoreRedFinal - scoreBlueFoul);
                int blueTotalNp = Math.max(0, scoreBlueFinal - scoreRedFoul);

                JsonObject scoresObj = new JsonObject();
                JsonObject redObj = new JsonObject();
                redObj.addProperty("penaltyPointsCommitted", scoreRedFoul);
                redObj.addProperty("totalPointsNp", redTotalNp);
                redObj.addProperty("finalScore", scoreRedFinal);

                JsonObject blueObj = new JsonObject();
                blueObj.addProperty("penaltyPointsCommitted", scoreBlueFoul);
                blueObj.addProperty("totalPointsNp", blueTotalNp);
                blueObj.addProperty("finalScore", scoreBlueFinal);

                scoresObj.add("red", redObj);
                scoresObj.add("blue", blueObj);
                normMatch.add("scores", scoresObj);
            } else {
                normMatch.add("scores", null);
            }

            JsonArray teamsArr = new JsonArray();
            if (m.has("teams") && m.get("teams").isJsonArray()) {
                for (JsonElement tElem : m.getAsJsonArray("teams")) {
                    if (!tElem.isJsonObject()) continue;
                    JsonObject t = tElem.getAsJsonObject();
                    int teamNum = t.has("teamNumber") && !t.get("teamNumber").isJsonNull() ? t.get("teamNumber").getAsInt() : 0;
                    String station = t.has("station") && !t.get("station").isJsonNull() ? t.get("station").getAsString() : "";
                    String alliance = (station.toLowerCase().startsWith("red")) ? "Red" : "Blue";

                    JsonObject teamObj = new JsonObject();
                    teamObj.addProperty("teamNumber", teamNum);
                    teamObj.addProperty("alliance", alliance);
                    if (t.has("dq")) teamObj.addProperty("dq", t.get("dq").getAsBoolean());
                    if (t.has("onField")) teamObj.addProperty("onField", t.get("onField").getAsBoolean());
                    teamsArr.add(teamObj);
                }
            }
            normMatch.add("teams", teamsArr);

            normalizedMatches.add(normMatch);
        }

        return normalizedMatches;
    }

    /**
     * 获取详细小分 (Score Breakdown)，预留用于 Auto/TeleOp/Endgame 细分项深度对账
     */
    public JsonObject fetchScoreBreakdown(int season, String eventCode, String tournamentLevel) throws Exception {
        String level = (tournamentLevel != null && !tournamentLevel.isBlank()) ? tournamentLevel : "qual";
        String path = "/v2.0/" + season + "/scores/" + eventCode + "/" + level;
        return fetchJsonWithCache(path);
    }

    /**
     * 获取指定赛季的赛事列表
     */
    public JsonObject fetchEvents(int season) throws Exception {
        String path = "/v2.0/" + season + "/events";
        return fetchJsonWithCache(path);
    }

    private JsonObject fetchJsonWithCache(String path) throws Exception {
        CacheEntry cached = cache.get(path);
        if (cached != null && !cached.isExpired()) {
            return cached.data.getAsJsonObject();
        }

        HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", basicAuthHeader)
                .header("Accept", "application/json")
                .timeout(Duration.ofSeconds(12))
                .GET();

        if (cached != null) {
            if (cached.etag != null && !cached.etag.isBlank()) {
                reqBuilder.header("If-None-Match", cached.etag);
            }
            if (cached.lastModified != null && !cached.lastModified.isBlank()) {
                reqBuilder.header("If-Modified-Since", cached.lastModified);
            }
        }

        HttpResponse<String> response = httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() == 304 && cached != null) {
            // 304 Not Modified: 刷新缓存有效期并返回
            cache.put(path, new CacheEntry(CACHE_TTL_MS, cached.lastModified, cached.etag, cached.data));
            return cached.data.getAsJsonObject();
        }

        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            String body = response.body();
            JsonElement parsed = JsonParser.parseString(body != null && !body.isBlank() ? body : "{}");
            String lastModified = response.headers().firstValue("Last-Modified").orElse(null);
            String etag = response.headers().firstValue("ETag").orElse(null);

            cache.put(path, new CacheEntry(CACHE_TTL_MS, lastModified, etag, parsed));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        }

        if (response.statusCode() == 404) {
            return new JsonObject();
        }

        throw new RuntimeException("FTC API request failed [" + response.statusCode() + "]: " + response.body());
    }

    public void clearCache() {
        cache.clear();
    }
}
