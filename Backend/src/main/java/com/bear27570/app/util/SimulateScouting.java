package com.bear27570.app.util;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.db.JdbiConfig;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.mindrot.jbcrypt.BCrypt;

import java.util.*;

public class SimulateScouting {

    public static void main(String[] args) {
        String eventCode = "BIOBUZZ26";
        int seasonYear = 2026;
        boolean forceProduction = false;

        for (String arg : args) {
            String trimmed = arg.trim();
            if ("--force-production".equalsIgnoreCase(trimmed) ||
                "--force-production-i-know-what-i-am-doing".equalsIgnoreCase(trimmed)) {
                forceProduction = true;
            } else if (!trimmed.startsWith("--") && !trimmed.isEmpty()) {
                eventCode = trimmed.toUpperCase();
            }
        }

        final String finalEventCode = eventCode;
        String dbUrl = JdbiConfig.resolveAppDbUrl();
        boolean isProdDb = AppConfig.isProd() || dbUrl.contains(".scoutingpro27");

        System.out.println("==================================================================");
        System.out.println("  ScoutingPro27 2026 BIOBUZZ 数据模拟生成器 (SimulateScouting)");
        System.out.println("  目标环境    : " + AppConfig.getEnvironment());
        System.out.println("  目标数据库  : " + dbUrl);
        System.out.println("  目标赛事代码: " + finalEventCode + " (赛季: " + seasonYear + ")");
        System.out.println("==================================================================");

        // 生产环境安全熔断：防止误将 Mock 数据与全量清空操作作用于真实生产数据库
        if (isProdDb && !forceProduction) {
            System.err.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
            System.err.println("【FATAL SAFETY ERROR】SimulateScouting 拒绝向生产环境写入 Mock 数据！");
            System.err.println("当前解析目标数据库: " + dbUrl);
            System.err.println("当前检测环境: " + AppConfig.getEnvironment());
            System.err.println("若确实需要向生产环境写入 Mock 数据，必须显式附加参数: --force-production");
            System.err.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
            throw new IllegalStateException("SimulateScouting blocked: Refusing to wipe/mock production database: " + dbUrl);
        }

        System.out.println("正在连接数据库并执行 Flyway 迁移: " + dbUrl);
        Flyway.configure().dataSource(dbUrl, "sa", "").locations("classpath:db").load().migrate();

        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        System.out.println("正在生成 2026 BIOBUZZ 本地独立仿真数据 (彻底脱钩外部网络请求)...");

        try {
            JsonArray matches = FtcApiClient.generateSyntheticBiobuzzMatches();
            JsonArray teams = FtcApiClient.generateSyntheticBiobuzzTeams();

            final String eventId = "EVENT_" + finalEventCode;
            final String inviteCode = "BIOBUZZ26".equalsIgnoreCase(finalEventCode) ? "BUZZ26" : (finalEventCode.length() > 6 ? finalEventCode.substring(0, 6) : finalEventCode);
            final String eventName = "2026 " + finalEventCode + " 锦标赛 (仿真测试)";
            final String defaultPasswordHash = BCrypt.hashpw("123456", BCrypt.gensalt());
            final String[] scouterIds = new String[4];

            System.out.println("正在初始化 Host [Lucalmz] 和 4 名 Scouter 账号...");
            jdbi.useTransaction(handle -> {
                String hId = handle.createQuery("SELECT id FROM users WHERE username = 'Lucalmz'")
                        .mapTo(String.class)
                        .findOne()
                        .orElseGet(() -> {
                            String newId = UUID.randomUUID().toString();
                            handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", newId, "Lucalmz", defaultPasswordHash);
                            return newId;
                        });

                handle.execute("UPDATE users SET password = ? WHERE username = 'Lucalmz' AND (password IS NULL OR password = '')", defaultPasswordHash);

                for (int i = 0; i < 4; i++) {
                    String sName = "Scouter " + (char)('A' + i);
                    scouterIds[i] = handle.createQuery("SELECT id FROM users WHERE username = ?")
                            .bind(0, sName)
                            .mapTo(String.class)
                            .findOne()
                            .orElseGet(() -> {
                                String newId = UUID.randomUUID().toString();
                                handle.execute("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", newId, sName, defaultPasswordHash);
                                return newId;
                            });
                    handle.execute("UPDATE users SET password = ? WHERE id = ? AND (password IS NULL OR password = '')", defaultPasswordHash, scouterIds[i]);
                }

                System.out.println("正在创建本地仿真赛事: " + eventName + " (InviteCode: " + inviteCode + ", 本地独立离线未绑定 FTC API)...");
                handle.execute(
                        "MERGE INTO events (id, name, invite_code, host_id, ftc_year, ftc_event_code) KEY(id) VALUES (?, ?, ?, ?, ?, ?)",
                        eventId, eventName, inviteCode, hId, null, null
                );

                handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", eventId, hId);
                for (int i = 0; i < 4; i++) {
                    handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", eventId, scouterIds[i]);
                }

                // 清理该赛事的旧数据以支持幂等重置
                handle.execute("DELETE FROM scouting_records WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM pit_scouting_records WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM match_schedules WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM scout_assignments WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM team_tags WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM banned_teams WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM ai_chat_sessions WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM event_official_teams WHERE event_id = ?", eventId);

                // 1. 插入官方战队缓存
                System.out.println("正在写入 16 支官方参赛战队...");
                for (JsonElement tElem : teams) {
                    JsonObject t = tElem.getAsJsonObject();
                    handle.execute("""
                        INSERT INTO event_official_teams (event_id, team_number, name_full, robot_name, city, country, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """, eventId, t.get("teamNumber").getAsInt(), t.get("nameFull").getAsString(),
                         t.get("robotName").getAsString(), t.get("city").getAsString(), t.get("country").getAsString());
                }

                // 2. 插入赛程与侦察任务分配 (Match Schedules & Assignments)
                System.out.println("正在生成 12 场排位赛赛程与工位分配...");
                for (JsonElement mElem : matches) {
                    JsonObject m = mElem.getAsJsonObject();
                    int matchNum = m.get("matchNum").getAsInt();
                    JsonArray matchTeams = m.getAsJsonArray("teams");
                    int red1 = matchTeams.get(0).getAsJsonObject().get("teamNumber").getAsInt();
                    int red2 = matchTeams.get(1).getAsJsonObject().get("teamNumber").getAsInt();
                    int blue1 = matchTeams.get(2).getAsJsonObject().get("teamNumber").getAsInt();
                    int blue2 = matchTeams.get(3).getAsJsonObject().get("teamNumber").getAsInt();

                    handle.execute("""
                        INSERT INTO match_schedules (id, event_id, match_number, tournament_level, red1, red2, blue1, blue2)
                        VALUES (?, ?, ?, 'QUALIFICATION', ?, ?, ?, ?)
                    """, UUID.randomUUID().toString(), eventId, matchNum, red1, red2, blue1, blue2);

                    // 4 个工位任务分配给 4 名考察员
                    String[] stations = {"red1", "red2", "blue1", "blue2"};
                    int[] stTeams = {red1, red2, blue1, blue2};
                    for (int s = 0; s < 4; s++) {
                        handle.execute("""
                            INSERT INTO scout_assignments (id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name)
                            VALUES (?, ?, ?, 'QUALIFICATION', ?, ?, ?, ?)
                        """, UUID.randomUUID().toString(), eventId, matchNum, stations[s], stTeams[s], scouterIds[s], "Scouter " + (char)('A' + s));
                    }
                }

                // 3. 生成 16 支队伍的 BIOBUZZ 展位侦察记录 (Pit Scouting)
                System.out.println("正在生成 16 支战队的 2026 BIOBUZZ 展位硬件构型与自述量化数据...");
                Random rng = new Random(42); // 固定种子保证生成确定性测试数据
                String[] compatibilities = {"universal", "sorting", "pollen_only"};
                String[] launcherTypes = {"差速双飞轮", "单大飞轮", "弹簧凸轮抛射", "气动弹射"};
                String[] flowerMechanisms = {"垂直级联高升降", "地槽推球", "仰角抛射", "无"};
                String[] drivetrains = {"swerve", "mecanum", "tank"};
                String[] odometries = {"pinpoint", "sparkfun_otos", "three_wheel", "two_wheel", "none"};

                for (JsonElement tElem : teams) {
                    JsonObject t = tElem.getAsJsonObject();
                    int teamNum = t.get("teamNumber").getAsInt();
                    String compat = teamNum == 27570 ? "universal" : compatibilities[rng.nextInt(compatibilities.length)];
                    boolean hasSensor = !compat.equals("pollen_only") && rng.nextBoolean();
                    if (teamNum == 27570) hasSensor = true;

                    String launcher = launcherTypes[rng.nextInt(launcherTypes.length)];
                    String flower = flowerMechanisms[rng.nextInt(flowerMechanisms.length)];
                    String dt = drivetrains[rng.nextInt(drivetrains.length)];
                    String odom = odometries[rng.nextInt(odometries.length)];
                    double weight = 32.0 + rng.nextInt(12) + (rng.nextInt(10) / 10.0);

                    int claimedAuto = 6 + rng.nextInt(9); // 6~14 分
                    int claimedCycles = 4 + rng.nextInt(5); // 4~8 轮
                    int claimedTeleop = claimedCycles * (2 + rng.nextInt(3)) * 2; // 30~80 分
                    int claimedEndgame = (rng.nextBoolean() ? 10 : 0) + (rng.nextBoolean() ? 5 : 0) + 5;
                    int claimedTotal = claimedAuto + claimedTeleop + claimedEndgame;
                    String strategy = teamNum == 27570 ? "预载进球+花园两球+快速停泊" : "预载直射 + 地面摄入 + 终局放花";

                    handle.createUpdate("""
                        INSERT INTO pit_scouting_records (
                            id, event_id, team_number, scout_id, scout_name, robot_name,
                            drivetrain_type, weight_lbs, odometry_type,
                            ball_compatibility, launcher_type, flower_mechanism, has_color_sensor,
                            claimed_auto_strategy, claimed_teleop_cycles, claimed_endgame_score,
                            claimed_auto_score, claimed_teleop_score, claimed_total_score,
                            photo_keys, version, is_deleted, created_at, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            '[]', 1, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                    """)
                    .bind(0, UUID.randomUUID().toString())
                    .bind(1, eventId)
                    .bind(2, teamNum)
                    .bind(3, scouterIds[rng.nextInt(4)])
                    .bind(4, "Scouter " + (char)('A' + rng.nextInt(4)))
                    .bind(5, t.get("robotName").getAsString())
                    .bind(6, dt)
                    .bind(7, weight)
                    .bind(8, odom)
                    .bind(9, compat)
                    .bind(10, launcher)
                    .bind(11, flower)
                    .bind(12, hasSensor)
                    .bind(13, strategy)
                    .bind(14, claimedCycles)
                    .bind(15, claimedEndgame)
                    .bind(16, claimedAuto)
                    .bind(17, claimedTeleop)
                    .bind(18, claimedTotal)
                    .execute();
                }

                // 4. 生成 48 条真实的比赛打分记录 (Scouting Records with Cycle Tracker)
                System.out.println("正在生成 48 条 2026 BIOBUZZ 轮次出球打分记录...");
                int recordCount = 0;
                int globalScoutIndex = 0;

                for (JsonElement matchElement : matches) {
                    JsonObject match = matchElement.getAsJsonObject();
                    int matchNum = match.get("matchNum").getAsInt();
                    JsonArray matchTeams = match.getAsJsonArray("teams");

                    for (JsonElement teamElement : matchTeams) {
                        JsonObject team = teamElement.getAsJsonObject();
                        int teamNumber = team.get("teamNumber").getAsInt();
                        String alliance = team.get("alliance").getAsString().toLowerCase();

                        int sIndex = globalScoutIndex % 4;
                        String scouterId = scouterIds[sIndex];
                        String scouterName = "Scouter " + (char)('A' + sIndex);
                        globalScoutIndex++;

                        boolean isBroken = (rng.nextInt(20) == 0); // 5% 概率故障

                        // Auto (离墙 3分, 自动进球 3分/球, 停泊 5分)
                        boolean autoLeave = !isBroken && rng.nextInt(10) < 8; // 80%
                        int autoBalls = !isBroken ? rng.nextInt(4) : 0; // 0~3 球
                        boolean autoPark = !isBroken && rng.nextInt(10) < 8; // 80%
                        int autoScore = (autoLeave ? 3 : 0) + (autoBalls * 3) + (autoPark ? 5 : 0);

                        // TeleOp (Cycles 轮次打球流: 每轮 1~4 球, 2分/球)
                        int cycleCount = isBroken ? rng.nextInt(2) : (3 + rng.nextInt(5)); // 3~7 轮
                        JsonArray cyclesArr = new JsonArray();
                        int totalBalls = 0;
                        for (int c = 0; c < cycleCount; c++) {
                            int balls = 1 + rng.nextInt(4); // 1~4 球
                            cyclesArr.add(balls);
                            totalBalls += balls;
                        }
                        int teleopScore = totalBalls * 2;

                        // Endgame (花朵大球 10分, 花底加分 5分, 停泊 5分)
                        boolean flowerPlaced = !isBroken && rng.nextBoolean(); // 50%
                        boolean flowerBottomBonus = !isBroken && flowerPlaced && rng.nextBoolean(); // 25%
                        boolean teleopPark = !isBroken && (rng.nextInt(10) < 8); // 80%
                        int endgameScore = (flowerPlaced ? 10 : 0) + (flowerBottomBonus ? 5 : 0) + (teleopPark ? 5 : 0);

                        int totalScore = autoScore + teleopScore + endgameScore;

                        JsonObject rawJson = new JsonObject();
                        rawJson.addProperty("matchNumber", matchNum);
                        rawJson.addProperty("tournamentLevel", "QUALIFICATION");
                        rawJson.addProperty("teamNumber", teamNumber);
                        rawJson.addProperty("allianceColor", alliance);
                        rawJson.addProperty("autoLeave", autoLeave);
                        rawJson.addProperty("autoBalls", autoBalls);
                        rawJson.addProperty("autoPreload", autoBalls > 0);
                        rawJson.addProperty("autoPark", autoPark);
                        rawJson.add("teleopCycles", cyclesArr);
                        rawJson.addProperty("flowerPlaced", flowerPlaced);
                        rawJson.addProperty("flowerBottomBonus", flowerBottomBonus);
                        rawJson.addProperty("teleopPark", teleopPark);
                        rawJson.addProperty("isBroken", isBroken);

                        handle.createUpdate("""
                            INSERT INTO scouting_records (
                                id, event_id, scout_id, scout_name,
                                match_number, team_number,
                                auto_score, teleop_score, endgame_score, total_score,
                                notes, raw_data, sync_status, is_broken, is_deleted,
                                created_at, updated_at, version, host_seq
                            ) VALUES (
                                ?, ?, ?, ?,
                                ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, 'SYNCED', ?, FALSE,
                                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?
                            )
                        """)
                        .bind(0, UUID.randomUUID().toString())
                        .bind(1, eventId)
                        .bind(2, scouterId)
                        .bind(3, scouterName)
                        .bind(4, matchNum)
                        .bind(5, teamNumber)
                        .bind(6, autoScore)
                        .bind(7, teleopScore)
                        .bind(8, endgameScore)
                        .bind(9, totalScore)
                        .bind(10, "2026 BIOBUZZ Match " + matchNum + " 现场打分 (轮次: " + cycleCount + ", 出球: " + totalBalls + ")")
                        .bind(11, rawJson.toString())
                        .bind(12, isBroken)
                        .bind(13, recordCount + 1)
                        .execute();

                        recordCount++;
                    }
                }

                // 5. 生成队伍战术观察标签（包含 5 种预置违规纪律标签与自选标签）
                System.out.println("正在为战队生成 2026 BIOBUZZ 预置与战术观察标签...");
                int totalTagCount = 0;
                String[] presetDisciplineTags = {
                    "#易超持", "#控制对方大球", "#提前塞大球进花", "#暴力冲撞别车", "#人玩易违规"
                };
                String[] generalObservationTags = {
                    "极速循环", "底盘稳健", "双飞轮高命中", "放花利索", "大球吞吐顺畅",
                    "麦轮敏捷", "双小球连射", "swerve_drive", "fast_cycle", "pollen_sniper"
                };
                String[] colorPalette = {"green", "blue", "purple", "orange", "red", "yellow", "gray"};

                for (JsonElement tElem : teams) {
                    int teamNum = tElem.getAsJsonObject().get("teamNumber").getAsInt();
                    List<String> teamTagPool = new ArrayList<>();
                    // 随机附加 0~2 个预置纪律标签
                    if (rng.nextBoolean()) {
                        teamTagPool.add(presetDisciplineTags[rng.nextInt(presetDisciplineTags.length)]);
                    }
                    // 附加 1~3 个常规战术标签
                    int genCount = 1 + rng.nextInt(3);
                    for (int g = 0; g < genCount; g++) {
                        String gTag = generalObservationTags[rng.nextInt(generalObservationTags.length)];
                        if (!teamTagPool.contains(gTag)) {
                            teamTagPool.add(gTag);
                        }
                    }

                    for (String tag : teamTagPool) {
                        String color = tag.startsWith("#") ? "red" : colorPalette[rng.nextInt(colorPalette.length)];
                        handle.createUpdate("""
                            INSERT INTO team_tags (
                                id, event_id, team_number, tag, color, is_preset, created_by, created_at, updated_at
                            ) VALUES (
                                ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                            )
                        """)
                        .bind(0, UUID.randomUUID().toString())
                        .bind(1, eventId)
                        .bind(2, teamNum)
                        .bind(3, tag)
                        .bind(4, color)
                        .bind(5, tag.startsWith("#")) // is_preset
                        .bind(6, hId)
                        .execute();

                        totalTagCount++;
                    }
                }

                System.out.println("\n🎉 成功为 Host [Lucalmz] 创建纯离线 2026 BIOBUZZ 仿真赛事！");
                System.out.println("--------------------------------------------------");
                System.out.println("赛事 ID       : " + eventId);
                System.out.println("赛事名称     : " + eventName);
                System.out.println("邀请码       : " + inviteCode);
                System.out.println("Host 用户名  : Lucalmz (默认密码: 123456)");
                System.out.println("绑定 FTC 代码: 无 (纯本地独立离线仿真)");
                System.out.println("参赛队伍数   : " + teams.size() + " 支");
                System.out.println("赛程场次数   : " + matches.size() + " 场排位赛");
                System.out.println("展位档案数   : " + teams.size() + " 份 (含球型兼容与自述轮次)");
                System.out.println("已生成打分记录: " + recordCount + " 条 (BIOBUZZ 轮次出球流)");
                System.out.println("已生成战术标签: " + totalTagCount + " 个 (含 5 类预置违规与自定义标签)");
                System.out.println("--------------------------------------------------");
            });

        } catch (Exception e) {
            System.err.println("模拟过程发生异常: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
