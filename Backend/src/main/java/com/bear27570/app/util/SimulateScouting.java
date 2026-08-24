package com.bear27570.app.util;

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
        String eventCode = "CNCMPLB";
        int seasonYear = 2025;

        if (args.length > 0) {
            eventCode = args[0].trim().toUpperCase();
        }

        final String finalEventCode = eventCode;
        System.out.println("=== 开始为赛事 [" + finalEventCode + "] (赛季: " + seasonYear + ") 模拟 Mock 比赛数据 ===");

        String dbUrl = "jdbc:h2:./app_data;AUTO_SERVER=TRUE";
        System.out.println("正在连接数据库并执行迁移: " + dbUrl);
        Flyway.configure().dataSource(dbUrl, "sa", "").locations("classpath:db").load().migrate();

        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        System.out.println("正在通过 FTC 官方 REST API 获取 2025 赛季 [" + finalEventCode + "] 官方比赛数据...");
        FtcApiClient ftcApiClient = new FtcApiClient();

        try {
            JsonArray matches = ftcApiClient.fetchNormalizedMatches(seasonYear, finalEventCode, "qual");
            if (matches == null || matches.size() == 0) {
                matches = ftcApiClient.fetchNormalizedMatches(seasonYear, finalEventCode, null);
            }

            if (matches == null || matches.size() == 0) {
                System.out.println("未找到官方比赛数据，请检查比赛代码是否正确。");
                return;
            }

            System.out.println("成功获取官方比赛数据共 " + matches.size() + " 场。");

            final JsonArray finalMatches = matches;
            final int finalSeasonYear = seasonYear;
            final String eventId = "EVENT_" + finalEventCode;
            final String inviteCode = finalEventCode.length() > 6 ? finalEventCode.substring(0, 6) : finalEventCode;
            final String eventName = "2025 " + finalEventCode + " 锦标赛 (Mock)";
            final String defaultPasswordHash = BCrypt.hashpw("123456", BCrypt.gensalt());
            final String[] scouterIds = new String[4];

            System.out.println("正在初始化用户 Lucalmz 和 4 名考察员...");
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

                System.out.println("正在创建/绑定赛事: " + eventName + " (InviteCode: " + inviteCode + ")...");
                handle.execute(
                        "MERGE INTO events (id, name, invite_code, host_id, ftc_year, ftc_event_code) KEY(id) VALUES (?, ?, ?, ?, ?, ?)",
                        eventId, eventName, inviteCode, hId, finalSeasonYear, finalEventCode
                );

                handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", eventId, hId);
                for (int i = 0; i < 4; i++) {
                    handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", eventId, scouterIds[i]);
                }

                // 默认覆盖旧记录：清理该赛事的旧打分记录、战术标签、禁用队伍和 AI 会话
                handle.execute("DELETE FROM scouting_records WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM team_tags WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM banned_teams WHERE event_id = ?", eventId);
                handle.execute("DELETE FROM ai_chat_sessions WHERE event_id = ?", eventId);

                System.out.println("正在生成并插入各个队伍的比赛考察记录...");
                int recordCount = 0;
                int globalScoutIndex = 0;
                Set<Integer> distinctTeams = new TreeSet<>();

                for (JsonElement matchElement : finalMatches) {
                    JsonObject match = matchElement.getAsJsonObject();
                    int matchNum = match.get("matchNum").getAsInt();
                    JsonObject scores = match.has("scores") && !match.get("scores").isJsonNull() ? match.getAsJsonObject("scores") : null;
                    JsonArray teams = match.has("teams") && !match.get("teams").isJsonNull() ? match.getAsJsonArray("teams") : null;

                    if (scores == null || teams == null) continue;

                    for (JsonElement teamElement : teams) {
                        JsonObject team = teamElement.getAsJsonObject();
                        int teamNumber = team.get("teamNumber").getAsInt();
                        distinctTeams.add(teamNumber);
                        String alliance = team.get("alliance").getAsString().toLowerCase();

                        JsonObject allianceScore = scores.has(alliance) && !scores.get(alliance).isJsonNull()
                                ? scores.getAsJsonObject(alliance) : null;
                        if (allianceScore == null) continue;

                        int officialNpTotal = allianceScore.get("totalPointsNp").getAsInt();
                        int teamTotal = Math.max(0, officialNpTotal / 2);

                        int sIndex = globalScoutIndex % 4;
                        String scouterId = scouterIds[sIndex];
                        String scouterName = "Scouter " + (char)('A' + sIndex);

                        if (sIndex == 3) {
                            teamTotal += 35; // Scouter D 偏高
                        } else if (sIndex == 1) {
                            teamTotal += 3;
                        } else if (sIndex == 2) {
                            teamTotal = Math.max(0, teamTotal - 2);
                        }

                        globalScoutIndex++;

                        int autoScore = (int) (teamTotal * 0.35);
                        int endgameScore = (int) (teamTotal * 0.20);
                        int teleopScore = teamTotal - autoScore - endgameScore;
                        boolean isBroken = (teamTotal < 20);

                        JsonObject rawJson = new JsonObject();
                        rawJson.addProperty("allianceColor", alliance);
                        rawJson.addProperty("autoScore", autoScore);
                        rawJson.addProperty("teleopScore", teleopScore);
                        rawJson.addProperty("endgameScore", endgameScore);

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
                        .bind(9, teamTotal)
                        .bind(10, "2025 " + finalEventCode + " Match " + matchNum + " 现场模拟打分")
                        .bind(11, rawJson.toString())
                        .bind(12, isBroken)
                        .bind(13, recordCount + 1)
                        .execute();

                        recordCount++;
                    }
                }

                System.out.println("正在为参赛队伍随机生成战术标签...");
                int totalTagCount = 0;
                String[] candidateTags = {
                    "fast_cycle", "defense_specialist", "reliable_intake", "dual_motor_hang",
                    "auto_4_sample", "swerve_drive", "aluminum_chassis", "climb_level3",
                    "high_accuracy", "driver_skill_high", "autonomous_consistent",
                    "tippy_robot", "penalties_prone", "great_partner", "speedy_transfer",
                    "stable_lift", "heavy_defense", "vision_auto_align"
                };

                String[] colorPalette = {
                    "green", "blue", "purple", "orange", "red", "yellow", "gray"
                };

                Random rng = new Random();
                for (int teamNumber : distinctTeams) {
                    List<String> shuffled = new ArrayList<>(Arrays.asList(candidateTags));
                    Collections.shuffle(shuffled, rng);
                    int tagsForThisTeam = 1 + rng.nextInt(4); // 每支队伍 1 ~ 4 个标签
                    for (int t = 0; t < tagsForThisTeam; t++) {
                        String tag = shuffled.get(t);
                        String color = colorPalette[rng.nextInt(colorPalette.length)];
                        if (tag.equals("tippy_robot") || tag.equals("penalties_prone")) {
                            color = "red";
                        } else if (tag.equals("fast_cycle") || tag.equals("great_partner") || tag.equals("auto_4_sample")) {
                            color = "green";
                        } else if (tag.equals("swerve_drive") || tag.equals("dual_motor_hang")) {
                            color = "blue";
                        }

                        handle.createUpdate("""
                            INSERT INTO team_tags (
                                id, event_id, team_number, tag, color, is_preset, created_by, created_at, updated_at
                            ) VALUES (
                                ?, ?, ?, ?, ?, FALSE, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                            )
                        """)
                        .bind(0, UUID.randomUUID().toString())
                        .bind(1, eventId)
                        .bind(2, teamNumber)
                        .bind(3, tag)
                        .bind(4, color)
                        .bind(5, "Lucalmz")
                        .execute();

                        totalTagCount++;
                    }
                }

                System.out.println("\n🎉 成功为 Host [Lucalmz] 创建 Mock 赛事！");
                System.out.println("--------------------------------------------------");
                System.out.println("赛事 ID       : " + eventId);
                System.out.println("赛事名称     : " + eventName);
                System.out.println("邀请码       : " + inviteCode);
                System.out.println("Host 用户名  : Lucalmz (默认密码: 123456)");
                System.out.println("绑定 FTC 代码: " + finalEventCode + " (赛季: " + seasonYear + ")");
                System.out.println("已生成打分记录: " + recordCount + " 条 (来自 4 名不同 Scouter)");
                System.out.println("已生成战术标签: " + totalTagCount + " 个 (覆盖 " + distinctTeams.size() + " 支队伍)");
                System.out.println("--------------------------------------------------");
            });

        } catch (Exception e) {
            System.err.println("模拟过程发生异常: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
