package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.SimulateScouting;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class SimulateScoutingVerificationTest {

    @Test
    void testSimulatedRecordsAndTagsIntegrity() {
        // Run SimulateScouting to generate fresh synthetic 2026 BIOBUZZ data
        SimulateScouting.main(new String[]{"BIOBUZZ26"});

        String dbUrl = JdbiConfig.resolveAppDbUrl();
        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        jdbi.useHandle(handle -> {
            // 1. Verify Event exists
            var event = handle.createQuery("SELECT * FROM events WHERE id = 'EVENT_BIOBUZZ26'").mapToMap().findOne();
            assertThat(event).isPresent();
            String hostId = (String) event.get().get("host_id");
            assertThat(event.get().get("ftc_year")).isNull();
            assertThat(event.get().get("ftc_event_code")).isNull();
            assertThat(event.get().get("invite_code")).isEqualTo("BUZZ26");

            // 1b. Verify that BIOBUZZ26 is not an official FTC event code and cannot be validated
            try {
                com.bear27570.app.util.FtcApiClient ftcApiClient = new com.bear27570.app.util.FtcApiClient();
                assertThat(ftcApiClient.eventExists(2026, "BIOBUZZ26")).isFalse();
            } catch (Exception e) {
                // If offline or network error, it still doesn't exist
            }

            // 2. Verify Scouting Records
            List<Map<String, Object>> records = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(records).hasSize(48); // 12 matches * 4 teams

            for (var rec : records) {
                int auto = ((Number) rec.get("auto_score")).intValue();
                int teleop = ((Number) rec.get("teleop_score")).intValue();
                int endgame = ((Number) rec.get("endgame_score")).intValue();
                int total = ((Number) rec.get("total_score")).intValue();
                assertThat(total).isEqualTo(auto + teleop + endgame);

                String rawStr = (String) rec.get("raw_data");
                if (rawStr == null) rawStr = (String) rec.get("RAW_DATA");
                JsonObject raw = JsonParser.parseString(rawStr).getAsJsonObject();

                boolean autoLeave = raw.get("autoLeave").getAsBoolean();
                int autoBalls = raw.has("autoBalls")
                        ? raw.get("autoBalls").getAsInt()
                        : ((raw.has("autoPreload") && raw.get("autoPreload").getAsBoolean() ? 1 : 0) +
                           (raw.has("autoSecondary") && raw.get("autoSecondary").getAsBoolean() ? 1 : 0));
                boolean autoPark = raw.get("autoPark").getAsBoolean();
                int calcAuto = (autoLeave ? 3 : 0) + (autoBalls * 3) + (autoPark ? 5 : 0);
                assertThat(calcAuto).isEqualTo(auto);

                JsonArray cyclesArr = raw.getAsJsonArray("teleopCycles");
                int totalBalls = 0;
                for (var c : cyclesArr) {
                    totalBalls += c.getAsInt();
                }
                int calcTeleop = totalBalls * 2;
                assertThat(calcTeleop).isEqualTo(teleop);

                boolean flowerPlaced = raw.get("flowerPlaced").getAsBoolean();
                boolean flowerBottomBonus = raw.get("flowerBottomBonus").getAsBoolean();
                boolean teleopPark = raw.get("teleopPark").getAsBoolean();
                int calcEndgame = (flowerPlaced ? 10 : 0) + (flowerBottomBonus ? 5 : 0) + (teleopPark ? 5 : 0);
                assertThat(calcEndgame).isEqualTo(endgame);

                int calcTotal = calcAuto + calcTeleop + calcEndgame;
                assertThat(calcTotal).isEqualTo(total);
            }

            // 3. Verify Pit Scouting Records (16 teams)
            List<Map<String, Object>> pitRecords = handle.createQuery("SELECT * FROM pit_scouting_records WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(pitRecords).hasSize(16);
            for (var pit : pitRecords) {
                String compat = (String) pit.get("ball_compatibility");
                assertThat(compat).isIn("universal", "sorting", "pollen_only");
                int cycles = ((Number) pit.get("claimed_teleop_cycles")).intValue();
                assertThat(cycles).isGreaterThan(0);
                String strategy = (String) pit.get("claimed_auto_strategy");
                assertThat(strategy).isNotBlank();
                int claimedAuto = ((Number) pit.get("claimed_auto_score")).intValue();
                int claimedTeleop = ((Number) pit.get("claimed_teleop_score")).intValue();
                int claimedEndgame = ((Number) pit.get("claimed_endgame_score")).intValue();
                int claimedTotal = ((Number) pit.get("claimed_total_score")).intValue();
                assertThat(claimedTotal).isEqualTo(claimedAuto + claimedTeleop + claimedEndgame);
            }

            // Verify pit_scouting_records contains only BIOBUZZ columns and NO legacy columns
            List<String> cols = handle.createQuery("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'PIT_SCOUTING_RECORDS'")
                    .mapTo(String.class).list();
            List<String> upperCols = cols.stream().map(String::toUpperCase).toList();
            assertThat(upperCols).contains(
                    "BALL_COMPATIBILITY", "LAUNCHER_TYPE", "FLOWER_MECHANISM",
                    "HAS_COLOR_SENSOR", "CLAIMED_AUTO_STRATEGY", "CLAIMED_TELEOP_CYCLES", "CLAIMED_ENDGAME_SCORE"
            );
            assertThat(upperCols).doesNotContain(
                    "SIZING_PASSED", "MECHANISM_TYPE", "HANG_TYPE", "CLAIMED_AUTO_PIECES",
                    "CLAIMED_AUTO_HANG_LEVEL", "CLAIMED_TELEOP_CYCLE_SEC", "CLAIMED_ENDGAME_HANG_LEVEL", "CLAIMED_ENDGAME_TIME_SEC"
            );

            // 4. Verify Match Schedules (12 matches)
            List<Map<String, Object>> schedules = handle.createQuery("SELECT * FROM match_schedules WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(schedules).hasSize(12);

            // 5. Verify Team Tags
            List<Map<String, Object>> tags = handle.createQuery("SELECT * FROM team_tags WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(tags).isNotEmpty();
            for (var t : tags) {
                String tag = (String) t.get("tag");
                assertThat(tag).doesNotStartWith("preset.");
                assertThat(tag).doesNotContain(".");
                assertThat((String) t.get("created_by")).isEqualTo(hostId);
            }
        });
    }

    @Test
    void testDatabasePathResolutionDev() {
        File resolved = JdbiConfig.resolveAppDbFile();
        assertThat(resolved).isNotNull();
        // Dev resolution points to project root app_data
        File canonical = resolved.getAbsoluteFile();
        assertThat(canonical.getName()).isEqualTo("app_data");
        // Must resolve within ScoutingPro27 workspace, not user.home
        assertThat(canonical.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(canonical.getAbsolutePath()).contains("ScoutingPro27");
    }
}
