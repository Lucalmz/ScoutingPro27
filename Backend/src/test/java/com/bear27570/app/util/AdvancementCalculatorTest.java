package com.bear27570.app.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class AdvancementCalculatorTest {

    @Test
    @DisplayName("invErf should correctly compute inverse error function values and boundaries")
    void testInvErfValues() {
        assertEquals(0.0, AdvancementCalculator.invErf(0.0), 1e-9);
        assertTrue(Double.isInfinite(AdvancementCalculator.invErf(1.0)));
        assertTrue(Double.isInfinite(AdvancementCalculator.invErf(-1.0)));

        // erf(0.5) ~ 0.5204998778 -> invErf(erf(0.5)) ~ 0.5
        double erfHalf = AdvancementCalculator.erf(0.5);
        assertEquals(0.5, AdvancementCalculator.invErf(erfHalf), 1e-6);

        // invErf(1 / 1.07) ~ 1.30275
        double invAlpha = AdvancementCalculator.invErf(1.0 / 1.07);
        assertEquals(1.30275, invAlpha, 1e-3);
    }

    @Test
    @DisplayName("calcQualPoints strictly follows FTC Table 4-1 normal distribution (2 to 16 points)")
    void testCalcQualPointsBoundaries() {
        // N = 24 teams
        int rank1 = AdvancementCalculator.calcQualPoints(1, 24);
        int rank12 = AdvancementCalculator.calcQualPoints(12, 24);
        int rank24 = AdvancementCalculator.calcQualPoints(24, 24);

        assertEquals(16, rank1, "Rank 1 must receive exactly 16 points");
        assertEquals(10, rank12, "Median rank should receive approximately 10 points");
        assertTrue(rank24 >= 2 && rank24 <= 4, "Last rank must receive >= 2 points");

        // Edge case: N = 1
        assertEquals(16, AdvancementCalculator.calcQualPoints(1, 1));

        // Edge case: Invalid inputs
        assertEquals(0, AdvancementCalculator.calcQualPoints(0, 24));
        assertEquals(0, AdvancementCalculator.calcQualPoints(1, 0));

        // Monotonic decreasing: as rank increases, points decrease or stay equal
        int prev = 16;
        for (int r = 1; r <= 36; r++) {
            int pts = AdvancementCalculator.calcQualPoints(r, 36);
            assertTrue(pts <= prev, "Qual points should be monotonically non-increasing");
            assertTrue(pts >= 2 && pts <= 16, "Qual points must be bounded between 2 and 16");
            prev = pts;
        }
    }

    @Test
    @DisplayName("calcAlliancePoints awards 21 - seed for Captains and Pick 1")
    void testCalcAlliancePoints() {
        assertEquals(20, AdvancementCalculator.calcAlliancePoints(1, true, false));
        assertEquals(19, AdvancementCalculator.calcAlliancePoints(2, true, false));
        assertEquals(18, AdvancementCalculator.calcAlliancePoints(3, true, false));
        assertEquals(17, AdvancementCalculator.calcAlliancePoints(4, true, false));

        // 2nd pick in 4-alliance snake draft: Alliance 4 picks 5th (16 pts), Alliance 1 picks 8th (13 pts)
        assertEquals(16, AdvancementCalculator.calcAlliancePoints(4, false, true));
        assertEquals(15, AdvancementCalculator.calcAlliancePoints(3, false, true));
        assertEquals(14, AdvancementCalculator.calcAlliancePoints(2, false, true));
        assertEquals(13, AdvancementCalculator.calcAlliancePoints(1, false, true));

        // Unselected team
        assertEquals(0, AdvancementCalculator.calcAlliancePoints(0, false, false));
        assertEquals(0, AdvancementCalculator.calcAlliancePoints(5, false, false));
    }

    @Test
    @DisplayName("calcPlayoffPoints awards 40 for Winner, 20 for Finalist, 10 for 3rd, 5 for 4th")
    void testCalcPlayoffPoints() {
        assertEquals(40, AdvancementCalculator.calcPlayoffPoints("WINNER"));
        assertEquals(40, AdvancementCalculator.calcPlayoffPoints("Winning Alliance"));
        assertEquals(40, AdvancementCalculator.calcPlayoffPoints("CHAMPION"));

        assertEquals(20, AdvancementCalculator.calcPlayoffPoints("FINALIST"));
        assertEquals(20, AdvancementCalculator.calcPlayoffPoints("Finalist Alliance"));

        assertEquals(10, AdvancementCalculator.calcPlayoffPoints("3RD"));
        assertEquals(10, AdvancementCalculator.calcPlayoffPoints("3rd Place"));

        assertEquals(5, AdvancementCalculator.calcPlayoffPoints("4TH"));
        assertEquals(5, AdvancementCalculator.calcPlayoffPoints("4th Place"));

        assertEquals(0, AdvancementCalculator.calcPlayoffPoints("QUARTERFINALIST"));
        assertEquals(0, AdvancementCalculator.calcPlayoffPoints(null));
    }

    @Test
    @DisplayName("calcAwardPoints awards 60/30/15 for Inspire and 12/6/3 for other Judged Awards")
    void testCalcAwardPoints() {
        // Inspire Award
        assertEquals(60, AdvancementCalculator.calcAwardPoints("Inspire Award", 1));
        assertEquals(30, AdvancementCalculator.calcAwardPoints("Inspire Award", 2));
        assertEquals(15, AdvancementCalculator.calcAwardPoints("Inspire Award", 3));

        // Other judged awards: Think, Connect, Innovate, Design, Motivate, Control, Judges' Award
        assertEquals(12, AdvancementCalculator.calcAwardPoints("Think Award", 1));
        assertEquals(6, AdvancementCalculator.calcAwardPoints("Connect Award", 2));
        assertEquals(3, AdvancementCalculator.calcAwardPoints("Design Award", 3));
        assertEquals(12, AdvancementCalculator.calcAwardPoints("Control Award sponsored by Arm", 1));
        assertEquals(12, AdvancementCalculator.calcAwardPoints("Judges' Choice Award", 1));

        // Excluded personal/mentor awards
        assertEquals(0, AdvancementCalculator.calcAwardPoints("Dean's List Finalist", 1));
        assertEquals(0, AdvancementCalculator.calcAwardPoints("Compass Award", 1));
        assertEquals(0, AdvancementCalculator.calcAwardPoints("Promote Award", 1));
        assertEquals(0, AdvancementCalculator.calcAwardPoints("Volunteer of the Year", 1));
    }

    @Test
    @DisplayName("calculateAdvancement integrates all categories and sorts strictly by Table 4-2 criteria")
    void testCalculateAdvancementEndToEnd() {
        JsonArray rankings = new JsonArray();
        JsonObject r1 = new JsonObject();
        r1.addProperty("teamNumber", 27570);
        r1.addProperty("rank", 1);
        r1.addProperty("sortOrder1", 120.0);
        rankings.add(r1);

        JsonObject r2 = new JsonObject();
        r2.addProperty("teamNumber", 11115);
        r2.addProperty("rank", 2);
        r2.addProperty("sortOrder1", 110.0);
        rankings.add(r2);

        JsonObject r3 = new JsonObject();
        r3.addProperty("teamNumber", 8417);
        r3.addProperty("rank", 3);
        r3.addProperty("sortOrder1", 100.0);
        rankings.add(r3);

        JsonArray alliances = new JsonArray();
        JsonObject a1 = new JsonObject();
        a1.addProperty("number", 1);
        a1.addProperty("captain", 27570);
        a1.addProperty("round1", 11115);
        alliances.add(a1);

        JsonArray awards = new JsonArray();
        JsonObject aw1 = new JsonObject();
        aw1.addProperty("name", "Inspire Award");
        aw1.addProperty("series", 1);
        aw1.addProperty("teamNumber", 27570);
        awards.add(aw1);

        JsonObject aw2 = new JsonObject();
        aw2.addProperty("name", "Winning Alliance Captain");
        aw2.addProperty("series", 1);
        aw2.addProperty("teamNumber", 27570);
        awards.add(aw2);

        JsonObject aw3 = new JsonObject();
        aw3.addProperty("name", "Winning Alliance 1st Pick");
        aw3.addProperty("series", 1);
        aw3.addProperty("teamNumber", 11115);
        awards.add(aw3);

        JsonArray advancement = AdvancementCalculator.calculateAdvancement(rankings, alliances, awards, new JsonArray(), 2);

        assertNotNull(advancement);
        assertEquals(3, advancement.size());

        JsonObject topTeam = advancement.get(0).getAsJsonObject();
        assertEquals(27570, topTeam.get("teamNumber").getAsInt());
        assertEquals(1, topTeam.get("advancementRank").getAsInt());
        // Qual (16) + Alliance (20) + Playoff (40) + Inspire 1st (60) = 136 pts
        assertEquals(136, topTeam.get("totalAdvancementPoints").getAsInt());
        assertEquals("ADVANCING", topTeam.get("advancementStatus").getAsString());

        JsonObject secondTeam = advancement.get(1).getAsJsonObject();
        assertEquals(11115, secondTeam.get("teamNumber").getAsInt());
        assertEquals(2, secondTeam.get("advancementRank").getAsInt());
        // Qual (12) + Alliance (20) + Playoff (40) = 72 pts
        assertEquals("ADVANCING", secondTeam.get("advancementStatus").getAsString());

        JsonObject thirdTeam = advancement.get(2).getAsJsonObject();
        assertEquals(8417, thirdTeam.get("teamNumber").getAsInt());
        assertEquals(3, thirdTeam.get("advancementRank").getAsInt());
        assertEquals("BUBBLE", thirdTeam.get("advancementStatus").getAsString());
    }

    @Test
    @DisplayName("Dean's List and personal/mentor awards do not grant playoff points")
    void testNonPlayoffAwardsDoNotGrantPlayoffPoints() {
        JsonArray rankings = new JsonArray();
        JsonObject r1 = new JsonObject();
        r1.addProperty("teamNumber", 9999);
        r1.addProperty("rank", 10);
        rankings.add(r1);

        JsonArray awards = new JsonArray();
        JsonObject aw1 = new JsonObject();
        aw1.addProperty("name", "Dean's List Finalist");
        aw1.addProperty("teamNumber", 9999);
        awards.add(aw1);

        JsonObject aw2 = new JsonObject();
        aw2.addProperty("name", "Compass Award Winner");
        aw2.addProperty("teamNumber", 9999);
        awards.add(aw2);

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), awards, new JsonArray(), 4);
        JsonObject entry = adv.get(0).getAsJsonObject();
        assertEquals(0, entry.get("playoffPoints").getAsInt(), "Dean's List Finalist / Compass Winner must NOT award playoff points");
        assertEquals(0, entry.get("awardPoints").getAsInt(), "Dean's List and Compass must award 0 judged team award points");
    }

    @Test
    @DisplayName("Semifinal playoff matches are correctly distinguished from Finals matches")
    void testPlayoffSemifinalsVersusFinalsDetection() {
        JsonArray rankings = new JsonArray();
        for (int t : new int[]{1001, 1002, 2001, 2002}) {
            JsonObject r = new JsonObject();
            r.addProperty("teamNumber", t);
            r.addProperty("rank", 1);
            rankings.add(r);
        }

        JsonArray matches = new JsonArray();

        // 1. Semifinal 1 match 1: Red (1001) beats Blue (2001)
        JsonObject semi = new JsonObject();
        semi.addProperty("tournamentLevel", "PLAYOFF");
        semi.addProperty("series", 1);
        semi.addProperty("matchNum", 1);
        semi.addProperty("description", "Semifinals 1 Match 1");
        JsonObject scores1 = new JsonObject();
        JsonObject red1 = new JsonObject();
        red1.addProperty("finalScore", 120);
        JsonObject blue1 = new JsonObject();
        blue1.addProperty("finalScore", 80);
        scores1.add("red", red1);
        scores1.add("blue", blue1);
        semi.add("scores", scores1);

        JsonArray teams1 = new JsonArray();
        JsonObject t1 = new JsonObject();
        t1.addProperty("teamNumber", 1001);
        t1.addProperty("alliance", "Red");
        teams1.add(t1);
        JsonObject t2 = new JsonObject();
        t2.addProperty("teamNumber", 2001);
        t2.addProperty("alliance", "Blue");
        teams1.add(t2);
        semi.add("teams", teams1);
        matches.add(semi);

        JsonArray advSemi = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), matches, 4);
        assertEquals(4, advSemi.size());
        java.util.Map<Integer, JsonObject> semiByTeam = new java.util.HashMap<>();
        for (int i = 0; i < advSemi.size(); i++) {
            JsonObject obj = advSemi.get(i).getAsJsonObject();
            semiByTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }
        assertNotNull(semiByTeam.get(1001));
        assertNotNull(semiByTeam.get(2001));
        assertEquals(20, semiByTeam.get(1001).get("playoffPoints").getAsInt(), "Semifinal winner gets 20 playoff points, NOT 40");
        assertEquals(5, semiByTeam.get(2001).get("playoffPoints").getAsInt(), "Semifinal loser gets 5 playoff points, NOT 20");

        // 2. Finals match: Red (1001) beats Blue (1002) in Finals
        JsonObject finals = new JsonObject();
        finals.addProperty("tournamentLevel", "PLAYOFF");
        finals.addProperty("series", 3);
        finals.addProperty("matchNum", 1);
        finals.addProperty("description", "Finals 1");
        JsonObject scores2 = new JsonObject();
        JsonObject red2 = new JsonObject();
        red2.addProperty("finalScore", 150);
        JsonObject blue2 = new JsonObject();
        blue2.addProperty("finalScore", 130);
        scores2.add("red", red2);
        scores2.add("blue", blue2);
        finals.add("scores", scores2);

        JsonArray teams2 = new JsonArray();
        JsonObject t3 = new JsonObject();
        t3.addProperty("teamNumber", 1001);
        t3.addProperty("alliance", "Red");
        teams2.add(t3);
        JsonObject t4 = new JsonObject();
        t4.addProperty("teamNumber", 1002);
        t4.addProperty("alliance", "Blue");
        teams2.add(t4);
        finals.add("teams", teams2);
        matches.add(finals);

        JsonArray advFinals = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), matches, 4);
        assertEquals(4, advFinals.size());
        java.util.Map<Integer, JsonObject> finalsByTeam = new java.util.HashMap<>();
        for (int i = 0; i < advFinals.size(); i++) {
            JsonObject obj = advFinals.get(i).getAsJsonObject();
            finalsByTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }
        assertNotNull(finalsByTeam.get(1001));
        assertNotNull(finalsByTeam.get(1002));
        assertEquals(40, finalsByTeam.get(1001).get("playoffPoints").getAsInt(), "Finals winner gets 40 playoff points");
        assertEquals(20, finalsByTeam.get(1002).get("playoffPoints").getAsInt(), "Finals runner-up gets 20 playoff points");
    }

    @Test
    @DisplayName("Best-of-3 Finals where runner-up wins a match awards 40 to champion and 20 to runner-up")
    void testMultiMatchFinalsSeriesOnlyAwards40ToSeriesChampion() {
        JsonArray rankings = new JsonArray();
        for (int t : new int[]{1001, 1002}) {
            JsonObject r = new JsonObject();
            r.addProperty("teamNumber", t);
            r.addProperty("rank", 1);
            rankings.add(r);
        }

        JsonArray matches = new JsonArray();

        // Finals Match 1: Red (1001) beats Blue (1002) 150-130
        matches.add(createPlayoffMatch(3, 1, "Finals 1", 1001, 1002, 150, 130));
        // Finals Match 2: Blue (1002) beats Red (1001) 140-120
        matches.add(createPlayoffMatch(3, 2, "Finals 2", 1001, 1002, 120, 140));
        // Finals Match 3: Red (1001) beats Blue (1002) 160-110 (Red wins series 2-1)
        matches.add(createPlayoffMatch(3, 3, "Finals 3", 1001, 1002, 160, 110));

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), matches, 2);
        assertEquals(2, adv.size());
        java.util.Map<Integer, JsonObject> byTeam = new java.util.HashMap<>();
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            byTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }
        assertNotNull(byTeam.get(1001));
        assertNotNull(byTeam.get(1002));
        assertEquals(40, byTeam.get(1001).get("playoffPoints").getAsInt(), "Champion with 2 wins gets 40 playoff points");
        assertEquals(20, byTeam.get(1002).get("playoffPoints").getAsInt(), "Finalist runner-up with 1 win gets 20 playoff points, NOT 40");
    }

    @Test
    @DisplayName("Judged awards containing 'Winner' or 'Finalist' in their name do not leak playoff points")
    void testJudgedAwardsWithWinnerOrFinalistTitleDoNotGrantPlayoffPoints() {
        JsonArray rankings = new JsonArray();
        JsonObject r1 = new JsonObject();
        r1.addProperty("teamNumber", 8417);
        r1.addProperty("rank", 5);
        rankings.add(r1);

        JsonObject r2 = new JsonObject();
        r2.addProperty("teamNumber", 19600);
        r2.addProperty("rank", 6);
        rankings.add(r2);

        JsonArray awards = new JsonArray();
        JsonObject aw1 = new JsonObject();
        aw1.addProperty("name", "Think Award Winner");
        aw1.addProperty("teamNumber", 8417);
        awards.add(aw1);

        JsonObject aw2 = new JsonObject();
        aw2.addProperty("name", "Design Award Finalist");
        aw2.addProperty("teamNumber", 19600);
        awards.add(aw2);

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), awards, new JsonArray(), 4);
        assertEquals(2, adv.size());
        java.util.Map<Integer, JsonObject> byTeam = new java.util.HashMap<>();
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            byTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }
        assertNotNull(byTeam.get(8417));
        assertNotNull(byTeam.get(19600));
        assertEquals(0, byTeam.get(8417).get("playoffPoints").getAsInt(), "Think Award Winner must NOT grant 40 playoff points");
        assertEquals(12, byTeam.get(8417).get("awardPoints").getAsInt(), "Think Award Winner grants 12 judged award points");
        assertEquals(0, byTeam.get(19600).get("playoffPoints").getAsInt(), "Design Award Finalist must NOT grant 20 playoff points");
        assertEquals(6, byTeam.get(19600).get("awardPoints").getAsInt(), "Design Award Finalist grants 6 judged award points");
    }

    @Test
    @DisplayName("Teams eliminated in Semifinals receive 10 or 5 points, never 20 points, when Finals occurs")
    void testEliminatedSemifinalistsReceive10Or5PointsNot20() {
        JsonArray rankings = new JsonArray();
        for (int t : new int[]{1001, 1002, 2001, 2002}) {
            JsonObject r = new JsonObject();
            r.addProperty("teamNumber", t);
            r.addProperty("rank", 1);
            rankings.add(r);
        }

        JsonArray matches = new JsonArray();
        // SF1 Match 1: 1001 beats 2001
        matches.add(createPlayoffMatch(1, 1, "Semifinals 1 Match 1", 1001, 2001, 120, 80));
        // SF1 Match 2: 2001 beats 1001
        matches.add(createPlayoffMatch(1, 2, "Semifinals 1 Match 2", 1001, 2001, 90, 110));
        // SF1 Match 3: 1001 beats 2001 (1001 advances to Finals, 2001 eliminated with 1 win)
        matches.add(createPlayoffMatch(1, 3, "Semifinals 1 Match 3", 1001, 2001, 130, 85));

        // SF2 Match 1: 1002 beats 2002
        matches.add(createPlayoffMatch(2, 1, "Semifinals 2 Match 1", 1002, 2002, 100, 70));
        // SF2 Match 2: 1002 beats 2002 (1002 advances to Finals, 2002 eliminated with 0 wins)
        matches.add(createPlayoffMatch(2, 2, "Semifinals 2 Match 2", 1002, 2002, 105, 60));

        // Finals 1: 1001 beats 1002
        matches.add(createPlayoffMatch(3, 1, "Finals 1", 1001, 1002, 150, 120));

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), matches, 4);
        assertEquals(4, adv.size(), "All 4 playoff teams must be present in advancement output");
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            int t = obj.get("teamNumber").getAsInt();
            if (t == 1001) {
                assertEquals(40, obj.get("playoffPoints").getAsInt(), "Finals winner gets 40");
            } else if (t == 1002) {
                assertEquals(20, obj.get("playoffPoints").getAsInt(), "Finalist gets 20");
            } else if (t == 2001) {
                assertEquals(10, obj.get("playoffPoints").getAsInt(), "3rd place semifinalist with 1 win gets 10 points, NOT 20");
            } else if (t == 2002) {
                assertEquals(5, obj.get("playoffPoints").getAsInt(), "4th place semifinalist with 0 wins gets 5 points, NOT 20");
            }
        }
    }

    private static JsonObject createPlayoffMatch(int series, int matchNum, String desc, int redTeam, int blueTeam, int redScore, int blueScore) {
        JsonObject m = new JsonObject();
        m.addProperty("tournamentLevel", "PLAYOFF");
        m.addProperty("series", series);
        m.addProperty("matchNum", matchNum);
        m.addProperty("description", desc);

        JsonObject scores = new JsonObject();
        JsonObject red = new JsonObject();
        red.addProperty("finalScore", redScore);
        JsonObject blue = new JsonObject();
        blue.addProperty("finalScore", blueScore);
        scores.add("red", red);
        scores.add("blue", blue);
        m.add("scores", scores);

        JsonArray teams = new JsonArray();
        JsonObject t1 = new JsonObject();
        t1.addProperty("teamNumber", redTeam);
        t1.addProperty("alliance", "Red");
        teams.add(t1);

        JsonObject t2 = new JsonObject();
        t2.addProperty("teamNumber", blueTeam);
        t2.addProperty("alliance", "Blue");
        teams.add(t2);
        m.add("teams", teams);

        return m;
    }

    @Test
    @DisplayName("Supports nested FTC v2.0 AllianceTeam objects, Sustain/Reach awards, and Rule A215 single-award cap")
    void testNestedAllianceTeamObjectsSustainReachAndRuleA215() {
        assertEquals(12, AdvancementCalculator.calcAwardPoints("Sustain Award", 1));
        assertEquals(6, AdvancementCalculator.calcAwardPoints("Reach Award", 2));
        assertEquals(3, AdvancementCalculator.calcAwardPoints("Sustain Award", 3));

        JsonArray rankings = new JsonArray();
        int[] teams = {23400, 11115, 8417, 18457, 11260, 8644};
        for (int i = 0; i < teams.length; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("rank", i + 1);
            r.addProperty("teamNumber", teams[i]);
            rankings.add(r);
        }

        // Raw nested AllianceTeam objects from official /v2.0/{season}/alliances/{eventCode}
        JsonArray alliances = new JsonArray();
        for (int seed = 1; seed <= 6; seed++) {
            JsonObject a = new JsonObject();
            a.addProperty("number", seed);
            JsonObject cap = new JsonObject();
            cap.addProperty("teamNumber", 2000 + seed);
            a.add("captain", cap);
            JsonObject r1 = new JsonObject();
            r1.addProperty("teamNumber", 3000 + seed);
            a.add("round1", r1);
            JsonObject r2 = new JsonObject();
            r2.addProperty("teamNumber", 4000 + seed);
            a.add("round2", r2);
            alliances.add(a);
        }

        // Duplicate/multiple judged awards for team 23400: Rule A215 caps at highest single judged award (60, not 72)
        JsonArray awards = new JsonArray();
        JsonObject aw1 = new JsonObject();
        aw1.addProperty("name", "Inspire Award");
        aw1.addProperty("series", 1);
        aw1.addProperty("teamNumber", 23400);
        awards.add(aw1);

        JsonObject aw2 = new JsonObject();
        aw2.addProperty("name", "Sustain Award");
        aw2.addProperty("series", 1);
        aw2.addProperty("teamNumber", 23400);
        awards.add(aw2);

        JsonObject aw3 = new JsonObject();
        aw3.addProperty("name", "Reach Award");
        aw3.addProperty("series", 1);
        aw3.addProperty("teamNumber", 11115);
        awards.add(aw3);

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, alliances, awards, new JsonArray(), 4);
        int t23400Award = -1;
        int t11115Award = -1;
        int a1Round2Pts = -1; // 6-alliance snake draft: Alliance 1's round2 is 12th draft pick -> 21 - 12 = 9
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            int t = obj.get("teamNumber").getAsInt();
            if (t == 23400) t23400Award = obj.get("awardPoints").getAsInt();
            if (t == 11115) t11115Award = obj.get("awardPoints").getAsInt();
            if (t == 4001) a1Round2Pts = obj.get("alliancePoints").getAsInt();
        }
        assertEquals(60, t23400Award);
        assertEquals(12, t11115Award);
        assertEquals(9, a1Round2Pts);
    }

    @Test
    @DisplayName("Double Elimination bracket series 3 ('Lower Bracket Round 2 Match 3') is NOT misclassified as Finals")
    void testDoubleEliminationPlayoffBracketScoring() {
        JsonArray rankings = new JsonArray();
        int[] teams = {15215, 30781, 32920, 15210, 19584, 18611, 24736, 22407};
        for (int i = 0; i < teams.length; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("rank", i + 1);
            r.addProperty("teamNumber", teams[i]);
            rankings.add(r);
        }

        // Exact AUADQ 2025 DECODE Double Elimination schedule shape
        JsonArray matches = new JsonArray();
        matches.add(createPlayoffMatch(1, 1, "Upper Bracket  Round 1 Match 1", 15215, 19584, 110, 58));
        matches.add(createPlayoffMatch(2, 1, "Upper Bracket  Round 1 Match 2", 32920, 24736, 67, 54));
        matches.add(createPlayoffMatch(3, 1, "Lower Bracket  Round 2 Match 3", 19584, 24736, 75, 71));
        matches.add(createPlayoffMatch(4, 1, "Upper Bracket  Round 2 Match 4", 15215, 32920, 122, 71));
        matches.add(createPlayoffMatch(5, 1, "Lower Bracket  Round 3 Match 5", 32920, 19584, 141, 71));
        matches.add(createPlayoffMatch(6, 1, "Final Bracket  Round 4 Match 6", 15215, 32920, 123, 54));

        JsonArray adv = AdvancementCalculator.calculateAdvancement(rankings, new JsonArray(), new JsonArray(), matches, 5);
        assertEquals(8, adv.size());
        java.util.Map<Integer, JsonObject> byTeam = new java.util.HashMap<>();
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            byTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }
        assertNotNull(byTeam.get(15215));
        assertNotNull(byTeam.get(32920));
        assertNotNull(byTeam.get(19584));
        assertNotNull(byTeam.get(24736));
        assertEquals(40, byTeam.get(15215).get("playoffPoints").getAsInt(), "Final Bracket winner gets 40");
        assertEquals(20, byTeam.get(32920).get("playoffPoints").getAsInt(), "Final Bracket loser gets 20");
        assertEquals(10, byTeam.get(19584).get("playoffPoints").getAsInt(), "Lower Bracket Final loser gets 10 (NOT 40!)");
        assertEquals(5, byTeam.get(24736).get("playoffPoints").getAsInt(), "Lower Bracket Round 2 loser gets 5 (NOT 20!)");
    }

    @Test
    @DisplayName("Applies FTC official advancement roll-down for ALREADY_ADVANCING, DECLINED, and INELIGIBLE")
    void testOfficialAdvancementRollDownStatuses() {
        JsonArray rankings = new JsonArray();
        int[] teams = {30781, 15215, 18611, 32920, 15210, 24736, 22407, 19584};
        for (int i = 0; i < teams.length; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("rank", i + 1);
            r.addProperty("teamNumber", teams[i]);
            rankings.add(r);
        }

        // Exact AUADQ-style roll-down + DECLINED & INELIGIBLE cases with slots=3:
        // #1 (30781): ALREADY_ADVANCING (skipped)
        // #2 (15215): FIRST -> ADVANCING (rolledDown=false)
        // #3 (18611): declined=true -> DECLINED (skipped)
        // #4 (32920): INELIGIBLE -> INELIGIBLE (skipped)
        // #5 (15210): FIRST (also appears later as ADVANCING_ABOVE) -> ADVANCING, rolledDown=true
        // #6 (24736): FIRST (slot=6) -> ADVANCING, rolledDown=true
        // #7 (22407), #8 (19584): BUBBLE
        String officialJson = """
                {
                  "advancesTo": "AUCMP",
                  "slots": 3,
                  "fcmpReserved": 0,
                  "advancement": [
                    {"team": 30781, "displayTeam": "30781", "slot": 1, "criteria": "Points", "declined": false, "status": "ALREADY_ADVANCING"},
                    {"team": 15215, "displayTeam": "15215", "slot": 2, "criteria": "Points", "declined": false, "status": "FIRST"},
                    {"team": 18611, "displayTeam": "18611", "slot": 3, "criteria": "Points", "declined": true, "status": "FIRST"},
                    {"team": 32920, "displayTeam": "32920", "slot": 4, "criteria": "Points", "declined": false, "status": "INELIGIBLE"},
                    {"team": 15210, "displayTeam": "15210", "slot": 5, "criteria": "Points", "declined": false, "status": "FIRST"},
                    {"team": 24736, "displayTeam": "24736", "slot": 6, "criteria": "Points", "declined": false, "status": "FIRST"},
                    {"team": 15210, "displayTeam": "15210", "slot": 7, "criteria": "Winning Alliance", "declined": false, "status": "ADVANCING_ABOVE"}
                  ]
                }
                """;
        JsonObject rawOfficial = com.google.gson.JsonParser.parseString(officialJson).getAsJsonObject();

        JsonArray adv = AdvancementCalculator.calculateAdvancement(
                rankings, new JsonArray(), new JsonArray(), new JsonArray(), 3, rawOfficial, false);

        assertEquals(8, adv.size());

        java.util.Map<Integer, JsonObject> byTeam = new java.util.HashMap<>();
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            byTeam.put(obj.get("teamNumber").getAsInt(), obj);
        }

        assertEquals("ALREADY_ADVANCING", byTeam.get(30781).get("advancementStatus").getAsString());
        assertFalse(byTeam.get(30781).get("rolledDown").getAsBoolean());
        assertEquals("AUCMP", byTeam.get(30781).get("advancesTo").getAsString());

        assertEquals("ADVANCING", byTeam.get(15215).get("advancementStatus").getAsString());
        assertFalse(byTeam.get(15215).get("rolledDown").getAsBoolean());

        assertEquals("DECLINED", byTeam.get(18611).get("advancementStatus").getAsString());
        assertTrue(byTeam.get(18611).get("declined").getAsBoolean());

        assertEquals("INELIGIBLE", byTeam.get(32920).get("advancementStatus").getAsString());

        // Duplicate entry with ADVANCING_ABOVE did not overwrite FIRST slot 5
        assertEquals("ADVANCING", byTeam.get(15210).get("advancementStatus").getAsString());
        assertEquals("FIRST", byTeam.get(15210).get("officialStatus").getAsString());
        assertEquals(5, byTeam.get(15210).get("advancementSlot").getAsInt());
        assertTrue(byTeam.get(15210).get("rolledDown").getAsBoolean());

        // Rolled down slot 6 -> rank 6 qualifies when 3 active slots exist
        assertEquals("ADVANCING", byTeam.get(24736).get("advancementStatus").getAsString());
        assertTrue(byTeam.get(24736).get("rolledDown").getAsBoolean());

        assertEquals("BUBBLE", byTeam.get(22407).get("advancementStatus").getAsString());
        assertEquals("BUBBLE", byTeam.get(19584).get("advancementStatus").getAsString());
    }

    @Test
    @DisplayName("Direct call falls back to official Slots when advancementSlots <= 0 and supports PascalCase + null fields")
    void testDirectCallSlotsFallbackAndPascalCaseSupport() {
        JsonArray rankings = new JsonArray();
        for (int i = 1; i <= 4; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("TeamNumber", 1000 + i);
            r.addProperty("Rank", i);
            r.addProperty("SortOrder1", 100.0 - i);
            rankings.add(r);
        }

        JsonArray alliances = new JsonArray();
        JsonObject al = new JsonObject();
        al.addProperty("Number", 1);
        JsonObject cap = new JsonObject();
        cap.addProperty("Team", 1001);
        al.add("Captain", cap);
        alliances.add(al);

        JsonArray awards = new JsonArray();
        JsonObject aw = new JsonObject();
        aw.addProperty("TeamNumber", 1002);
        aw.addProperty("Name", "Inspire Award");
        aw.addProperty("Series", 1);
        awards.add(aw);

        JsonArray matches = new JsonArray();
        JsonObject m = new JsonObject();
        m.addProperty("TournamentLevel", "PLAYOFF");
        m.add("MatchNum", com.google.gson.JsonNull.INSTANCE);
        m.addProperty("Description", "Finals 1");
        JsonObject scores = new JsonObject();
        JsonObject red = new JsonObject();
        red.addProperty("FinalScore", 120);
        JsonObject blue = new JsonObject();
        blue.addProperty("FinalScore", 80);
        scores.add("Red", red);
        scores.add("Blue", blue);
        m.add("Scores", scores);
        JsonArray mTeams = new JsonArray();
        JsonObject mt1 = new JsonObject();
        mt1.addProperty("TeamNumber", 1001);
        mt1.addProperty("Alliance", "Red");
        JsonObject mt2 = new JsonObject();
        mt2.addProperty("TeamNumber", 1003);
        mt2.addProperty("Alliance", "Blue");
        mTeams.add(mt1);
        mTeams.add(mt2);
        m.add("Teams", mTeams);
        matches.add(m);

        JsonObject officialAdv = com.google.gson.JsonParser.parseString("{\"Slots\":2,\"AdvancesTo\":\"CMP\",\"Advancement\":[]}").getAsJsonObject();

        // advancementSlots = -1 -> falls back to official Slots = 2 (top 2 ADVANCING, #3/#4 BUBBLE)
        JsonArray adv = AdvancementCalculator.calculateAdvancement(
                rankings, alliances, awards, matches, -1, officialAdv, false);
        assertEquals(4, adv.size());
        int advancingCount = 0;
        for (int i = 0; i < adv.size(); i++) {
            JsonObject obj = adv.get(i).getAsJsonObject();
            if ("ADVANCING".equals(obj.get("advancementStatus").getAsString())) {
                advancingCount++;
            }
        }
        assertEquals(2, advancingCount);
    }
}
