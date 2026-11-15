package com.bear27570.app.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.*;

/**
 * FTC 官方标准赛事晋级积分计算器 (FTC Official Tournament Advancement Points Calculator)
 * 严格遵循 FTC Game Manual / Competition Manual Section 4 (Advancement):
 * - Table 4-1: Advancement Point Assignment
 *   1. Qualification Phase Performance Points (2-16 pts via Inverse Error Function distribution)
 *   2. Alliance Selection Results Points (21 - Seed for Alliance Captains & 1st Picks)
 *   3. Playoff Advancement Points (Winner: 40, Finalist: 20, 3rd: 10, 4th: 5)
 *   4. Judged Team Awards (Inspire: 60/30/15, Other Judged Awards: 12/6/3)
 * - Table 4-2: Advancement Order Sort Criteria (Tiebreaker Hierarchy)
 */
public class AdvancementCalculator {

    public static final double ALPHA = 1.07;
    public static final int DEFAULT_ADVANCEMENT_SLOTS = 4;

    /**
     * Abramowitz & Stegun erf(x) approximation (Formula 7.1.26)
     */
    public static double erf(double x) {
        if (x == 0.0) return 0.0;
        double a1 = 0.254829592;
        double a2 = -0.284496736;
        double a3 = 1.421413741;
        double a4 = -1.453152027;
        double a5 = 1.061405429;
        double p = 0.3275911;

        double sign = x < 0 ? -1.0 : 1.0;
        double absX = Math.abs(x);

        double t = 1.0 / (1.0 + p * absX);
        double y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
        return sign * y;
    }

    /**
     * 高精度逆误差函数 (Inverse Error Function - invErf)
     * 使用 Winitzki 初始逼近结合 Newton-Raphson 迭代法，达到浮点机精度。
     */
    public static double invErf(double x) {
        if (Double.isNaN(x)) return Double.NaN;
        if (x <= -1.0) return Double.NEGATIVE_INFINITY;
        if (x >= 1.0) return Double.POSITIVE_INFINITY;
        if (x == 0.0) return 0.0;

        double a = 0.147;
        double log1MinusX2 = Math.log(1.0 - x * x);
        double term1 = (2.0 / (Math.PI * a)) + (log1MinusX2 / 2.0);
        double term2 = log1MinusX2 / a;
        double sign = x < 0 ? -1.0 : 1.0;

        double w = sign * Math.sqrt(Math.max(0.0, Math.sqrt(term1 * term1 - term2) - term1));

        // 2 轮 Newton-Raphson 精炼迭代
        double c = 2.0 / Math.sqrt(Math.PI);
        for (int i = 0; i < 2; i++) {
            double f = erf(w) - x;
            double fp = c * Math.exp(-w * w);
            if (fp != 0.0) {
                w = w - (f / fp);
            }
        }
        return w;
    }

    /**
     * 计算资格赛表现分 (Qualification Phase Performance Points)
     * 公式: ceil( invErf((N - 2R + 2) / (alpha * N)) * (7 / invErf(1 / alpha)) + 9 )
     * 取值范围: 2 到 16 积分 (按正态钟形分布平滑映射)
     *
     * @param rank       战队资格赛排名 (1 到 N)
     * @param totalTeams 参赛战队总数 N
     * @return 资格赛晋级积分 (2..16)
     */
    public static int calcQualPoints(int rank, int totalTeams) {
        if (totalTeams <= 0 || rank <= 0) {
            return 0;
        }
        if (totalTeams == 1) {
            return 16;
        }

        double denom = invErf(1.0 / ALPHA);
        double rawArg = (totalTeams - 2.0 * rank + 2.0) / (ALPHA * totalTeams);
        double clampedArg = Math.max(-0.999999, Math.min(0.999999, rawArg));

        double inv = invErf(clampedArg);
        int pts = (int) Math.ceil(inv * (7.0 / denom) + 9.0);
        return Math.max(2, Math.min(16, pts));
    }

    /**
     * 安全提取队伍编号：兼容平铺整数 (27570)、数字字符串 ("27570")
     * 以及 FTC Official API v2.0 嵌套对象 AllianceTeam ({"teamNumber": 23400, ...})
     */
    public static int extractTeamNumber(JsonObject obj, String... keys) {
        if (obj == null || keys == null) return 0;
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) continue;
            JsonElement el = obj.get(key);
            if (el.isJsonPrimitive()) {
                try {
                    return el.getAsInt();
                } catch (NumberFormatException ignored) {
                    try {
                        return Integer.parseInt(el.getAsString().trim());
                    } catch (NumberFormatException ignored2) {
                    }
                }
            } else if (el.isJsonObject()) {
                JsonObject nested = el.getAsJsonObject();
                int nestedNum = extractTeamNumber(nested, "teamNumber", "TeamNumber", "team", "Team");
                if (nestedNum > 0) {
                    return nestedNum;
                }
            }
        }
        return 0;
    }

    /**
     * 计算选队联盟分 (Alliance Selection Results Points)
     * Table 4-1: 联盟队长与第 1 顺位选定队伍获 21 - Alliance Number 分
     *
     * @param seed            联盟编号 (1..N，通常 1..4)
     * @param isCaptainOrPick 队长或第一顺位队伍
     * @param isSecondPick    是否为第二顺位（如适用锦标赛三机联盟）
     * @return 联盟积分
     */
    public static int calcAlliancePoints(int seed, boolean isCaptainOrPick, boolean isSecondPick) {
        return calcAlliancePoints(seed, isCaptainOrPick, isSecondPick, 4);
    }

    /**
     * 计算选队联盟分（支持任意联盟总数 N 的蛇形顺位公式）
     */
    public static int calcAlliancePoints(int seed, boolean isCaptainOrPick, boolean isSecondPick, int totalAlliances) {
        if (seed <= 0) return 0;
        if (isCaptainOrPick) {
            return Math.max(0, 21 - seed);
        }
        if (isSecondPick) {
            int n = totalAlliances > 0 ? totalAlliances : 4;
            // 第二顺位选拔分（蛇形逆序：第 N 联盟为第 N+1 顺位，第 1 联盟为第 2N 顺位）
            int draftOrder = (2 * n) - seed + 1;
            return Math.max(0, 21 - draftOrder);
        }
        return 0;
    }

    /**
     * 计算第 3 轮选秀顺位（如 4 机联队备份上场位次）联盟积分
     */
    public static int calcRound3AlliancePoints(int seed, int totalAlliances) {
        if (seed <= 0) return 0;
        int n = totalAlliances > 0 ? totalAlliances : 4;
        return Math.max(0, 21 - (2 * n + seed));
    }

    /**
     * 计算淘汰赛晋级分 (Playoff Advancement Points)
     * Table 4-1:
     * - 冠军 (Winners): 40 分
     * - 亚军 (Finalists): 20 分
     * - 季军 (3rd Place): 10 分
     * - 殿军 (4th Place): 5 分
     */
    public static int calcPlayoffPoints(String playoffResult) {
        if (playoffResult == null) return 0;
        String res = playoffResult.trim().toUpperCase(Locale.ROOT);
        if (res.contains("WIN") || res.contains("CHAMPION") || res.equals("1") || res.equals("1ST")) {
            return 40;
        }
        if ((res.contains("FINAL") && !res.contains("QUARTER") && !res.contains("SEMI")) || res.contains("RUNNER") || res.equals("2") || res.equals("2ND")) {
            return 20;
        }
        if (res.contains("3RD") || res.contains("THIRD") || res.equals("3")) {
            return 10;
        }
        if (res.contains("4TH") || res.contains("FOURTH") || res.equals("4")) {
            return 5;
        }
        return 0;
    }

    public static boolean isExcludedAwardName(String lowerName) {
        if (lowerName == null) return false;
        return lowerName.contains("dean") || lowerName.contains("compass") ||
                lowerName.contains("promote") || lowerName.contains("volunteer") || lowerName.contains("safety");
    }

    public static boolean isJudgedTeamAwardName(String lowerName) {
        if (lowerName == null) return false;
        return lowerName.contains("inspire") || lowerName.contains("启迪") ||
                lowerName.contains("think") || lowerName.contains("思考") ||
                lowerName.contains("connect") || lowerName.contains("连接") || lowerName.contains("联络") ||
                lowerName.contains("innovat") || lowerName.contains("创新") ||
                lowerName.contains("design") || lowerName.contains("设计") ||
                lowerName.contains("motivat") || lowerName.contains("激励") ||
                lowerName.contains("control") || lowerName.contains("控制") ||
                lowerName.contains("sustain") || lowerName.contains("持续") ||
                lowerName.contains("reach") || lowerName.contains("普及") || lowerName.contains("拓展") ||
                lowerName.contains("judge") || lowerName.contains("裁判");
    }

    /**
     * 计算评审团队奖项分 (Judged Team Award Points)
     * Table 4-1:
     * - 启迪奖 (Inspire Award): 1st=60, 2nd=30, 3rd=15
     * - 其他官方评审奖项 (Think, Connect, Innovate, Design, Motivate, Control, Sustain, Reach, Judges' Choice):
     *   1st=12, 2nd=6, 3rd=3
     * - 个人奖项 (Dean's List) 及非团队奖项不计分
     */
    public static int calcAwardPoints(String awardName, int series) {
        if (awardName == null) return 0;
        String name = awardName.trim().toLowerCase(Locale.ROOT);

        // 排除个人奖项与非晋级奖项
        if (isExcludedAwardName(name)) {
            return 0;
        }

        int effectiveSeries = series > 0 ? series : 1;
        if (effectiveSeries <= 1) {
            if (name.contains("2nd") || name.contains("second") || name.contains("finalist") || name.contains("第二") || name.contains("第2")) {
                effectiveSeries = 2;
            } else if (name.contains("3rd") || name.contains("third") || name.contains("第三") || name.contains("第3")) {
                effectiveSeries = 3;
            }
        }

        if (name.contains("inspire") || name.contains("启迪")) {
            if (effectiveSeries == 1) return 60;
            if (effectiveSeries == 2) return 30;
            if (effectiveSeries == 3) return 15;
            return 0;
        }

        if (isJudgedTeamAwardName(name)) {
            if (effectiveSeries == 1) return 12;
            if (effectiveSeries == 2) return 6;
            if (effectiveSeries == 3) return 3;
        }
        return 0;
    }

    /**
     * 战队实时晋级数据模型
     */
    public static class TeamAdvancementEntry {
        public int teamNumber;
        public int qualRank;
        public int advancementRank;
        public int qualPoints;
        public int alliancePoints;
        public int playoffPoints;
        public int awardPoints;
        public int totalAdvancementPoints;
        public String advancementStatus; // "ADVANCING", "BUBBLE", "COMPETING", "ALREADY_ADVANCING", "DECLINED", "INELIGIBLE"
        public String officialStatus;    // Raw FTC API status (e.g. "FIRST", "ALREADY_ADVANCING", "INELIGIBLE")
        public boolean declined;
        public boolean rolledDown;
        public int advancementSlot;
        public String advancementCriteria;
        public String advancesTo;
        public double tiebreakerSort1;   // sortOrder1 (avg match points or RP)
        public double tiebreakerSort2;   // sortOrder2 (tiebreaker 1)
        public double tiebreakerAuto;    // avg auto points
        public double tiebreakerHigh;    // high match points
    }

    /**
     * 实时汇算指定赛事全部战队的 FTC 官方晋级分与晋级状态
     *
     * @param officialRankings FTC 官方 rankings 数组
     * @param officialAlliances FTC 官方 alliances 数组
     * @param officialAwards    FTC 官方 awards 数组
     * @param officialMatches   FTC 官方 matches 数组 (包含季后赛赛果)
     * @param advancementSlots  晋级名额 (默认为 4)
     * @return 排序规整的战队晋级情况 JsonArray
     */
    public static JsonArray calculateAdvancement(
            JsonArray officialRankings,
            JsonArray officialAlliances,
            JsonArray officialAwards,
            JsonArray officialMatches,
            int advancementSlots
    ) {
        return calculateAdvancement(
                officialRankings,
                officialAlliances,
                officialAwards,
                officialMatches,
                advancementSlots,
                null,
                false
        );
    }

    /**
     * 实时汇算指定赛事全部战队的 FTC 官方晋级分、官方晋级状态及顺延结果
     *
     * @param officialRankings       FTC 官方 rankings 数组
     * @param officialAlliances      FTC 官方 alliances 数组
     * @param officialAwards         FTC 官方 awards 数组
     * @param officialMatches        FTC 官方 matches 数组 (包含季后赛赛果)
     * @param advancementSlots       晋级名额 (默认为 4)
     * @param rawOfficialAdvancement FTC 官方 /v2.0/{season}/advancement/{eventCode} 原始响应对象 (可为 null)
     * @param explicitSlotsOverride  是否由调用方显式指定了 ?slots= 参数覆盖官方名额
     * @return 排序规整的战队晋级情况 JsonArray
     */
    public static JsonArray calculateAdvancement(
            JsonArray officialRankings,
            JsonArray officialAlliances,
            JsonArray officialAwards,
            JsonArray officialMatches,
            int advancementSlots,
            JsonObject rawOfficialAdvancement,
            boolean explicitSlotsOverride
    ) {
        int slots = advancementSlots > 0 ? advancementSlots : DEFAULT_ADVANCEMENT_SLOTS;
        Map<Integer, TeamAdvancementEntry> teamMap = new LinkedHashMap<>();

        int totalTeams = (officialRankings != null) ? officialRankings.size() : 0;

        // 1. 资格赛表现分计算
        if (officialRankings != null) {
            for (JsonElement el : officialRankings) {
                if (!el.isJsonObject()) continue;
                JsonObject r = el.getAsJsonObject();
                int teamNum = r.has("teamNumber") && !r.get("teamNumber").isJsonNull() ? r.get("teamNumber").getAsInt() : 0;
                int rank = r.has("rank") && !r.get("rank").isJsonNull() ? r.get("rank").getAsInt() : 0;
                if (teamNum <= 0) continue;

                TeamAdvancementEntry entry = teamMap.computeIfAbsent(teamNum, k -> {
                    TeamAdvancementEntry e = new TeamAdvancementEntry();
                    e.teamNumber = k;
                    return e;
                });

                entry.qualRank = rank;
                entry.qualPoints = calcQualPoints(rank, totalTeams);
                if (r.has("sortOrder1") && !r.get("sortOrder1").isJsonNull()) {
                    entry.tiebreakerSort1 = r.get("sortOrder1").getAsDouble();
                }
                if (r.has("sortOrder2") && !r.get("sortOrder2").isJsonNull()) {
                    entry.tiebreakerSort2 = r.get("sortOrder2").getAsDouble();
                }
            }
        }

        // 2. 选队联盟分计算（兼容整型字段及 FTC API v2.0 AllianceTeam 嵌套对象）
        if (officialAlliances != null && officialAlliances.size() > 0) {
            int maxSeed = 0;
            for (JsonElement el : officialAlliances) {
                if (!el.isJsonObject()) continue;
                JsonObject a = el.getAsJsonObject();
                int s = extractTeamNumber(a, "number", "Number");
                if (s > maxSeed) maxSeed = s;
            }
            int totalAlliances = officialAlliances.size() >= 2
                    ? Math.max(officialAlliances.size(), maxSeed)
                    : Math.max(4, maxSeed);

            for (JsonElement el : officialAlliances) {
                if (!el.isJsonObject()) continue;
                JsonObject a = el.getAsJsonObject();
                int seed = extractTeamNumber(a, "number", "Number");
                int captain = extractTeamNumber(a, "captain", "Captain");
                int round1 = extractTeamNumber(a, "round1", "Round1");
                int round2 = extractTeamNumber(a, "round2", "Round2");
                int round3 = extractTeamNumber(a, "round3", "Round3");

                if (captain > 0) {
                    TeamAdvancementEntry cEntry = teamMap.computeIfAbsent(captain, k -> {
                        TeamAdvancementEntry e = new TeamAdvancementEntry();
                        e.teamNumber = k;
                        return e;
                    });
                    cEntry.alliancePoints = calcAlliancePoints(seed, true, false, totalAlliances);
                }
                if (round1 > 0) {
                    TeamAdvancementEntry r1Entry = teamMap.computeIfAbsent(round1, k -> {
                        TeamAdvancementEntry e = new TeamAdvancementEntry();
                        e.teamNumber = k;
                        return e;
                    });
                    r1Entry.alliancePoints = calcAlliancePoints(seed, true, false, totalAlliances);
                }
                if (round2 > 0) {
                    TeamAdvancementEntry r2Entry = teamMap.computeIfAbsent(round2, k -> {
                        TeamAdvancementEntry e = new TeamAdvancementEntry();
                        e.teamNumber = k;
                        return e;
                    });
                    r2Entry.alliancePoints = calcAlliancePoints(seed, false, true, totalAlliances);
                }
                if (round3 > 0) {
                    TeamAdvancementEntry r3Entry = teamMap.computeIfAbsent(round3, k -> {
                        TeamAdvancementEntry e = new TeamAdvancementEntry();
                        e.teamNumber = k;
                        return e;
                    });
                    r3Entry.alliancePoints = calcRound3AlliancePoints(seed, totalAlliances);
                }
            }
        }

        // 3. 淘汰赛晋级分计算 (结合 officialAwards 与 officialMatches)
        Set<Integer> officialWinnerTeams = new HashSet<>();
        Set<Integer> officialFinalistTeams = new HashSet<>();
        Set<Integer> official3rdPlaceTeams = new HashSet<>();
        Set<Integer> official4thPlaceTeams = new HashSet<>();

        // 优先检查 awards 中的淘汰赛联盟奖项
        if (officialAwards != null) {
            for (JsonElement el : officialAwards) {
                if (!el.isJsonObject()) continue;
                JsonObject aw = el.getAsJsonObject();
                int teamNum = aw.has("teamNumber") && !aw.get("teamNumber").isJsonNull() ? aw.get("teamNumber").getAsInt() : 0;
                String name = aw.has("name") && !aw.get("name").isJsonNull() ? aw.get("name").getAsString() : "";
                if (teamNum <= 0) continue;

                String lowerName = name.toLowerCase(Locale.ROOT);
                // 排除个人奖项与导师/志愿者奖项，及所有评审团队奖项
                if (isExcludedAwardName(lowerName) || isJudgedTeamAwardName(lowerName)) continue;

                if (lowerName.contains("winning alliance") || lowerName.contains("获胜联盟") || lowerName.contains("冠军联盟") || lowerName.contains("优胜联盟") ||
                        (!lowerName.contains("semi") && !lowerName.contains("quarter") && (lowerName.contains("champion") || lowerName.contains("winner")))) {
                    officialWinnerTeams.add(teamNum);
                } else if (lowerName.contains("finalist alliance") || lowerName.contains("决赛联盟") || lowerName.contains("亚军联盟") ||
                        (!lowerName.contains("semi") && !lowerName.contains("quarter") && (lowerName.contains("finalist") || lowerName.contains("runner")))) {
                    officialFinalistTeams.add(teamNum);
                } else if (lowerName.contains("3rd") || lowerName.contains("third") || lowerName.contains("季军")) {
                    official3rdPlaceTeams.add(teamNum);
                } else if (lowerName.contains("4th") || lowerName.contains("fourth") || lowerName.contains("殿军")) {
                    official4thPlaceTeams.add(teamNum);
                }
            }
        }

        // 从 playoff 场次结果聚合 Finals 与 Semifinals/双败淘汰赛 战绩
        boolean isDoubleElim = false;
        Set<Integer> finalsTeams = new HashSet<>();
        Map<Integer, Integer> finalsWins = new HashMap<>();
        Set<Integer> semifinalTeams = new HashSet<>();
        Map<Integer, Integer> semifinalWins = new HashMap<>();
        Map<Integer, Integer> nonFinalMaxSeries = new HashMap<>();

        if (officialMatches != null) {
            for (JsonElement el : officialMatches) {
                if (!el.isJsonObject()) continue;
                JsonObject m = el.getAsJsonObject();
                String level = m.has("tournamentLevel") && !m.get("tournamentLevel").isJsonNull() ? m.get("tournamentLevel").getAsString() : "";
                if (!level.equalsIgnoreCase("PLAYOFF")) continue;

                if (!m.has("scores") || m.get("scores").isJsonNull() || !m.has("teams") || !m.get("teams").isJsonArray()) {
                    continue;
                }
                JsonObject scores = m.getAsJsonObject("scores");
                JsonObject red = scores.has("red") && scores.get("red").isJsonObject() ? scores.getAsJsonObject("red") : null;
                JsonObject blue = scores.has("blue") && scores.get("blue").isJsonObject() ? scores.getAsJsonObject("blue") : null;
                if (red == null || blue == null) continue;

                int redScore = red.has("finalScore") && !red.get("finalScore").isJsonNull() ? red.get("finalScore").getAsInt() : (red.has("totalPointsNp") && !red.get("totalPointsNp").isJsonNull() ? red.get("totalPointsNp").getAsInt() : 0);
                int blueScore = blue.has("finalScore") && !blue.get("finalScore").isJsonNull() ? blue.get("finalScore").getAsInt() : (blue.has("totalPointsNp") && !blue.get("totalPointsNp").isJsonNull() ? blue.get("totalPointsNp").getAsInt() : 0);

                String winningAlliance = redScore > blueScore ? "Red" : (blueScore > redScore ? "Blue" : "Tie");
                int matchNum = m.has("matchNum") ? m.get("matchNum").getAsInt() : 0;
                int series = m.has("series") && !m.get("series").isJsonNull() ? m.get("series").getAsInt() : 0;
                String desc = m.has("description") && !m.get("description").isJsonNull() ? m.get("description").getAsString().toLowerCase(Locale.ROOT) : "";
                if (desc.contains("upper bracket") || desc.contains("lower bracket") || desc.contains("final bracket")) {
                    isDoubleElim = true;
                }
                boolean isFinals = !desc.isEmpty()
                        ? (!desc.contains("upper bracket") && !desc.contains("lower bracket") && !desc.contains("semi") && !desc.contains("quarter") && desc.contains("final"))
                        : (series == 3 || (series == 0 && matchNum >= 5));

                boolean matchCompleted = (redScore > 0 || blueScore > 0) && !winningAlliance.equals("Tie");
                int bracketStep = series > 0 ? series : matchNum;

                for (JsonElement tEl : m.getAsJsonArray("teams")) {
                    if (!tEl.isJsonObject()) continue;
                    JsonObject t = tEl.getAsJsonObject();
                    int tNum = t.has("teamNumber") ? t.get("teamNumber").getAsInt() : 0;
                    String alliance = t.has("alliance") ? t.get("alliance").getAsString() : "";
                    if (tNum <= 0) continue;

                    boolean won = alliance.equalsIgnoreCase(winningAlliance);
                    if (isFinals) {
                        finalsTeams.add(tNum);
                        if (matchCompleted && won) {
                            finalsWins.put(tNum, finalsWins.getOrDefault(tNum, 0) + 1);
                        }
                    } else {
                        semifinalTeams.add(tNum);
                        nonFinalMaxSeries.merge(tNum, bracketStep, Math::max);
                        if (matchCompleted && won) {
                            semifinalWins.put(tNum, semifinalWins.getOrDefault(tNum, 0) + 1);
                        }
                    }
                }
            }
        }

        Map<Integer, Integer> teamPlayoffPts = new HashMap<>();

        // 1. 确定 Finals 队伍分值 (40 分冠军 / 20 分亚军)
        for (int tNum : officialWinnerTeams) {
            teamPlayoffPts.put(tNum, 40);
        }
        for (int tNum : officialFinalistTeams) {
            teamPlayoffPts.put(tNum, 20);
        }

        if (!finalsTeams.isEmpty()) {
            int maxWins = 0;
            for (int tNum : finalsTeams) {
                maxWins = Math.max(maxWins, finalsWins.getOrDefault(tNum, 0));
            }

            boolean hasDecisiveWinner = false;
            if (maxWins > 0) {
                for (int other : finalsTeams) {
                    if (finalsWins.getOrDefault(other, 0) < maxWins) {
                        hasDecisiveWinner = true;
                        break;
                    }
                }
            }

            for (int tNum : finalsTeams) {
                if (officialWinnerTeams.contains(tNum)) {
                    teamPlayoffPts.put(tNum, 40);
                } else if (officialFinalistTeams.contains(tNum)) {
                    teamPlayoffPts.put(tNum, 20);
                } else if (hasDecisiveWinner && finalsWins.getOrDefault(tNum, 0) == maxWins) {
                    teamPlayoffPts.put(tNum, 40);
                } else {
                    teamPlayoffPts.put(tNum, 20);
                }
            }
        }

        // 2. 确定 Semifinals / 双败非决赛队伍分值 (未进入 Finals 的淘汰赛战队)
        List<Integer> distinctLowerSeries = Collections.emptyList();
        if (isDoubleElim && !finalsTeams.isEmpty()) {
            Set<Integer> eliminatedSeriesSet = new HashSet<>();
            for (int tNum : semifinalTeams) {
                if (!finalsTeams.contains(tNum) && !officialWinnerTeams.contains(tNum) && !officialFinalistTeams.contains(tNum)) {
                    eliminatedSeriesSet.add(nonFinalMaxSeries.getOrDefault(tNum, 0));
                }
            }
            distinctLowerSeries = new ArrayList<>(eliminatedSeriesSet);
            distinctLowerSeries.sort(Comparator.reverseOrder());
        }

        for (int tNum : semifinalTeams) {
            if (finalsTeams.contains(tNum) || officialWinnerTeams.contains(tNum) || officialFinalistTeams.contains(tNum)) {
                continue;
            }

            if (official3rdPlaceTeams.contains(tNum)) {
                teamPlayoffPts.put(tNum, 10);
            } else if (official4thPlaceTeams.contains(tNum)) {
                teamPlayoffPts.put(tNum, 5);
            } else if (finalsTeams.isEmpty()) {
                // Finals 尚未开赛/未排定时，半决赛/胜者组优胜方暂定 20 分候选，负方 5 分
                int sfWins = semifinalWins.getOrDefault(tNum, 0);
                teamPlayoffPts.put(tNum, sfWins > 0 ? 20 : 5);
            } else if (isDoubleElim && distinctLowerSeries.size() >= 2) {
                // 双败淘汰制按最高晋级轮次判定：败者组决赛落败=3rd(10分)，败者组半决赛落败=4th(5分)，更早淘汰=0分
                int maxStep = nonFinalMaxSeries.getOrDefault(tNum, 0);
                int tierIndex = distinctLowerSeries.indexOf(maxStep);
                if (tierIndex == 0) {
                    teamPlayoffPts.put(tNum, 10);
                } else if (tierIndex == 1) {
                    teamPlayoffPts.put(tNum, 5);
                }
            } else {
                // 单败/BO3 半决赛或兜底：胜场多者 10 分，否则 5 分
                int sfWins = semifinalWins.getOrDefault(tNum, 0);
                teamPlayoffPts.put(tNum, sfWins > 0 ? 10 : 5);
            }
        }

        // 3. 补齐官方 3rd / 4th 奖项队伍
        for (int tNum : official3rdPlaceTeams) {
            teamPlayoffPts.putIfAbsent(tNum, 10);
        }
        for (int tNum : official4thPlaceTeams) {
            teamPlayoffPts.putIfAbsent(tNum, 5);
        }

        for (Map.Entry<Integer, Integer> pEntry : teamPlayoffPts.entrySet()) {
            TeamAdvancementEntry e = teamMap.computeIfAbsent(pEntry.getKey(), k -> {
                TeamAdvancementEntry n = new TeamAdvancementEntry();
                n.teamNumber = k;
                return n;
            });
            e.playoffPoints = pEntry.getValue();
        }

        // 4. 评审奖项分计算
        if (officialAwards != null) {
            for (JsonElement el : officialAwards) {
                if (!el.isJsonObject()) continue;
                JsonObject aw = el.getAsJsonObject();
                int teamNum = aw.has("teamNumber") && !aw.get("teamNumber").isJsonNull() ? aw.get("teamNumber").getAsInt() : 0;
                String name = aw.has("name") && !aw.get("name").isJsonNull() ? aw.get("name").getAsString() : "";
                int series = aw.has("series") && !aw.get("series").isJsonNull() ? aw.get("series").getAsInt() : 1;
                if (teamNum <= 0) continue;

                int awardPts = calcAwardPoints(name, series);
                if (awardPts > 0) {
                    TeamAdvancementEntry e = teamMap.computeIfAbsent(teamNum, k -> {
                        TeamAdvancementEntry n = new TeamAdvancementEntry();
                        n.teamNumber = k;
                        return n;
                    });
                    // 依据 FTC Rule A215，单支队伍在单场赛事中仅可计入一项最高评审奖项积分
                    e.awardPoints = Math.max(e.awardPoints, awardPts);
                }
            }
        }

        // 5. 汇算总分并按 Table 4-2 规则排序
        List<TeamAdvancementEntry> entries = new ArrayList<>(teamMap.values());
        for (TeamAdvancementEntry e : entries) {
            e.totalAdvancementPoints = e.qualPoints + e.alliancePoints + e.playoffPoints + e.awardPoints;
        }

        entries.sort((a, b) -> {
            // 1. 总晋级分降序 (Total Advancement Points)
            if (a.totalAdvancementPoints != b.totalAdvancementPoints) {
                return Integer.compare(b.totalAdvancementPoints, a.totalAdvancementPoints);
            }
            // 2. 评审奖项分降序 (Judged Team Award Points)
            if (a.awardPoints != b.awardPoints) {
                return Integer.compare(b.awardPoints, a.awardPoints);
            }
            // 3. 淘汰赛表现分降序 (Playoff Advancement Points)
            if (a.playoffPoints != b.playoffPoints) {
                return Integer.compare(b.playoffPoints, a.playoffPoints);
            }
            // 4. 选队结果分降序 (Alliance Selection Results Points)
            if (a.alliancePoints != b.alliancePoints) {
                return Integer.compare(b.alliancePoints, a.alliancePoints);
            }
            // 5. 资格赛表现分降序 (Qualification Phase Performance Points)
            if (a.qualPoints != b.qualPoints) {
                return Integer.compare(b.qualPoints, a.qualPoints);
            }
            // 6. 平均比赛得分 (sortOrder1)
            if (Double.compare(a.tiebreakerSort1, b.tiebreakerSort1) != 0) {
                return Double.compare(b.tiebreakerSort1, a.tiebreakerSort1);
            }
            // 7. Tiebreaker 2 (sortOrder2)
            if (Double.compare(a.tiebreakerSort2, b.tiebreakerSort2) != 0) {
                return Double.compare(b.tiebreakerSort2, a.tiebreakerSort2);
            }
            // 兜底：战队编号升序
            return Integer.compare(a.teamNumber, b.teamNumber);
        });

        // 6. 结合 FTC 官方晋级列表与顺延状态确定最终晋级排名和状态，并生成 JSON 数组
        applyAdvancementStatuses(entries, slots, rawOfficialAdvancement, explicitSlotsOverride);

        JsonArray result = new JsonArray();
        for (TeamAdvancementEntry e : entries) {
            JsonObject obj = new JsonObject();
            obj.addProperty("teamNumber", e.teamNumber);
            obj.addProperty("advancementRank", e.advancementRank);
            obj.addProperty("totalAdvancementPoints", e.totalAdvancementPoints);
            obj.addProperty("qualRank", e.qualRank);
            obj.addProperty("qualPoints", e.qualPoints);
            obj.addProperty("alliancePoints", e.alliancePoints);
            obj.addProperty("playoffPoints", e.playoffPoints);
            obj.addProperty("awardPoints", e.awardPoints);
            obj.addProperty("advancementStatus", e.advancementStatus);
            obj.addProperty("rolledDown", e.rolledDown);
            if (e.declined) {
                obj.addProperty("declined", true);
            }
            if (e.officialStatus != null && !e.officialStatus.isEmpty()) {
                obj.addProperty("officialStatus", e.officialStatus);
            }
            if (e.advancementSlot > 0) {
                obj.addProperty("advancementSlot", e.advancementSlot);
            }
            if (e.advancementCriteria != null && !e.advancementCriteria.isEmpty()) {
                obj.addProperty("advancementCriteria", e.advancementCriteria);
            }
            if (e.advancesTo != null && !e.advancesTo.isEmpty()) {
                obj.addProperty("advancesTo", e.advancesTo);
            }

            JsonObject breakdown = new JsonObject();
            breakdown.addProperty("qualPoints", e.qualPoints);
            breakdown.addProperty("alliancePoints", e.alliancePoints);
            breakdown.addProperty("playoffPoints", e.playoffPoints);
            breakdown.addProperty("awardPoints", e.awardPoints);
            obj.add("breakdown", breakdown);

            result.add(obj);
        }

        return result;
    }

    private static class OfficialSlotInfo {
        int slot;
        String criteria;
        boolean declined;
        String rawStatus;

        boolean isSkipped() {
            return declined
                    || "ALREADY_ADVANCING".equals(rawStatus)
                    || "INELIGIBLE".equals(rawStatus);
        }

        String effectiveSkippedStatus() {
            if ("ALREADY_ADVANCING".equals(rawStatus)) {
                return "ALREADY_ADVANCING";
            }
            if ("INELIGIBLE".equals(rawStatus)) {
                return "INELIGIBLE";
            }
            return declined ? "DECLINED" : "";
        }

        boolean isActiveFirst() {
            return !isSkipped() && "FIRST".equals(rawStatus);
        }
    }

    private static String extractString(JsonObject obj, String... keys) {
        if (obj == null || keys == null) return "";
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) continue;
            JsonElement el = obj.get(key);
            if (el.isJsonPrimitive()) {
                return el.getAsString().trim();
            }
        }
        return "";
    }

    private static boolean extractBoolean(JsonObject obj, String... keys) {
        if (obj == null || keys == null) return false;
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) continue;
            JsonElement el = obj.get(key);
            if (el.isJsonPrimitive()) {
                if (el.getAsJsonPrimitive().isBoolean()) {
                    return el.getAsBoolean();
                }
                return "true".equalsIgnoreCase(el.getAsString().trim());
            }
        }
        return false;
    }

    private static void applyAdvancementStatuses(
            List<TeamAdvancementEntry> entries,
            int slots,
            JsonObject rawOfficialAdvancement,
            boolean explicitSlotsOverride
    ) {
        String advancesTo = extractString(rawOfficialAdvancement, "advancesTo", "AdvancesTo");
        Map<Integer, OfficialSlotInfo> officialSlotMap = new HashMap<>();

        if (rawOfficialAdvancement != null) {
            JsonArray advArr = null;
            if (rawOfficialAdvancement.has("advancement") && rawOfficialAdvancement.get("advancement").isJsonArray()) {
                advArr = rawOfficialAdvancement.getAsJsonArray("advancement");
            } else if (rawOfficialAdvancement.has("Advancement") && rawOfficialAdvancement.get("Advancement").isJsonArray()) {
                advArr = rawOfficialAdvancement.getAsJsonArray("Advancement");
            }

            if (advArr != null) {
                for (JsonElement el : advArr) {
                    if (!el.isJsonObject()) continue;
                    JsonObject slotObj = el.getAsJsonObject();
                    int teamNum = extractTeamNumber(slotObj, "team", "teamNumber", "displayTeam", "Team", "TeamNumber");
                    if (teamNum <= 0) continue;

                    OfficialSlotInfo info = new OfficialSlotInfo();
                    info.slot = extractTeamNumber(slotObj, "slot", "Slot");
                    info.criteria = extractString(slotObj, "criteria", "Criteria");
                    info.declined = extractBoolean(slotObj, "declined", "Declined");
                    String st = extractString(slotObj, "status", "Status").toUpperCase(Locale.ROOT);
                    if ("ALREADY_ADVANCED".equals(st)) {
                        st = "ALREADY_ADVANCING";
                    }
                    info.rawStatus = st;
                    // Keep first (highest-priority) slot entry if a team appears more than once (e.g. FIRST then ADVANCING_ABOVE)
                    officialSlotMap.putIfAbsent(teamNum, info);
                }
            }
        }

        int officialFirstCount = 0;
        for (OfficialSlotInfo info : officialSlotMap.values()) {
            if (info.isActiveFirst()) {
                officialFirstCount++;
            }
        }

        Set<Integer> skippedTeams = new HashSet<>();
        for (int i = 0; i < entries.size(); i++) {
            TeamAdvancementEntry e = entries.get(i);
            e.advancementRank = i + 1;
            e.rolledDown = false;
            if (!advancesTo.isEmpty()) {
                e.advancesTo = advancesTo;
            }
            OfficialSlotInfo info = officialSlotMap.get(e.teamNumber);
            if (info != null) {
                e.declined = info.declined;
                e.advancementSlot = info.slot;
                e.advancementCriteria = info.criteria;
                e.officialStatus = !info.rawStatus.isEmpty()
                        ? info.rawStatus
                        : (info.declined ? "DECLINED" : null);
                if (info.isSkipped()) {
                    e.advancementStatus = info.effectiveSkippedStatus();
                    skippedTeams.add(e.teamNumber);
                }
            }
        }

        int activeAssigned = 0;
        if (!explicitSlotsOverride && officialFirstCount > 0) {
            for (TeamAdvancementEntry e : entries) {
                if (skippedTeams.contains(e.teamNumber)) continue;
                OfficialSlotInfo info = officialSlotMap.get(e.teamNumber);
                if (info != null && info.isActiveFirst() && activeAssigned < slots) {
                    e.advancementStatus = "ADVANCING";
                    e.rolledDown = (e.advancementSlot > slots) || (e.advancementRank > slots);
                    activeAssigned++;
                }
            }
        }

        // Fill remaining advancement slots in points order (covers in-progress events, ?slots= overrides, or skipped-only payloads)
        for (TeamAdvancementEntry e : entries) {
            if (activeAssigned >= slots) break;
            if (skippedTeams.contains(e.teamNumber) || "ADVANCING".equals(e.advancementStatus)) continue;
            e.advancementStatus = "ADVANCING";
            e.rolledDown = (e.advancementSlot > slots) || (e.advancementRank > slots);
            activeAssigned++;
        }

        int bubbleCount = 0;
        for (TeamAdvancementEntry e : entries) {
            if (skippedTeams.contains(e.teamNumber) || "ADVANCING".equals(e.advancementStatus)) continue;
            if (bubbleCount < 2) {
                e.advancementStatus = "BUBBLE";
                bubbleCount++;
            } else {
                e.advancementStatus = "COMPETING";
            }
        }
    }
}
