package com.bear27570.app.util;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.mindrot.jbcrypt.BCrypt;

import javax.sql.DataSource;
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
        DataSource dataSource = JdbiConfig.getOrCreateDataSource(dbUrl, "sa", "");
        Flyway flyway = Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db")
                .cleanDisabled(false)
                .load();
        flyway.repair();
        flyway.migrate();

        Jdbi jdbi = JdbiConfig.create(dataSource);
        com.bear27570.app.routes.AiRoutes.ensureAiCopilotSchema(jdbi);

        // 执行用户确定性 ID 迁移与重名归并，确保底层用户模型架构大一统
        UserDeterministicIdMigrator.migrate(jdbi);

        System.out.println("正在生成 2026 BIOBUZZ 本地独立仿真数据 (彻底脱钩外部网络请求)...");

        try {
            JsonArray matches = FtcApiClient.generateSyntheticBiobuzzMatches();
            JsonArray teams = FtcApiClient.generateSyntheticBiobuzzTeams();

            final String eventId = "EVENT_" + finalEventCode;
            final String inviteCode = "BIOBUZZ26".equalsIgnoreCase(finalEventCode) ? "BUZZ26" : (finalEventCode.length() > 6 ? finalEventCode.substring(0, 6) : finalEventCode);
            final String eventName = "2026 " + finalEventCode + " 锦标赛 (仿真测试)";
            final String defaultPasswordHash = BCrypt.hashpw("123456", BCrypt.gensalt());
            final String hostUsername = "Lucalmz";
            final String hId = UserUtil.generateDeterministicUserId(hostUsername);
            final String[] scouterIds = new String[4];

            System.out.println("正在初始化 Host [Lucalmz] 和 4 名 Scouter 账号 (确定性 ID 规范)...");
            jdbi.useTransaction(handle -> {
                handle.execute("MERGE INTO users (id, username, password) KEY(id) VALUES (?, ?, ?)", hId, hostUsername, defaultPasswordHash);
                handle.execute("UPDATE users SET password = ? WHERE id = ? AND (password IS NULL OR password = '')", defaultPasswordHash, hId);

                for (int i = 0; i < 4; i++) {
                    String sName = "Scouter " + (char)('A' + i);
                    String sId = UserUtil.generateDeterministicUserId(sName);
                    scouterIds[i] = sId;
                    handle.execute("MERGE INTO users (id, username, password) KEY(id) VALUES (?, ?, ?)", sId, sName, defaultPasswordHash);
                    handle.execute("UPDATE users SET password = ? WHERE id = ? AND (password IS NULL OR password = '')", defaultPasswordHash, sId);
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
                handle.execute("DELETE FROM ai_chat_threads WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM event_official_teams WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM event_custom_fields WHERE event_id = ?", eventId);

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

                // 1b. 插入 2026 BIOBUZZ 自定义字段规范 (V5 架构对齐: Match & Pit)
                System.out.println("正在为赛事生成 2026 BIOBUZZ 自定义字段规范 (Match & Pit)...");
                handle.execute("""
                    INSERT INTO event_custom_fields (id, event_id, target, phase, name, field_key, field_type, min_val, max_val, step_val, unit, order_seq, is_active)
                    VALUES (?, ?, 'MATCH', 'teleop', '卡球次数', 'intake_jam', 'number', 0, 10, 1, '次', 1, TRUE)
                """, UUID.randomUUID().toString(), eventId);

                handle.execute("""
                    INSERT INTO event_custom_fields (id, event_id, target, phase, name, field_key, field_type, options_json, order_seq, is_active)
                    VALUES (?, ?, 'MATCH', 'teleop', '飞手抗压', 'driver_pressure', 'select', ?, 2, TRUE)
                """, UUID.randomUUID().toString(), eventId, "[{\"label\":\"沉着冷静\",\"value\":\"calm\"},{\"label\":\"略有慌乱\",\"value\":\"nervous\"},{\"label\":\"严重失常\",\"value\":\"panicked\"}]");

                handle.execute("""
                    INSERT INTO event_custom_fields (id, event_id, target, phase, name, field_key, field_type, min_val, max_val, step_val, order_seq, is_active)
                    VALUES (?, ?, 'MATCH', 'overall', '防守表现', 'defense_rating', 'level', 1, 5, 1, 3, TRUE)
                """, UUID.randomUUID().toString(), eventId);

                handle.execute("""
                    INSERT INTO event_custom_fields (id, event_id, target, phase, name, field_key, field_type, options_json, order_seq, is_active)
                    VALUES (?, ?, 'PIT', 'hardware', '吸球速率', 'intake_speed', 'select', ?, 1, TRUE)
                """, UUID.randomUUID().toString(), eventId, "[{\"label\":\"瞬吸(<0.5s)\",\"value\":\"instant\"},{\"label\":\"顺畅(0.5~1s)\",\"value\":\"smooth\"},{\"label\":\"较慢(>1s)\",\"value\":\"slow\"}]");

                handle.execute("""
                    INSERT INTO event_custom_fields (id, event_id, target, phase, name, field_key, field_type, options_json, order_seq, is_active)
                    VALUES (?, ?, 'PIT', 'strategy', '自主寻路方案', 'auto_pathing', 'select', ?, 2, TRUE)
                """, UUID.randomUUID().toString(), eventId, "[{\"label\":\"纯纯里程计\",\"value\":\"pure_odom\"},{\"label\":\"视觉+里程计融合\",\"value\":\"vision_fusion\"},{\"label\":\"按时间硬走\",\"value\":\"time_based\"}]");

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
                Random traitRng = new Random(1337L); // 独立随机源避免扰动既有模拟数值序列
                String[] compatibilities = {"universal", "sorting", "pollen_only"};
                String[] launcherTypes = {"差速双飞轮", "单飞轮抛射", "曲面滑轨", "弹簧敲击"};
                String[] flowerMechanisms = {"垂直级联高抬升", "仰角抛射", "摆臂直投", "无"};
                String[] chassisSizes = {"紧凑小车 (≤15\")", "标准中型 (16\"-17\")", "宽体大车 (~18\")"};
                String[] drivetrains = {"swerve", "mecanum", "tank"};
                String[] odometries = {"pinpoint", "sparkfun_otos", "three_wheel", "two_wheel", "none"};
                Map<Integer, TeamPitTraits> teamTraitsByNumber = new HashMap<>();
                int pitIndex = 0;

                for (JsonElement tElem : teams) {
                    pitIndex++;
                    JsonObject t = tElem.getAsJsonObject();
                    int teamNum = t.get("teamNumber").getAsInt();
                    String compat = teamNum == 27570 ? "universal" : compatibilities[rng.nextInt(compatibilities.length)];
                    boolean hasSensor = !compat.equals("pollen_only") && rng.nextBoolean();
                    if (teamNum == 27570) hasSensor = true;

                    String launcher = launcherTypes[rng.nextInt(launcherTypes.length)];
                    String flower = teamNum == 27570 ? "垂直级联高抬升" : flowerMechanisms[rng.nextInt(flowerMechanisms.length)];
                    String dt = drivetrains[rng.nextInt(drivetrains.length)];
                    String odom = odometries[rng.nextInt(odometries.length)];
                    double weight = 32.0 + rng.nextInt(12) + (rng.nextInt(10) / 10.0);
                    String chassisSize = teamNum == 27570 ? "标准中型 (16\"-17\")" : chassisSizes[traitRng.nextInt(chassisSizes.length)];
                    boolean hasDescoreMech = (teamNum == 27570) || (rng.nextInt(10) < 4);
                    boolean hasApriltagVision = (teamNum == 27570) || (rng.nextInt(10) < 6);
                    TeamPitTraits traits = new TeamPitTraits(compat, flower, hasDescoreMech);
                    teamTraitsByNumber.put(teamNum, traits);

                    int claimedAuto = 6 + rng.nextInt(9); // 6~14 分
                    int claimedCycles = 4 + rng.nextInt(5); // 4~8 轮
                    int claimedTeleop = claimedCycles * (2 + rng.nextInt(3)) * 2; // 30~80 分
                    boolean claimedTeleopPark = (teamNum == 27570) || (rng.nextInt(10) < 8);
                    int claimedFlowerNectars = traits.canScoreNectar() ? (1 + rng.nextInt(3)) : 0;
                    int claimedFlowerBottomBonus = (traits.canScoreNectar() && claimedFlowerNectars > 0)
                            ? rng.nextInt(Math.min(2, claimedFlowerNectars) + 1) : 0;
                    int claimedFlowerPollens = traits.canScorePollen() ? rng.nextInt(5) : 0;
                    int claimedGardenBalls = rng.nextInt(5);
                    int claimedEndgame = (claimedTeleopPark ? 5 : 0)
                            + (claimedFlowerNectars * 2)
                            + (claimedFlowerBottomBonus * 5)
                            + (claimedFlowerPollens * 2)
                            + claimedGardenBalls;
                    int claimedTotal = claimedAuto + claimedTeleop + claimedEndgame;
                    String strategy = teamNum == 27570 ? "预载进球+花园两球+快速停泊" : "预载直射 + 地面摄入 + 花朵/停泊";

                    int pitScoutIdx = rng.nextInt(4);
                    String pitScoutId = scouterIds[pitScoutIdx];
                    String pitScoutName = "Scouter " + (char)('A' + pitScoutIdx);

                    JsonObject pitRawJson = new JsonObject();
                    pitRawJson.addProperty("teamNumber", teamNum);
                    pitRawJson.addProperty("robotName", t.get("robotName").getAsString());
                    pitRawJson.addProperty("drivetrainType", dt);
                    pitRawJson.addProperty("weightLbs", weight);
                    pitRawJson.addProperty("chassisSize", chassisSize);
                    pitRawJson.addProperty("odometryType", odom);
                    pitRawJson.addProperty("ballCompatibility", compat);
                    pitRawJson.addProperty("launcherType", launcher);
                    pitRawJson.addProperty("flowerMechanism", flower);
                    pitRawJson.addProperty("hasColorSensor", hasSensor);
                    pitRawJson.addProperty("hasDescoreMech", hasDescoreMech);
                    pitRawJson.addProperty("hasApriltagVision", hasApriltagVision);
                    pitRawJson.addProperty("claimedAutoStrategy", strategy);
                    pitRawJson.addProperty("claimedTeleopCycles", claimedCycles);
                    pitRawJson.addProperty("claimedTeleopPark", claimedTeleopPark);
                    pitRawJson.addProperty("claimedFlowerNectars", claimedFlowerNectars);
                    pitRawJson.addProperty("claimedFlowerBottomBonus", claimedFlowerBottomBonus);
                    pitRawJson.addProperty("claimedFlowerPollens", claimedFlowerPollens);
                    pitRawJson.addProperty("claimedGardenBalls", claimedGardenBalls);
                    pitRawJson.addProperty("claimedEndgameScore", claimedEndgame);
                    pitRawJson.addProperty("claimedAutoScore", claimedAuto);
                    pitRawJson.addProperty("claimedTeleopScore", claimedTeleop);
                    pitRawJson.addProperty("claimedTotalScore", claimedTotal);

                    JsonObject pitCustomFields = new JsonObject();
                    String[] intakeSpeeds = {"instant", "smooth", "slow"};
                    String[] pathings = {"pure_odom", "vision_fusion", "time_based"};
                    pitCustomFields.addProperty("intake_speed", intakeSpeeds[rng.nextInt(intakeSpeeds.length)]);
                    pitCustomFields.addProperty("auto_pathing", pathings[rng.nextInt(pathings.length)]);
                    pitRawJson.add("customFields", pitCustomFields);

                    handle.createUpdate("""
                        INSERT INTO pit_scouting_records (
                            id, event_id, team_number, scout_id, scout_name, robot_name,
                            drivetrain_type, weight_lbs, chassis_size, odometry_type,
                            ball_compatibility, launcher_type, flower_mechanism, has_color_sensor,
                            has_descore_mech, has_apriltag_vision,
                            claimed_auto_strategy, claimed_teleop_cycles,
                            claimed_teleop_park, claimed_flower_nectars, claimed_flower_bottom_bonus, claimed_flower_pollens, claimed_garden_balls,
                            claimed_endgame_score,
                            claimed_auto_score, claimed_teleop_score, claimed_total_score,
                            photo_keys, version, is_deleted, raw_data, created_at, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?,
                            ?, ?,
                            ?, ?, ?, ?, ?,
                            ?,
                            ?, ?, ?,
                            '[]', 1, FALSE, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                    """)
                    .bind(0, UUID.randomUUID().toString())
                    .bind(1, eventId)
                    .bind(2, teamNum)
                    .bind(3, pitScoutId)
                    .bind(4, pitScoutName)
                    .bind(5, t.get("robotName").getAsString())
                    .bind(6, dt)
                    .bind(7, weight)
                    .bind(8, chassisSize)
                    .bind(9, odom)
                    .bind(10, compat)
                    .bind(11, launcher)
                    .bind(12, flower)
                    .bind(13, hasSensor)
                    .bind(14, hasDescoreMech)
                    .bind(15, hasApriltagVision)
                    .bind(16, strategy)
                    .bind(17, claimedCycles)
                    .bind(18, claimedTeleopPark)
                    .bind(19, claimedFlowerNectars)
                    .bind(20, claimedFlowerBottomBonus)
                    .bind(21, claimedFlowerPollens)
                    .bind(22, claimedGardenBalls)
                    .bind(23, claimedEndgame)
                    .bind(24, claimedAuto)
                    .bind(25, claimedTeleop)
                    .bind(26, claimedTotal)
                    .bind(27, pitRawJson.toString())
                    .execute();
                }

                // 4. 生成 48 条真实的比赛打分记录 (Scouting Records with Cycle Tracker)
                System.out.println("正在生成 48 条 2026 BIOBUZZ 轮次出球打分记录...");
                Random tsRng = new Random(2026042L); // 独立随机源生成拟真循环完成时间戳
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
                        TeamPitTraits traits = teamTraitsByNumber.getOrDefault(
                                teamNumber,
                                new TeamPitTraits("universal", "垂直级联高抬升", false)
                        );

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

                        // Endgame (2026 BIOBUZZ: 停泊 +5, 花朵 Nectar +2/颗, 占底 +5/朵, 花朵 Pollen +2/颗, Garden +1/球)
                        boolean teleopPark = !isBroken && (rng.nextInt(10) < 8); // 80%
                        int flowerNectars = (!isBroken && traits.canScoreNectar()) ? rng.nextInt(4) : 0; // 0~3 颗大球
                        int flowerBottomBonusCount = (!isBroken && traits.canScoreNectar() && flowerNectars > 0)
                                ? rng.nextInt(Math.min(4, Math.min(2, flowerNectars)) + 1) : 0; // 0~2 朵且 <= min(4, flowerNectars)
                        int flowerPollens = (!isBroken && traits.canScorePollen()) ? rng.nextInt(5) : 0; // 0~4 颗小球
                        int gardenBalls = !isBroken ? rng.nextInt(5) : 0; // 0~4 球
                        boolean flowerDescore = !isBroken && traits.hasDescoreMech() && (rng.nextInt(10) < 3); // 具备掏球机构时约30%触发敌方花底掏球
                        boolean g410EarlyFlowerFoul = !isBroken && traits.canScoreNectar() && (rng.nextInt(20) == 0); // 5% G410 提前误投 Nectar 大犯规
                        boolean flowerPlaced = flowerNectars > 0;
                        boolean flowerBottomBonus = flowerBottomBonusCount > 0;
                        int endgameScore = (teleopPark ? 5 : 0)
                                + (flowerNectars * 2)
                                + (flowerBottomBonusCount * 5)
                                + (flowerPollens * 2)
                                + gardenBalls;

                        int totalScore = autoScore + teleopScore + endgameScore;

                        JsonObject rawJson = new JsonObject();
                        rawJson.addProperty("matchNumber", matchNum);
                        rawJson.addProperty("tournamentLevel", "QUALIFICATION");
                        rawJson.addProperty("teamNumber", teamNumber);
                        rawJson.addProperty("allianceColor", alliance);
                        rawJson.addProperty("autoLeave", autoLeave);
                        rawJson.addProperty("autoBalls", autoBalls);
                        rawJson.addProperty("autoPreload", autoBalls > 0);
                        rawJson.addProperty("autoSecondary", !isBroken && autoBalls > 1);
                        rawJson.addProperty("autoPark", autoPark);

                        JsonArray autoCyclesArr = new JsonArray();
                        JsonArray autoMissedCyclesArr = new JsonArray();
                        if (autoBalls > 0) {
                            autoCyclesArr.add(autoBalls);
                            autoMissedCyclesArr.add(0);
                        }
                        rawJson.add("autoCycles", autoCyclesArr);
                        rawJson.add("autoMissedCycles", autoMissedCyclesArr);

                        rawJson.add("teleopCycles", cyclesArr);
                        JsonArray teleopMissedArr = new JsonArray();
                        for (int c = 0; c < cycleCount; c++) {
                            teleopMissedArr.add(rng.nextInt(10) < 3 ? 1 : 0);
                        }
                        rawJson.add("teleopMissedCycles", teleopMissedArr);

                        JsonArray cycleTimestampsArr = new JsonArray();
                        List<Long> cycleTimestampList = new ArrayList<>();
                        if (cycleCount > 0) {
                            long matchTeleopStartMs = 1_760_000_000_000L + (matchNum * 300_000L);
                            int teamBaseCycleMs = 7_500 + (Math.floorMod(teamNumber * 31, 7) * 1_100);
                            long cursorMs = matchTeleopStartMs + 8_000L + tsRng.nextInt(5_000);
                            for (int c = 0; c < cycleCount; c++) {
                                if (c > 0) {
                                    int intervalMs = Math.max(4_500, teamBaseCycleMs + tsRng.nextInt(3_200) - 800);
                                    cursorMs += intervalMs;
                                }
                                cycleTimestampsArr.add(cursorMs);
                                cycleTimestampList.add(cursorMs);
                            }
                        }
                        Double predictCycleTimeSec = computePredictCycleTimeSec(cycleTimestampList);
                        rawJson.add("teleopCycleTimestamps", cycleTimestampsArr);
                        if (predictCycleTimeSec != null) {
                            rawJson.addProperty("predictCycleTimeSec", predictCycleTimeSec);
                        } else {
                            rawJson.add("predictCycleTimeSec", JsonNull.INSTANCE);
                        }

                        rawJson.addProperty("teleopPark", teleopPark);
                        rawJson.addProperty("flowerNectars", flowerNectars);
                        rawJson.addProperty("flowerBottomBonusCount", flowerBottomBonusCount);
                        rawJson.addProperty("flowerPollens", flowerPollens);
                        rawJson.addProperty("gardenBalls", gardenBalls);
                        rawJson.addProperty("flowerDescore", flowerDescore);
                        rawJson.addProperty("g410EarlyFlowerFoul", g410EarlyFlowerFoul);
                        rawJson.addProperty("flowerPlaced", flowerPlaced);
                        rawJson.addProperty("flowerBottomBonus", flowerBottomBonus);
                        rawJson.addProperty("isBroken", isBroken);

                        JsonObject matchCustomFields = new JsonObject();
                        matchCustomFields.addProperty("intake_jam", isBroken ? 2 + rng.nextInt(3) : (rng.nextInt(5) == 0 ? 1 : 0));
                        String[] pressures = {"calm", "nervous", "panicked"};
                        matchCustomFields.addProperty("driver_pressure", pressures[rng.nextInt(pressures.length)]);
                        matchCustomFields.addProperty("defense_rating", 1 + rng.nextInt(5));
                        rawJson.add("customFields", matchCustomFields);

                        handle.createUpdate("""
                            INSERT INTO scouting_records (
                                id, event_id, scout_id, scout_name,
                                match_number, team_number,
                                auto_score, teleop_score, endgame_score, total_score,
                                notes, raw_data, sync_status, is_broken, is_deleted,
                                created_at, updated_at, version
                            ) VALUES (
                                ?, ?, ?, ?,
                                ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, 'SYNCED', ?, FALSE,
                                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
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
                System.out.println("展位档案数   : " + teams.size() + " 份 (含球型兼容与自述轮次及自定义字段)");
                System.out.println("已生成打分记录: " + recordCount + " 条 (BIOBUZZ 轮次出球流及自定义字段)");
                System.out.println("已生成战术标签: " + totalTagCount + " 个 (含 5 类预置违规与自定义标签)");
                System.out.println("--------------------------------------------------");
            });

        } catch (Exception e) {
            System.err.println("模拟过程发生异常: " + e.getMessage());
            e.printStackTrace();
            throw new RuntimeException("SimulateScouting failed", e);
        } finally {
            JdbiConfig.closeDataSources();
        }
    }

    record TeamPitTraits(String ballCompatibility, String flowerMechanism, boolean hasDescoreMech) {
        boolean hasFlowerMechanism() {
            return flowerMechanism != null
                    && !flowerMechanism.isBlank()
                    && !"无".equals(flowerMechanism.trim())
                    && !"none".equalsIgnoreCase(flowerMechanism.trim());
        }

        boolean canScoreNectar() {
            return hasFlowerMechanism() && !"pollen_only".equalsIgnoreCase(ballCompatibility);
        }

        boolean canScorePollen() {
            return hasFlowerMechanism() && !"nectar_only".equalsIgnoreCase(ballCompatibility);
        }
    }

    /**
     * 按 BIOBUZZ predictCycleTime 契约计算单场预测循环耗时（秒）：
     * - 仅保留正且严格单调递增的时间戳，相邻有效间隔 dt = (t[i] - t[i-1]) / 1000，仅保留 0 < dt <= 120；
     * - 若有效间隔 < 5 个，返回 null（不达标）；
     * - 若 >= 5 个，升序排序后去掉最短 1 次，取接下来较短的 4 次求均值并四舍五入到 0.1 秒精度。
     */
    public static Double computePredictCycleTimeSec(List<Long> timestamps) {
        if (timestamps == null || timestamps.size() < 6) {
            return null;
        }
        List<Long> validTimestamps = new ArrayList<>();
        for (Long ts : timestamps) {
            if (ts == null || ts <= 0L) {
                continue;
            }
            if (!validTimestamps.isEmpty() && ts <= validTimestamps.get(validTimestamps.size() - 1)) {
                continue;
            }
            validTimestamps.add(ts);
        }
        if (validTimestamps.size() < 6) {
            return null;
        }
        List<Double> validIntervals = new ArrayList<>();
        for (int i = 1; i < validTimestamps.size(); i++) {
            double dtSec = (validTimestamps.get(i) - validTimestamps.get(i - 1)) / 1000.0;
            if (dtSec > 0.0 && dtSec <= 120.0) {
                validIntervals.add(dtSec);
            }
        }
        if (validIntervals.size() < 5) {
            return null;
        }
        Collections.sort(validIntervals);
        double sum = 0.0;
        for (int i = 1; i < 5; i++) {
            sum += validIntervals.get(i);
        }
        return Math.round((sum / 4.0) * 10.0) / 10.0;
    }
}
