package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
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
        String dbUrl = JdbiConfig.resolveAppDbUrl();
        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        jdbi.useHandle(handle -> {
            // 1. Verify Event exists
            var event = handle.createQuery("SELECT * FROM events WHERE id = 'EVENT_CNCMPLB'").mapToMap().findOne();
            assertThat(event).isPresent();
            String hostId = (String) event.get().get("host_id");
            assertThat(hostId).isNotBlank();

            // 2. Verify Scouting Records
            List<Map<String, Object>> records = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = 'EVENT_CNCMPLB' LIMIT 20").mapToMap().list();
            assertThat(records).isNotEmpty();

            for (var rec : records) {
                int auto = ((Number) rec.get("auto_score")).intValue();
                int teleop = ((Number) rec.get("teleop_score")).intValue();
                int endgame = ((Number) rec.get("endgame_score")).intValue();
                int total = ((Number) rec.get("total_score")).intValue();
                assertThat(total).isEqualTo(auto + teleop + endgame);

                String rawStr = (String) rec.get("raw_data");
                if (rawStr == null) rawStr = (String) rec.get("RAW_DATA");
                JsonObject raw = JsonParser.parseString(rawStr).getAsJsonObject();

                int autoClassified = raw.get("autoClassified").getAsInt();
                int autoOverflow = raw.get("autoOverflow").getAsInt();
                int autoPatterns = raw.get("autoPatterns").getAsInt();
                int autoMovementScore = raw.get("autoMovementScore").getAsInt();
                int calcAuto = (3 * autoClassified) + (1 * autoOverflow) + (2 * autoPatterns) + autoMovementScore;
                assertThat(calcAuto).isEqualTo(auto);

                int teleopClassified = raw.get("teleopClassified").getAsInt();
                int teleopOverflow = raw.get("teleopOverflow").getAsInt();
                int gatesTriggered = raw.get("gatesTriggered").getAsInt();
                int calcTeleop = (3 * teleopClassified) + (1 * teleopOverflow) + (int) (1.5 * gatesTriggered);
                assertThat(calcTeleop).isEqualTo(teleop);

                int baseScore = raw.get("baseScore").getAsInt();
                int supportMultiplier = raw.get("supportMultiplier").getAsInt();
                int calcEndgame = baseScore + (supportMultiplier * 18);
                assertThat(calcEndgame).isEqualTo(endgame);

                int calcTotal = calcAuto + calcTeleop + calcEndgame;
                assertThat(calcTotal).isEqualTo(total);
            }

            // 3. Verify Team Tags
            List<Map<String, Object>> tags = handle.createQuery("SELECT * FROM team_tags WHERE event_id = 'EVENT_CNCMPLB'").mapToMap().list();
            assertThat(tags).isNotEmpty();
            for (var t : tags) {
                String tag = (String) t.get("tag");
                assertThat(tag).doesNotStartWith("preset.");
                assertThat(tag).doesNotContain(".");
                assertThat((Boolean) t.get("is_preset")).isFalse();
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
