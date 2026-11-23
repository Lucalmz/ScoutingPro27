package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.SimulateScouting;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class SimulateScoutingVerificationTest {

    @TempDir
    Path tempDir;

    private String prevDataDir;
    private String prevNoAutoServer;

    @BeforeEach
    void setUp() {
        prevDataDir = System.getProperty("scouting.data.dir");
        prevNoAutoServer = System.getProperty("scouting.noAutoServer");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        System.setProperty("scouting.noAutoServer", "true");
        JdbiConfig.closeDataSources();
    }

    @AfterEach
    void tearDown() {
        JdbiConfig.closeDataSources();
        if (prevDataDir == null) {
            System.clearProperty("scouting.data.dir");
        } else {
            System.setProperty("scouting.data.dir", prevDataDir);
        }
        if (prevNoAutoServer == null) {
            System.clearProperty("scouting.noAutoServer");
        } else {
            System.setProperty("scouting.noAutoServer", prevNoAutoServer);
        }
    }

    @Test
    void testSimulatedRecordsAndTagsIntegrity() {
        // Run SimulateScouting to generate fresh synthetic 2026 BIOBUZZ data
        SimulateScouting.main(new String[]{"BIOBUZZ26"});

        String dbUrl = JdbiConfig.resolveAppDbUrl();
        Jdbi jdbi = JdbiConfig.create(dbUrl, "sa", "");

        jdbi.useHandle(handle -> {
            // 0. Build users.id <-> username lookup and verify deterministic IDs
            List<Map<String, Object>> userRows = handle.createQuery("SELECT id, username FROM users").mapToMap().list();
            Map<String, String> userIdToUsername = new HashMap<>();
            for (var u : userRows) {
                userIdToUsername.put((String) u.get("id"), (String) u.get("username"));
            }
            assertThat(userIdToUsername.get(com.bear27570.app.util.UserUtil.generateDeterministicUserId("Lucalmz")))
                    .isEqualTo("Lucalmz");
            for (int i = 0; i < 4; i++) {
                String expectedName = "Scouter " + (char) ('A' + i);
                String expectedId = com.bear27570.app.util.UserUtil.generateDeterministicUserId(expectedName);
                assertThat(userIdToUsername.get(expectedId)).isEqualTo(expectedName);
            }

            // 1. Verify Event exists
            var event = handle.createQuery("SELECT * FROM events WHERE id = 'EVENT_BIOBUZZ26'").mapToMap().findOne();
            assertThat(event).isPresent();
            String hostId = (String) event.get().get("host_id");
            assertThat(event.get().get("ftc_year")).isNull();
            assertThat(event.get().get("ftc_event_code")).isNull();
            assertThat(event.get().get("invite_code")).isEqualTo("BUZZ26");

            // 2. Verify Pit Scouting Records (16 teams) & hardware-vs-claim invariants first so match checks can cross-verify
            List<Map<String, Object>> pitRecords = handle.createQuery("SELECT * FROM pit_scouting_records WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(pitRecords).hasSize(16);
            Map<Integer, Map<String, Object>> pitByTeam = new HashMap<>();
            int teamsWithoutFlowerMech = 0;
            int pollenOnlyTeams = 0;
            int teamsWithDescoreMech = 0;
            int teamsWithoutDescoreMech = 0;

            for (var pit : pitRecords) {
                int teamNumber = ((Number) pit.get("team_number")).intValue();
                pitByTeam.put(teamNumber, pit);

                String pitScoutId = (String) pit.get("scout_id");
                String pitScoutName = (String) pit.get("scout_name");
                assertThat(userIdToUsername).containsKey(pitScoutId);
                assertThat(userIdToUsername.get(pitScoutId)).isEqualTo(pitScoutName);

                String compat = (String) pit.get("ball_compatibility");
                assertThat(compat).isIn("universal", "sorting", "pollen_only");
                if ("pollen_only".equals(compat)) pollenOnlyTeams++;

                String chassisSize = (String) pit.get("chassis_size");
                assertThat(chassisSize).isIn("紧凑小车 (≤15\")", "标准中型 (16\"-17\")", "宽体大车 (~18\")");
                String flowerMech = (String) pit.get("flower_mechanism");
                assertThat(flowerMech).isIn("垂直级联高抬升", "仰角抛射", "摆臂直投", "无");
                if ("无".equals(flowerMech)) teamsWithoutFlowerMech++;

                boolean hasDescoreMech = Boolean.TRUE.equals(pit.get("has_descore_mech"));
                if (hasDescoreMech) teamsWithDescoreMech++;
                else teamsWithoutDescoreMech++;

                int cycles = ((Number) pit.get("claimed_teleop_cycles")).intValue();
                assertThat(cycles).isGreaterThan(0);
                String strategy = (String) pit.get("claimed_auto_strategy");
                assertThat(strategy).isNotBlank();
                int claimedAuto = ((Number) pit.get("claimed_auto_score")).intValue();
                int claimedTeleop = ((Number) pit.get("claimed_teleop_score")).intValue();
                boolean claimedPark = Boolean.TRUE.equals(pit.get("claimed_teleop_park"));
                int claimedNectars = ((Number) pit.get("claimed_flower_nectars")).intValue();
                int claimedBottomBonus = ((Number) pit.get("claimed_flower_bottom_bonus")).intValue();
                int claimedPollens = ((Number) pit.get("claimed_flower_pollens")).intValue();
                int claimedGarden = ((Number) pit.get("claimed_garden_balls")).intValue();

                if ("无".equals(flowerMech) || "none".equalsIgnoreCase(flowerMech)) {
                    assertThat(claimedNectars).isZero();
                    assertThat(claimedBottomBonus).isZero();
                    assertThat(claimedPollens).isZero();
                }
                if ("pollen_only".equals(compat)) {
                    assertThat(claimedNectars).isZero();
                    assertThat(claimedBottomBonus).isZero();
                }
                if ("nectar_only".equals(compat)) {
                    assertThat(claimedPollens).isZero();
                }
                assertThat(claimedBottomBonus).isBetween(0, Math.min(4, claimedNectars));

                int expectedClaimedEndgame = (claimedPark ? 5 : 0)
                        + (claimedNectars * 2)
                        + (claimedBottomBonus * 5)
                        + (claimedPollens * 2)
                        + claimedGarden;
                int claimedEndgame = ((Number) pit.get("claimed_endgame_score")).intValue();
                assertThat(claimedEndgame).isEqualTo(expectedClaimedEndgame);
                int claimedTotal = ((Number) pit.get("claimed_total_score")).intValue();
                assertThat(claimedTotal).isEqualTo(claimedAuto + claimedTeleop + claimedEndgame);
                assertThat(pit.get("raw_data")).isNotNull();
            }
            assertThat(pitByTeam).hasSize(16);
            assertThat(teamsWithoutFlowerMech).isGreaterThan(0);
            assertThat(pollenOnlyTeams).isGreaterThan(0);
            assertThat(teamsWithDescoreMech).isGreaterThan(0);
            assertThat(teamsWithoutDescoreMech).isGreaterThan(0);

            // 3. Verify Scouting Records (48 matches) & Pit-vs-Match invariants
            List<Map<String, Object>> records = handle.createQuery("SELECT * FROM scouting_records WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(records).hasSize(48); // 12 matches * 4 teams

            int qualifiedCycleMatches = 0;
            int unqualifiedCycleMatches = 0;
            int descoreMatches = 0;

            for (var rec : records) {
                String recScoutId = (String) rec.get("scout_id");
                String recScoutName = (String) rec.get("scout_name");
                assertThat(userIdToUsername).containsKey(recScoutId);
                assertThat(userIdToUsername.get(recScoutId)).isEqualTo(recScoutName);

                int teamNumber = ((Number) rec.get("team_number")).intValue();
                Map<String, Object> pit = pitByTeam.get(teamNumber);
                assertThat(pit).isNotNull();
                String pitFlowerMech = (String) pit.get("flower_mechanism");
                String pitCompat = (String) pit.get("ball_compatibility");
                boolean pitHasDescore = Boolean.TRUE.equals(pit.get("has_descore_mech"));

                boolean isBroken = Boolean.TRUE.equals(rec.get("is_broken"));
                int auto = ((Number) rec.get("auto_score")).intValue();
                int teleop = ((Number) rec.get("teleop_score")).intValue();
                int endgame = ((Number) rec.get("endgame_score")).intValue();
                int total = ((Number) rec.get("total_score")).intValue();
                assertThat(total).isEqualTo(auto + teleop + endgame);

                String rawStr = (String) rec.get("raw_data");
                if (rawStr == null) rawStr = (String) rec.get("RAW_DATA");
                JsonObject raw = JsonParser.parseString(rawStr).getAsJsonObject();

                assertThat(raw.get("isBroken").getAsBoolean()).isEqualTo(isBroken);

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

                assertThat(raw.has("teleopCycleTimestamps")).isTrue();
                JsonArray timestampsArr = raw.getAsJsonArray("teleopCycleTimestamps");
                assertThat(timestampsArr).hasSize(cyclesArr.size());
                List<Long> tsList = new ArrayList<>();
                for (var tsElem : timestampsArr) {
                    tsList.add(tsElem.getAsLong());
                }
                List<Double> validIntervals = new ArrayList<>();
                for (int i = 1; i < tsList.size(); i++) {
                    assertThat(tsList.get(i)).isGreaterThan(tsList.get(i - 1));
                    double dtSec = (tsList.get(i) - tsList.get(i - 1)) / 1000.0;
                    assertThat(dtSec).isGreaterThan(0.0).isLessThanOrEqualTo(120.0);
                    validIntervals.add(dtSec);
                }
                assertThat(raw.has("predictCycleTimeSec")).isTrue();
                if (cyclesArr.size() >= 6) {
                    qualifiedCycleMatches++;
                    assertThat(validIntervals).hasSizeGreaterThanOrEqualTo(5);
                    Collections.sort(validIntervals);
                    double rawAverage = (validIntervals.get(1) + validIntervals.get(2)
                            + validIntervals.get(3) + validIntervals.get(4)) / 4.0;
                    double expectedPredict = Math.round(rawAverage * 10.0) / 10.0;
                    assertThat(raw.get("predictCycleTimeSec").isJsonNull()).isFalse();
                    double actualPredict = raw.get("predictCycleTimeSec").getAsDouble();
                    assertThat(actualPredict).isEqualTo(expectedPredict);
                    assertThat(Math.round(actualPredict * 10.0) / 10.0).isEqualTo(actualPredict);
                    assertThat(SimulateScouting.computePredictCycleTimeSec(tsList)).isEqualTo(expectedPredict);
                } else {
                    unqualifiedCycleMatches++;
                    assertThat(validIntervals).hasSizeLessThan(5);
                    assertThat(raw.get("predictCycleTimeSec").isJsonNull()).isTrue();
                    assertThat(SimulateScouting.computePredictCycleTimeSec(tsList)).isNull();
                }

                boolean teleopPark = raw.get("teleopPark").getAsBoolean();
                int flowerNectars = raw.get("flowerNectars").getAsInt();
                int flowerBottomBonusCount = raw.get("flowerBottomBonusCount").getAsInt();
                int flowerPollens = raw.get("flowerPollens").getAsInt();
                int gardenBalls = raw.get("gardenBalls").getAsInt();
                boolean flowerDescore = raw.get("flowerDescore").getAsBoolean();
                boolean g410EarlyFlowerFoul = raw.get("g410EarlyFlowerFoul").getAsBoolean();
                boolean flowerPlaced = raw.get("flowerPlaced").getAsBoolean();
                boolean flowerBottomBonus = raw.get("flowerBottomBonus").getAsBoolean();

                assertThat(flowerNectars).isBetween(0, 8);
                assertThat(flowerBottomBonusCount).isBetween(0, Math.min(4, flowerNectars));
                assertThat(flowerPollens).isGreaterThanOrEqualTo(0);
                assertThat(gardenBalls).isGreaterThanOrEqualTo(0);
                assertThat(flowerPlaced).isEqualTo(flowerNectars > 0);
                assertThat(flowerBottomBonus).isEqualTo(flowerBottomBonusCount > 0);
                assertThat(raw.has("flowerDescore")).isTrue();
                assertThat(raw.has("g410EarlyFlowerFoul")).isTrue();

                // Enforce Pit hardware invariants on Match Endgame
                if ("无".equals(pitFlowerMech) || "none".equalsIgnoreCase(pitFlowerMech)) {
                    assertThat(flowerNectars).isZero();
                    assertThat(flowerBottomBonusCount).isZero();
                    assertThat(flowerPollens).isZero();
                }
                if ("pollen_only".equals(pitCompat)) {
                    assertThat(flowerNectars).isZero();
                    assertThat(flowerBottomBonusCount).isZero();
                }
                if ("nectar_only".equals(pitCompat)) {
                    assertThat(flowerPollens).isZero();
                }
                if (isBroken || !pitHasDescore) {
                    assertThat(flowerDescore).isFalse();
                }
                if (flowerDescore) {
                    descoreMatches++;
                }
                if (isBroken) {
                    assertThat(autoLeave).isFalse();
                    assertThat(autoBalls).isZero();
                    assertThat(autoPark).isFalse();
                    assertThat(teleopPark).isFalse();
                    assertThat(flowerNectars).isZero();
                    assertThat(flowerBottomBonusCount).isZero();
                    assertThat(flowerPollens).isZero();
                    assertThat(gardenBalls).isZero();
                    assertThat(g410EarlyFlowerFoul).isFalse();
                }

                int calcEndgame = (teleopPark ? 5 : 0)
                        + (flowerNectars * 2)
                        + (flowerBottomBonusCount * 5)
                        + (flowerPollens * 2)
                        + gardenBalls;
                assertThat(calcEndgame).isEqualTo(endgame);

                int calcTotal = calcAuto + calcTeleop + calcEndgame;
                assertThat(calcTotal).isEqualTo(total);
            }
            assertThat(qualifiedCycleMatches).isGreaterThan(0);
            assertThat(unqualifiedCycleMatches).isGreaterThan(0);
            assertThat(descoreMatches).isGreaterThan(0);

            // Verify pit_scouting_records contains BIOBUZZ columns and NO legacy pre-Biobuzz columns
            // (Note: V3 Flyway migration retains immutable DDL column HOST_SEQ, unused by app DAOs/models)
            List<String> cols = handle.createQuery("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'PIT_SCOUTING_RECORDS'")
                    .mapTo(String.class).list();
            List<String> upperCols = cols.stream().map(String::toUpperCase).toList();
            assertThat(upperCols).contains(
                    "CHASSIS_SIZE", "BALL_COMPATIBILITY", "LAUNCHER_TYPE", "FLOWER_MECHANISM",
                    "HAS_COLOR_SENSOR", "HAS_DESCORE_MECH", "HAS_APRILTAG_VISION",
                    "CLAIMED_AUTO_STRATEGY", "CLAIMED_TELEOP_CYCLES",
                    "CLAIMED_TELEOP_PARK", "CLAIMED_FLOWER_NECTARS", "CLAIMED_FLOWER_BOTTOM_BONUS",
                    "CLAIMED_FLOWER_POLLENS", "CLAIMED_GARDEN_BALLS",
                    "CLAIMED_ENDGAME_SCORE", "RAW_DATA"
            );
            assertThat(upperCols).doesNotContain(
                    "SIZING_PASSED", "MECHANISM_TYPE", "HANG_TYPE", "CLAIMED_AUTO_PIECES",
                    "CLAIMED_AUTO_HANG_LEVEL", "CLAIMED_TELEOP_CYCLE_SEC", "CLAIMED_ENDGAME_HANG_LEVEL", "CLAIMED_ENDGAME_TIME_SEC"
            );

            // 4. Verify Match Schedules (12 matches) & Scout Assignments (48 rows, matching users)
            List<Map<String, Object>> schedules = handle.createQuery("SELECT * FROM match_schedules WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(schedules).hasSize(12);

            List<Map<String, Object>> assignments = handle.createQuery("SELECT * FROM scout_assignments WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(assignments).hasSize(48);
            for (var a : assignments) {
                String aScoutId = (String) a.get("scout_id");
                String aScoutName = (String) a.get("scout_name");
                assertThat(userIdToUsername).containsKey(aScoutId);
                assertThat(userIdToUsername.get(aScoutId)).isEqualTo(aScoutName);
            }

            // 5. Verify Team Tags
            List<Map<String, Object>> tags = handle.createQuery("SELECT * FROM team_tags WHERE event_id = 'EVENT_BIOBUZZ26'").mapToMap().list();
            assertThat(tags).isNotEmpty();
            for (var t : tags) {
                String tag = (String) t.get("tag");
                assertThat(tag).doesNotStartWith("preset.");
                assertThat(tag).doesNotContain(".");
                assertThat((String) t.get("created_by")).isEqualTo(hostId);
            }

            // 6. Verify Custom Field Definitions (V5 Architecture: 3 MATCH, 2 PIT)
            List<Map<String, Object>> customFields = handle.createQuery("SELECT * FROM event_custom_fields WHERE event_id = 'EVENT_BIOBUZZ26' ORDER BY target, order_seq").mapToMap().list();
            assertThat(customFields).hasSize(5);
            long matchCfCount = customFields.stream().filter(cf -> "MATCH".equals(cf.get("target"))).count();
            long pitCfCount = customFields.stream().filter(cf -> "PIT".equals(cf.get("target"))).count();
            assertThat(matchCfCount).isEqualTo(3);
            assertThat(pitCfCount).isEqualTo(2);

            // 7. Verify Host ID is deterministic
            String expectedHostId = com.bear27570.app.util.UserUtil.generateDeterministicUserId("Lucalmz");
            assertThat(hostId).isEqualTo(expectedHostId);
        });
    }

    @Test
    void testComputePredictCycleTimeSecContract() {
        long base = 1_760_000_000_000L;
        // Fewer than 5 intervals -> null
        assertThat(SimulateScouting.computePredictCycleTimeSec(List.of(base, base + 8_000, base + 17_000, base + 26_000, base + 35_000)))
                .isNull();

        // Intervals: [5.0, 7.12, 9.14, 11.16, 13.18] -> drop fastest (5.0), avg(7.12, 9.14, 11.16, 13.18) = 10.15 -> rounds to 10.2
        List<Long> tsQual = List.of(
                base,
                base + 5_000L,
                base + 12_120L,
                base + 21_260L,
                base + 32_420L,
                base + 45_600L
        );
        assertThat(SimulateScouting.computePredictCycleTimeSec(tsQual)).isEqualTo(10.2);

        // Stall gap > 120s is excluded, dropping valid interval count below 5 -> null
        List<Long> tsWithStall = List.of(
                base,
                base + 8_000L,
                base + 17_000L,
                base + 145_000L, // 128s gap > 120s -> ignored
                base + 154_000L,
                base + 163_000L
        );
        assertThat(SimulateScouting.computePredictCycleTimeSec(tsWithStall)).isNull();

        // Non-monotonic / non-positive timestamps are filtered cleanly
        List<Long> tsWithArtifacts = List.of(
                0L,
                base,
                base + 5_000L,
                base + 4_000L, // out-of-order -> skipped
                base + 12_000L, // 12000 - 5000 = 7.0s
                base + 21_000L, // 9.0s
                base + 31_000L, // 10.0s
                base + 42_000L  // 11.0s
        );
        // Valid intervals: [5.0, 7.0, 9.0, 10.0, 11.0] -> drop 5.0 -> avg(7, 9, 10, 11) = 9.25 -> 9.3
        assertThat(SimulateScouting.computePredictCycleTimeSec(tsWithArtifacts)).isEqualTo(9.3);
    }
}
