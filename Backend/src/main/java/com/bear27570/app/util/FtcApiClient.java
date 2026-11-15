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
            String normalizedLevel = tournamentLevel.trim().toLowerCase(Locale.ROOT).startsWith("play") ? "playoff" : "qual";
            path += "?tournamentLevel=" + normalizedLevel;
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
            if (m.has("series") && !m.get("series").isJsonNull()) {
                normMatch.addProperty("series", m.get("series").getAsInt());
            } else if (m.has("Series") && !m.get("Series").isJsonNull()) {
                normMatch.addProperty("series", m.get("Series").getAsInt());
            }
            if (m.has("description") && !m.get("description").isJsonNull()) {
                normMatch.addProperty("description", m.get("description").getAsString());
            } else if (m.has("Description") && !m.get("Description").isJsonNull()) {
                normMatch.addProperty("description", m.get("Description").getAsString());
            }

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
                if (m.has("totalTipsRed") && !m.get("totalTipsRed").isJsonNull()) {
                    redObj.addProperty("totalTips", m.get("totalTipsRed").getAsInt());
                }

                JsonObject blueObj = new JsonObject();
                blueObj.addProperty("penaltyPointsCommitted", scoreBlueFoul);
                blueObj.addProperty("totalPointsNp", blueTotalNp);
                blueObj.addProperty("finalScore", scoreBlueFinal);
                if (m.has("totalTipsBlue") && !m.get("totalTipsBlue").isJsonNull()) {
                    blueObj.addProperty("totalTips", m.get("totalTipsBlue").getAsInt());
                }

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
        String level = (tournamentLevel != null && !tournamentLevel.isBlank())
                ? (tournamentLevel.trim().toLowerCase(Locale.ROOT).startsWith("play") ? "playoff" : "qual")
                : "qual";
        String path = "/v2.0/" + season + "/scores/" + eventCode + "/" + level;
        return fetchJsonWithCache(path);
    }

    /**
     * 获取指定赛季的赛事列表
     */
    /**
     * 获取指定赛季与赛事代码的参赛战队列表，处理自动翻页，并归一化为纯净 Team 列表
     *
     * @param season    FTC 赛季年份 (如 2024, 2025)
     * @param eventCode 赛事代码 (如 CNCMPLB, TXHOU)
     * @return 归一化后的战队列表 JsonArray
     */
    public JsonArray fetchNormalizedTeams(int season, String eventCode) throws Exception {
        JsonArray allTeams = new JsonArray();
        int page = 1;
        int pageTotal = 1;

        do {
            String path = "/v2.0/" + season + "/teams?eventCode=" + eventCode + "&page=" + page;
            JsonObject rawObj = fetchJsonWithCache(path);
            if (rawObj == null || !rawObj.has("teams") || rawObj.get("teams").isJsonNull()) {
                break;
            }

            if (rawObj.has("pageTotal") && !rawObj.get("pageTotal").isJsonNull()) {
                pageTotal = rawObj.get("pageTotal").getAsInt();
            }

            JsonArray teamsArr = rawObj.getAsJsonArray("teams");
            for (JsonElement tElem : teamsArr) {
                if (!tElem.isJsonObject()) continue;
                JsonObject t = tElem.getAsJsonObject();

                int teamNum = t.has("teamNumber") && !t.get("teamNumber").isJsonNull() ? t.get("teamNumber").getAsInt() : 0;
                if (teamNum <= 0) continue;

                String nameFull = t.has("nameFull") && !t.get("nameFull").isJsonNull() ? t.get("nameFull").getAsString() : "Team " + teamNum;
                String robotName = t.has("robotName") && !t.get("robotName").isJsonNull() ? t.get("robotName").getAsString() : "";
                String city = t.has("city") && !t.get("city").isJsonNull() ? t.get("city").getAsString() : "";
                String country = t.has("country") && !t.get("country").isJsonNull() ? t.get("country").getAsString() : "";

                JsonObject normTeam = new JsonObject();
                normTeam.addProperty("teamNumber", teamNum);
                normTeam.addProperty("nameFull", nameFull);
                normTeam.addProperty("robotName", robotName);
                normTeam.addProperty("city", city);
                normTeam.addProperty("country", country);

                allTeams.add(normTeam);
            }

            page++;
        } while (page <= pageTotal && page <= 20);

        return allTeams;
    }

    /**
     * 获取指定赛季与赛事代码的队伍排名列表，并归一化为纯净 Ranking 列表
     *
     * @param season    FTC 赛季年份 (如 2024, 2025)
     * @param eventCode 赛事代码 (如 CNCMPLB, AUCMP)
     * @return 归一化后的官方排名 JsonArray
     */
    public JsonArray fetchNormalizedRankings(int season, String eventCode) throws Exception {
        if ("BIOBUZZ_SYNTHETIC".equalsIgnoreCase(eventCode) || "SYNTHETIC".equalsIgnoreCase(eventCode)) {
            return generateSyntheticBiobuzzRankings();
        }

        String path = "/v2.0/" + season + "/rankings/" + eventCode;
        JsonObject rawObj = fetchJsonWithCache(path);
        JsonArray rawRankings = null;
        if (rawObj != null) {
            if (rawObj.has("rankings") && !rawObj.get("rankings").isJsonNull() && rawObj.get("rankings").isJsonArray()) {
                rawRankings = rawObj.getAsJsonArray("rankings");
            } else if (rawObj.has("Rankings") && !rawObj.get("Rankings").isJsonNull() && rawObj.get("Rankings").isJsonArray()) {
                rawRankings = rawObj.getAsJsonArray("Rankings");
            }
        }
        if (rawRankings == null) {
            return new JsonArray();
        }

        JsonArray normalizedRankings = new JsonArray();

        for (JsonElement rElem : rawRankings) {
            if (!rElem.isJsonObject()) continue;
            JsonObject r = rElem.getAsJsonObject();

            int rank = r.has("rank") && !r.get("rank").isJsonNull() ? r.get("rank").getAsInt() : (r.has("Rank") && !r.get("Rank").isJsonNull() ? r.get("Rank").getAsInt() : 0);
            int teamNum = r.has("teamNumber") && !r.get("teamNumber").isJsonNull() ? r.get("teamNumber").getAsInt() : (r.has("TeamNumber") && !r.get("TeamNumber").isJsonNull() ? r.get("TeamNumber").getAsInt() : 0);
            if (teamNum <= 0) continue;

            JsonObject normRank = new JsonObject();
            normRank.addProperty("rank", rank);
            normRank.addProperty("teamNumber", teamNum);

            copyDoubleProperty(r, normRank, "sortOrder1", "SortOrder1");
            copyDoubleProperty(r, normRank, "sortOrder2", "SortOrder2");
            copyDoubleProperty(r, normRank, "sortOrder3", "SortOrder3");
            copyDoubleProperty(r, normRank, "sortOrder4", "SortOrder4");
            copyDoubleProperty(r, normRank, "sortOrder5", "SortOrder5");
            copyDoubleProperty(r, normRank, "sortOrder6", "SortOrder6");
            copyIntProperty(r, normRank, "wins", "Wins");
            copyIntProperty(r, normRank, "losses", "Losses");
            copyIntProperty(r, normRank, "ties", "Ties");
            copyIntProperty(r, normRank, "qualMatchesPlayed", "QualMatchesPlayed");
            copyIntProperty(r, normRank, "dq", "Dq");

            normalizedRankings.add(normRank);
        }

        return normalizedRankings;
    }

    /**
     * 获取指定赛季与赛事代码的评审与赛事奖项列表
     */
    public JsonArray fetchAwards(int season, String eventCode) throws Exception {
        if ("BIOBUZZ_SYNTHETIC".equalsIgnoreCase(eventCode) || "SYNTHETIC".equalsIgnoreCase(eventCode)) {
            return generateSyntheticBiobuzzAwards();
        }

        String path = "/v2.0/" + season + "/awards/" + eventCode;
        JsonObject rawObj = fetchJsonWithCache(path);
        JsonArray rawAwards = null;
        if (rawObj != null) {
            if (rawObj.has("awards") && !rawObj.get("awards").isJsonNull() && rawObj.get("awards").isJsonArray()) {
                rawAwards = rawObj.getAsJsonArray("awards");
            } else if (rawObj.has("Awards") && !rawObj.get("Awards").isJsonNull() && rawObj.get("Awards").isJsonArray()) {
                rawAwards = rawObj.getAsJsonArray("Awards");
            }
        }
        if (rawAwards == null) {
            return new JsonArray();
        }

        JsonArray normalizedAwards = new JsonArray();

        for (JsonElement aElem : rawAwards) {
            if (!aElem.isJsonObject()) continue;
            JsonObject a = aElem.getAsJsonObject();

            int teamNum = a.has("teamNumber") && !a.get("teamNumber").isJsonNull() ? a.get("teamNumber").getAsInt() : (a.has("TeamNumber") && !a.get("TeamNumber").isJsonNull() ? a.get("TeamNumber").getAsInt() : 0);
            String name = a.has("name") && !a.get("name").isJsonNull() ? a.get("name").getAsString() : (a.has("Name") && !a.get("Name").isJsonNull() ? a.get("Name").getAsString() : "");
            int series = a.has("series") && !a.get("series").isJsonNull() ? a.get("series").getAsInt() : (a.has("Series") && !a.get("Series").isJsonNull() ? a.get("Series").getAsInt() : 1);

            JsonObject normAward = new JsonObject();
            normAward.addProperty("teamNumber", teamNum);
            normAward.addProperty("name", name);
            normAward.addProperty("series", series);
            if (a.has("awardId")) normAward.addProperty("awardId", a.get("awardId").getAsInt());

            normalizedAwards.add(normAward);
        }

        return normalizedAwards;
    }

    /**
     * 获取指定赛季与赛事代码的选队联盟信息
     */
    public JsonArray fetchAlliances(int season, String eventCode) throws Exception {
        if ("BIOBUZZ_SYNTHETIC".equalsIgnoreCase(eventCode) || "SYNTHETIC".equalsIgnoreCase(eventCode)) {
            return generateSyntheticBiobuzzAlliances();
        }

        String path = "/v2.0/" + season + "/alliances/" + eventCode;
        JsonObject rawObj = fetchJsonWithCache(path);
        JsonArray rawAlliances = null;
        if (rawObj != null) {
            if (rawObj.has("alliances") && !rawObj.get("alliances").isJsonNull() && rawObj.get("alliances").isJsonArray()) {
                rawAlliances = rawObj.getAsJsonArray("alliances");
            } else if (rawObj.has("Alliances") && !rawObj.get("Alliances").isJsonNull() && rawObj.get("Alliances").isJsonArray()) {
                rawAlliances = rawObj.getAsJsonArray("Alliances");
            }
        }
        if (rawAlliances == null) {
            return new JsonArray();
        }

        JsonArray normalizedAlliances = new JsonArray();

        for (JsonElement el : rawAlliances) {
            if (!el.isJsonObject()) continue;
            JsonObject a = el.getAsJsonObject();

            int number = AdvancementCalculator.extractTeamNumber(a, "number", "Number");
            int captain = AdvancementCalculator.extractTeamNumber(a, "captain", "Captain");
            int round1 = AdvancementCalculator.extractTeamNumber(a, "round1", "Round1");
            int round2 = AdvancementCalculator.extractTeamNumber(a, "round2", "Round2");
            int round3 = AdvancementCalculator.extractTeamNumber(a, "round3", "Round3");
            int backup = AdvancementCalculator.extractTeamNumber(a, "backup", "Backup");

            JsonObject normAlliance = new JsonObject();
            normAlliance.addProperty("number", number);
            normAlliance.addProperty("captain", captain);
            normAlliance.addProperty("round1", round1);
            if (round2 > 0) normAlliance.addProperty("round2", round2);
            if (round3 > 0) normAlliance.addProperty("round3", round3);
            if (backup > 0) normAlliance.addProperty("backup", backup);
            if (a.has("name") && !a.get("name").isJsonNull()) {
                normAlliance.addProperty("name", a.get("name").getAsString());
            } else if (a.has("Name") && !a.get("Name").isJsonNull()) {
                normAlliance.addProperty("name", a.get("Name").getAsString());
            }

            normalizedAlliances.add(normAlliance);
        }

        return normalizedAlliances;
    }

    public JsonObject fetchOfficialAdvancementRaw(int season, String eventCode) {
        if (eventCode == null || eventCode.isBlank()
                || "BIOBUZZ_SYNTHETIC".equalsIgnoreCase(eventCode)
                || "SYNTHETIC".equalsIgnoreCase(eventCode)) {
            return null;
        }
        try {
            return fetchJsonWithCache("/v2.0/" + season + "/advancement/" + eventCode);
        } catch (Exception ignored) {
            return null;
        }
    }

    /**
     * 查询 FTC 官方 /v2.0/{season}/advancement/{eventCode} 提供的赛事晋级名额 (slots)，若赛事未发布或返回 404 则回退默认 4
     */
    public int fetchOfficialAdvancementSlots(int season, String eventCode) {
        JsonObject rawAdv = fetchOfficialAdvancementRaw(season, eventCode);
        if (rawAdv != null) {
            int slots = AdvancementCalculator.extractTeamNumber(rawAdv, "slots", "Slots");
            if (slots > 0) {
                return slots;
            }
        }
        return AdvancementCalculator.DEFAULT_ADVANCEMENT_SLOTS;
    }

    /**
     * 实时汇算指定赛事全部战队的 FTC 官方标准晋级分（优先读取官方赛事 slots，回退默认 4）
     */
    public JsonArray fetchAdvancement(int season, String eventCode) throws Exception {
        return fetchAdvancement(season, eventCode, (Integer) null);
    }

    /**
     * 实时汇算指定赛事全部战队的 FTC 官方标准晋级分 (支持自定义晋级名额)
     */
    public JsonArray fetchAdvancement(int season, String eventCode, int advancementSlots) throws Exception {
        return fetchAdvancement(season, eventCode, Integer.valueOf(advancementSlots));
    }

    /**
     * 实时汇算指定赛事全部战队的 FTC 官方标准晋级分与顺延状态（当 explicitSlots 为 null 或 <= 0 时自动读取官方 slots 与晋级状态）
     */
    public JsonArray fetchAdvancement(int season, String eventCode, Integer explicitSlots) throws Exception {
        JsonArray rankings = fetchNormalizedRankings(season, eventCode);
        JsonArray alliances = fetchAlliances(season, eventCode);
        JsonArray awards = fetchAwards(season, eventCode);
        JsonArray matches = fetchNormalizedMatches(season, eventCode, null);

        JsonObject rawOfficialAdv = fetchOfficialAdvancementRaw(season, eventCode);
        boolean hasExplicitSlots = explicitSlots != null && explicitSlots > 0;
        int resolvedSlots;
        if (hasExplicitSlots) {
            resolvedSlots = explicitSlots;
        } else {
            int officialSlots = rawOfficialAdv != null
                    ? AdvancementCalculator.extractTeamNumber(rawOfficialAdv, "slots", "Slots")
                    : -1;
            resolvedSlots = officialSlots > 0 ? officialSlots : AdvancementCalculator.DEFAULT_ADVANCEMENT_SLOTS;
        }

        // 如果官方 rankings 尚未产生，但已有队伍名单，则按队伍名单构建默认 rank
        if (rankings.size() == 0) {
            JsonArray teams = fetchNormalizedTeams(season, eventCode);
            for (int i = 0; i < teams.size(); i++) {
                JsonObject t = teams.get(i).getAsJsonObject();
                JsonObject r = new JsonObject();
                r.addProperty("rank", i + 1);
                r.addProperty("teamNumber", t.get("teamNumber").getAsInt());
                rankings.add(r);
            }
        }

        return AdvancementCalculator.calculateAdvancement(
                rankings, alliances, awards, matches, resolvedSlots, rawOfficialAdv, hasExplicitSlots);
    }

    private static void copyDoubleProperty(JsonObject src, JsonObject dst, String primaryKey, String fallbackKey) {
        if (src.has(primaryKey) && !src.get(primaryKey).isJsonNull()) {
            dst.addProperty(primaryKey, src.get(primaryKey).getAsDouble());
        } else if (src.has(fallbackKey) && !src.get(fallbackKey).isJsonNull()) {
            dst.addProperty(primaryKey, src.get(fallbackKey).getAsDouble());
        }
    }

    private static void copyIntProperty(JsonObject src, JsonObject dst, String primaryKey, String fallbackKey) {
        if (src.has(primaryKey) && !src.get(primaryKey).isJsonNull()) {
            dst.addProperty(primaryKey, src.get(primaryKey).getAsInt());
        } else if (src.has(fallbackKey) && !src.get(fallbackKey).isJsonNull()) {
            dst.addProperty(primaryKey, src.get(fallbackKey).getAsInt());
        }
    }

    /**
     * 校验指定赛季下是否存在特定的 FTC 官方赛事代码
     *
     * @param season    FTC 赛季年份 (如 2024, 2025)
     * @param eventCode 赛事代码 (如 CNCMPLB, AUCMP)
     * @return 存在且有效则返回 true，否则返回 false
     */
    public boolean eventExists(int season, String eventCode) throws Exception {
        if (eventCode == null || eventCode.isBlank()) {
            return false;
        }
        String normalizedCode = eventCode.trim().toUpperCase(Locale.ROOT);
        String path = "/v2.0/" + season + "/events?eventCode=" + normalizedCode;
        JsonObject rawObj = fetchJsonWithCache(path);
        if (rawObj == null || !rawObj.has("events") || rawObj.get("events").isJsonNull()) {
            return false;
        }
        JsonArray events = rawObj.getAsJsonArray("events");
        if (events.size() == 0) {
            return false;
        }
        for (JsonElement eElem : events) {
            if (!eElem.isJsonObject()) continue;
            JsonObject eObj = eElem.getAsJsonObject();
            if (eObj.has("code") && !eObj.get("code").isJsonNull()) {
                if (normalizedCode.equalsIgnoreCase(eObj.get("code").getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }

    private JsonObject fetchJsonWithCache(String path) throws Exception {
        CacheEntry cached = cache.get(path);
        if (cached != null && !cached.isExpired()) {
            return (cached.data != null && cached.data.isJsonObject()) ? cached.data.getAsJsonObject() : new JsonObject();
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
            return (cached.data != null && cached.data.isJsonObject()) ? cached.data.getAsJsonObject() : new JsonObject();
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

    public static JsonArray generateSyntheticBiobuzzMatches() {
        JsonArray matches = new JsonArray();
        int[][] matchPairings = {
            {27570, 11115, 11260, 8644},
            {8417, 18457, 18219, 19600},
            {16461, 14295, 12808, 10011},
            {16379, 12599, 19743, 22312},
            {27570, 8417, 14295, 12599},
            {11115, 18457, 11260, 16379},
            {8644, 18219, 16461, 19743},
            {19600, 12808, 10011, 22312},
            {27570, 19600, 16379, 10011},
            {11115, 12808, 8417, 22312},
            {11260, 18219, 14295, 19743},
            {8644, 18457, 16461, 12599}
        };

        int[] redScores = {128, 98, 115, 102, 134, 110, 88, 122, 140, 118, 95, 105};
        int[] blueScores = {112, 105, 92, 118, 108, 125, 114, 85, 96, 102, 110, 115};
        int[] redTips = {4, 3, 3, 2, 5, 3, 2, 4, 5, 3, 2, 3};
        int[] blueTips = {3, 3, 2, 4, 3, 4, 3, 2, 2, 3, 3, 4};

        for (int i = 0; i < matchPairings.length; i++) {
            int matchNum = i + 1;
            JsonObject m = new JsonObject();
            m.addProperty("matchNum", matchNum);
            m.addProperty("tournamentLevel", "QUALIFICATION");

            JsonObject scoresObj = new JsonObject();
            JsonObject redObj = new JsonObject();
            redObj.addProperty("penaltyPointsCommitted", 0);
            redObj.addProperty("totalPointsNp", redScores[i]);
            redObj.addProperty("finalScore", redScores[i]);
            redObj.addProperty("totalTips", redTips[i]);

            JsonObject blueObj = new JsonObject();
            blueObj.addProperty("penaltyPointsCommitted", 0);
            blueObj.addProperty("totalPointsNp", blueScores[i]);
            blueObj.addProperty("finalScore", blueScores[i]);
            blueObj.addProperty("totalTips", blueTips[i]);

            scoresObj.add("red", redObj);
            scoresObj.add("blue", blueObj);
            m.add("scores", scoresObj);

            JsonArray teamsArr = new JsonArray();
            int[] pairing = matchPairings[i];
            addSyntheticTeam(teamsArr, pairing[0], "Red1", "Red");
            addSyntheticTeam(teamsArr, pairing[1], "Red2", "Red");
            addSyntheticTeam(teamsArr, pairing[2], "Blue1", "Blue");
            addSyntheticTeam(teamsArr, pairing[3], "Blue2", "Blue");
            m.add("teams", teamsArr);

            matches.add(m);
        }
        return matches;
    }

    private static void addSyntheticTeam(JsonArray arr, int teamNum, String station, String alliance) {
        JsonObject t = new JsonObject();
        t.addProperty("teamNumber", teamNum);
        t.addProperty("station", station);
        t.addProperty("alliance", alliance);
        t.addProperty("dq", false);
        t.addProperty("onField", true);
        arr.add(t);
    }

    public static JsonArray generateSyntheticBiobuzzTeams() {
        JsonArray teams = new JsonArray();
        int[] numbers = {
            27570, 11115, 11260, 8644, 8417, 18457, 18219, 19600,
            16461, 14295, 12808, 10011, 16379, 12599, 19743, 22312
        };
        String[] names = {
            "Titanium Bear", "Gluten Free", "Up-A-Creek Robotics", "The Brainstormers",
            "The 'Lectric Legends", "Mechanical Paradox", "Iron Bears", "Cyber Hawkeyes",
            "Infinite Turtle", "Operation T.A.C.", "RevAmped Robotics", "Thunderbots",
            "KookyBotz", "Overcharged", "BioVipers", "RoboSwarm"
        };
        String[] cities = {
            "Chengdu", "Hollis", "Longmont", "Lexington",
            "Lancaster", "Woodstock", "Highland Park", "Shanghai",
            "Beijing", "Orange", "Portland", "Bellevue",
            "San Jose", "San Diego", "Austin", "Seattle"
        };
        String[] countries = {
            "China", "USA", "USA", "USA",
            "USA", "USA", "USA", "China",
            "China", "USA", "USA", "USA",
            "USA", "USA", "USA", "USA"
        };

        for (int i = 0; i < numbers.length; i++) {
            JsonObject t = new JsonObject();
            t.addProperty("teamNumber", numbers[i]);
            t.addProperty("nameFull", names[i]);
            t.addProperty("robotName", "Robot " + numbers[i]);
            t.addProperty("city", cities[i]);
            t.addProperty("country", countries[i]);
            teams.add(t);
        }
        return teams;
    }

    public static JsonArray generateSyntheticBiobuzzRankings() {
        JsonArray rankings = new JsonArray();
        int[] numbers = {
            27570, 11115, 8417, 18457, 11260, 8644, 18219, 19600,
            16461, 14295, 12808, 10011, 16379, 12599, 19743, 22312
        };
        for (int i = 0; i < numbers.length; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("rank", i + 1);
            r.addProperty("teamNumber", numbers[i]);
            r.addProperty("sortOrder1", 2.0 - (i * 0.1));
            r.addProperty("sortOrder2", 130.0 - (i * 4));
            r.addProperty("wins", Math.max(0, 5 - (i / 3)));
            r.addProperty("losses", Math.min(5, i / 3));
            r.addProperty("ties", 0);
            r.addProperty("qualMatchesPlayed", 5);
            rankings.add(r);
        }
        return rankings;
    }

    public static JsonArray generateSyntheticBiobuzzAlliances() {
        JsonArray alliances = new JsonArray();
        int[][] seeds = {
            {1, 27570, 11115},
            {2, 8417, 18457},
            {3, 11260, 8644},
            {4, 18219, 19600}
        };
        for (int[] s : seeds) {
            JsonObject a = new JsonObject();
            a.addProperty("number", s[0]);
            a.addProperty("captain", s[1]);
            a.addProperty("round1", s[2]);
            a.addProperty("name", "Alliance " + s[0]);
            alliances.add(a);
        }
        return alliances;
    }

    public static JsonArray generateSyntheticBiobuzzAwards() {
        JsonArray awards = new JsonArray();
        // Inspire Award 1st, 2nd, 3rd
        addSyntheticAward(awards, "Inspire Award", 1, 27570);
        addSyntheticAward(awards, "Inspire Award", 2, 8417);
        addSyntheticAward(awards, "Inspire Award", 3, 11260);

        // Winning / Finalist Alliances
        addSyntheticAward(awards, "Winning Alliance Captain", 1, 27570);
        addSyntheticAward(awards, "Winning Alliance 1st Pick", 1, 11115);
        addSyntheticAward(awards, "Finalist Alliance Captain", 2, 8417);
        addSyntheticAward(awards, "Finalist Alliance 1st Pick", 2, 18457);

        // Other judged team awards
        addSyntheticAward(awards, "Think Award", 1, 18457);
        addSyntheticAward(awards, "Connect Award", 1, 8644);
        addSyntheticAward(awards, "Innovate Award", 1, 18219);
        addSyntheticAward(awards, "Design Award", 1, 19600);
        addSyntheticAward(awards, "Motivate Award", 1, 16461);
        addSyntheticAward(awards, "Control Award", 1, 14295);

        return awards;
    }

    private static void addSyntheticAward(JsonArray awards, String name, int series, int teamNum) {
        JsonObject a = new JsonObject();
        a.addProperty("name", name);
        a.addProperty("series", series);
        a.addProperty("teamNumber", teamNum);
        awards.add(a);
    }
}
