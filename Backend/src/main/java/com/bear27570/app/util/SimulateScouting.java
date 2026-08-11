package com.bear27570.app.util;

import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.ScoutingRecord;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jdbi.v3.core.Jdbi;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.Scanner;
import java.util.UUID;

public class SimulateScouting {

    public static void main(String[] args) {
        String eventCode = "";
        if (args.length > 0) {
            eventCode = args[0].trim();
        } else {
            Scanner scanner = new Scanner(System.in);
            System.out.print("请输入比赛代码 (Event Code，例如 CNCMPLB): ");
            eventCode = scanner.nextLine().trim();
        }

        final String finalEventCode = eventCode;
        if (finalEventCode.isEmpty()) {
            System.out.println("比赛代码不能为空。");
            return;
        }

        System.out.println("正在连接数据库...");
        String dbUrl = "jdbc:h2:./app_data;AUTO_SERVER=TRUE";
        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");
        RecordDao recordDao = jdbi.onDemand(RecordDao.class);

        System.out.println("正在获取官方比赛数据...");
        String query = "{\"query\":\"query GetEventMatches($code: String!) { eventByCode(season: 2025, code: $code) { matches { matchNum scores { ... on MatchScores2025 { red { penaltyPointsCommitted totalPointsNp } blue { penaltyPointsCommitted totalPointsNp } } } teams { teamNumber alliance } } } }\",\"variables\":{\"code\":\"" + finalEventCode + "\"}}";

        try {
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create("https://api.ftcscout.org/graphql"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(query))
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            
            if (json.has("errors")) {
                System.out.println("获取失败: " + json.get("errors").toString());
                return;
            }

            JsonArray matches = json.getAsJsonObject("data")
                    .getAsJsonObject("eventByCode")
                    .getAsJsonArray("matches");

            if (matches == null || matches.size() == 0) {
                System.out.println("未找到比赛数据。");
                return;
            }

            System.out.println("共找到 " + matches.size() + " 场比赛数据。开始模拟计分...");

            String[] scouterIds = new String[4];
            
            // Ensure event and users exist in the database
            jdbi.useHandle(handle -> {
                String hostId = handle.createQuery("SELECT id FROM users WHERE username = 'Lucalmz'")
                                      .mapTo(String.class)
                                      .findOne()
                                      .orElseGet(() -> {
                                          String newId = UUID.randomUUID().toString();
                                          handle.execute("INSERT INTO users (id, username) VALUES (?, ?)", newId, "Lucalmz");
                                          return newId;
                                      });
                
                for (int i = 0; i < 4; i++) {
                    String sName = "Scouter " + (char)('A' + i);
                    scouterIds[i] = handle.createQuery("SELECT id FROM users WHERE username = ?")
                                          .bind(0, sName)
                                          .mapTo(String.class)
                                          .findOne()
                                          .orElseGet(() -> {
                                              String newId = UUID.randomUUID().toString();
                                              handle.execute("INSERT INTO users (id, username) VALUES (?, ?)", newId, sName);
                                              return newId;
                                          });
                }

                String inviteCode = ("S-" + finalEventCode);
                if (inviteCode.length() > 10) inviteCode = inviteCode.substring(0, 10);
                
                handle.execute("MERGE INTO events (id, name, invite_code, host_id) KEY(id) VALUES (?, ?, ?, ?)", 
                               finalEventCode, "Simulated " + finalEventCode, inviteCode, hostId);
                               
                handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", finalEventCode, hostId);
                for (int i = 0; i < 4; i++) {
                    handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", finalEventCode, scouterIds[i]);
                }
            });

            int recordCount = 0;
            int globalScoutIndex = 0;
            for (JsonElement matchElement : matches) {
                JsonObject match = matchElement.getAsJsonObject();
                int matchNum = match.get("matchNum").getAsInt();
                JsonObject scores = match.has("scores") && !match.get("scores").isJsonNull() ? match.getAsJsonObject("scores") : null;
                JsonArray teams = match.getAsJsonArray("teams");
                
                if (scores == null || teams == null) continue;

                for (JsonElement teamElement : teams) {
                    JsonObject team = teamElement.getAsJsonObject();
                    int teamNumber = team.get("teamNumber").getAsInt();
                    String alliance = team.get("alliance").getAsString().toLowerCase();
                    
                    JsonObject allianceScore = scores.getAsJsonObject(alliance);
                    if (allianceScore == null) continue;

                    int officialTotal = allianceScore.get("totalPointsNp").getAsInt();
                    int teamTotal = officialTotal / 2;
                    
                    // Assign to one of the 4 scouters on a rotating basis
                    int sIndex = globalScoutIndex % 4;
                    String scouterId = scouterIds[sIndex];
                    String scouterName = "Scouter " + (char)('A' + sIndex);
                    
                    // Add variance to simulate real life
                    if (sIndex == 3) {
                        teamTotal += 40; // Scouter D is very inaccurate
                    } else if (sIndex == 1) {
                        teamTotal += 3;  // Scouter B is slightly off
                    } else if (sIndex == 2) {
                        teamTotal = Math.max(0, teamTotal - 2); // Scouter C is slightly off
                    }
                    
                    globalScoutIndex++;
                    
                    int autoScore = (int) (teamTotal * 0.3);
                    int endgameScore = (int) (teamTotal * 0.2);
                    int teleopScore = teamTotal - autoScore - endgameScore;
                    
                    ScoutingRecord record = new ScoutingRecord();
                    record.setId(UUID.randomUUID().toString());
                    record.setEventId(finalEventCode);
                    record.setScoutId(scouterId);
                    record.setScoutName(scouterName);
                    record.setMatchNumber(matchNum);
                    record.setTeamNumber(teamNumber);
                    record.setAutoScore(autoScore);
                    record.setTeleopScore(teleopScore);
                    record.setEndgameScore(endgameScore);
                    record.setTotalScore(teamTotal);
                    record.setNotes("Simulated by internal test tool");
                    // Raw data is just an empty json object for now to avoid parsing errors
                    record.setRawData("{}"); 
                    record.setSyncStatus("SYNCED");
                    record.setCreatedAt(Instant.now().toString());
                    record.setUpdatedAt(Instant.now().toString());

                    recordDao.upsert(record);
                    recordCount++;
                }
            }

            System.out.println("成功模拟并保存了 " + recordCount + " 条打分记录，打分账号 (Host) 为 Lucalmz，包括4名Scouter。");

        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
