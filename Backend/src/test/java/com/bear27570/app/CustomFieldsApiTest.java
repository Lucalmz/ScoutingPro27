package com.bear27570.app;

import com.bear27570.app.dao.CustomFieldDao;
import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.CustomFieldDefinition;
import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CustomFieldsApiTest {

    @TempDir
    Path tempDir;

    private Jdbi jdbi;
    private ApiRoutes apiRoutes;
    private Javalin app;
    private String prevDataDir;

    @BeforeEach
    void setUp() {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();
        AESUtil.resetForTest();

        String url = "jdbc:h2:mem:test_custom_fields_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        apiRoutes = new ApiRoutes(jdbi);
        app = Javalin.create(config -> apiRoutes.register(config.routes));
    }

    @AfterEach
    void tearDown() {
        try {
            if (apiRoutes != null) {
                apiRoutes.shutdown();
            }
            JdbiConfig.closeDataSources();
        } finally {
            JwtUtil.resetForTest();
            AESUtil.resetForTest();
            if (prevDataDir == null) {
                System.clearProperty("scouting.data.dir");
            } else {
                System.setProperty("scouting.data.dir", prevDataDir);
            }
        }
    }

    @Test
    void testPitScoutRawDataPersistence() {
        // Prepare host and event
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host_pit_raw", "host_pit");
            host.setPassword("pass");
            dao.upsert(host);
        });
        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("evt_pit_raw");
            e.setName("Pit Raw Event");
            e.setHostId("host_pit_raw");
            dao.insert(e);
        });

        PitScoutingRecord record = new PitScoutingRecord();
        record.setId("pit_rec_raw_1");
        record.setEventId("evt_pit_raw");
        record.setTeamNumber(27570);
        record.setScoutId("host_pit_raw");
        record.setScoutName("HostScout");
        record.setDrivetrainType("swerve");
        record.setRawData("{\"customFields\":{\"flower_speed\":5,\"battery_voltage\":12.8}}");

        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        PitScoutingRecord loaded = jdbi.withExtension(PitScoutDao.class, dao -> dao.findPitRecordByTeam("evt_pit_raw", 27570));
        assertThat(loaded).isNotNull();
        assertThat(loaded.getRawData()).contains("\"battery_voltage\":12.8");
        assertThat(loaded.getRawData()).contains("\"flower_speed\":5");
    }

    @Test
    void testCustomFieldDaoDirectCrud() {
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("u_host", "host");
            dao.upsert(host);
        });
        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("evt_cf_dao");
            e.setName("CF DAO Event");
            e.setHostId("u_host");
            dao.insert(e);
        });

        CustomFieldDefinition def = new CustomFieldDefinition();
        def.setId("cf_1");
        def.setEventId("evt_cf_dao");
        def.setTarget("MATCH");
        def.setPhase("teleop");
        def.setName("飞手受压表现");
        def.setFieldKey("driver_pressure");
        def.setFieldType("level");
        def.setMaxVal(5.0);
        def.setOrderSeq(1);
        def.setActive(true);

        jdbi.useExtension(CustomFieldDao.class, dao -> dao.insert(def));

        List<CustomFieldDefinition> list = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findByEvent("evt_cf_dao"));
        assertThat(list).hasSize(1);
        assertThat(list.get(0).getName()).isEqualTo("飞手受压表现");
        assertThat(list.get(0).getFieldKey()).isEqualTo("driver_pressure");
        assertThat(list.get(0).getFieldType()).isEqualTo("level");

        // Update
        def.setName("飞手抗压 (更名)");
        jdbi.useExtension(CustomFieldDao.class, dao -> dao.update(def));

        CustomFieldDefinition updated = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findById("cf_1"));
        assertThat(updated.getName()).isEqualTo("飞手抗压 (更名)");

        // Delete
        jdbi.useExtension(CustomFieldDao.class, dao -> dao.delete("cf_1"));
        CustomFieldDefinition deleted = jdbi.withExtension(CustomFieldDao.class, dao -> dao.findById("cf_1"));
        assertThat(deleted).isNull();
    }

    @Test
    void testCustomFieldRoutesFullWorkflow() {
        JavalinTest.test(app, (server, client) -> {
            // 1. Host registers and logs in
            var hostReg = client.post("/api/user/register", "{\"username\":\"cf_host\", \"password\":\"pass123\"}");
            assertThat(hostReg.code()).isEqualTo(200);
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 2. Scout registers and logs in
            var scoutReg = client.post("/api/user/register", "{\"username\":\"cf_scout\", \"password\":\"pass123\"}");
            assertThat(scoutReg.code()).isEqualTo(200);
            String scoutToken = scoutReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 3. Outsider registers
            var outsiderReg = client.post("/api/user/register", "{\"username\":\"cf_outsider\", \"password\":\"pass123\"}");
            assertThat(outsiderReg.code()).isEqualTo(200);
            String outsiderToken = outsiderReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            // 4. Host creates an event
            var eventRes = client.post("/api/events", "{\"name\":\"FTC Championship CF\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(eventRes.code()).isEqualTo(200);
            String eventBody = eventRes.body().string();
            String eventId = eventBody.split("\"id\":\"")[1].split("\"")[0];
            String inviteCode = eventBody.split("\"inviteCode\":\"")[1].split("\"")[0];

            // 5. Scout joins event
            var joinRes = client.post("/api/events/join", "{\"inviteCode\":\"" + inviteCode + "\"}", b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(joinRes.code()).isEqualTo(200);

            // 6. Non-member (outsider) gets 403 on GET /api/events/:eventId/custom-fields
            var outsiderGet = client.get("/api/events/" + eventId + "/custom-fields", b -> b.header("Authorization", "Bearer " + outsiderToken));
            assertThat(outsiderGet.code()).isEqualTo(403);

            // 7. Non-host (scout) gets 403 on POST /api/events/:eventId/custom-fields
            String newFieldJson = """
                {
                    "target": "MATCH",
                    "phase": "teleop",
                    "name": "飞手抗压",
                    "fieldKey": "driver_level",
                    "fieldType": "level",
                    "maxVal": 5.0
                }
            """;
            var scoutPost = client.post("/api/events/" + eventId + "/custom-fields", newFieldJson, b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(scoutPost.code()).isEqualTo(403);

            // 8. Host creates field #1: LEVEL (飞手抗压)
            var hostPost1 = client.post("/api/events/" + eventId + "/custom-fields", newFieldJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(hostPost1.code()).isEqualTo(201);
            String f1Body = hostPost1.body().string();
            assertThat(f1Body).contains("\"name\":\"飞手抗压\"");
            assertThat(f1Body).contains("\"fieldKey\":\"driver_level\"");
            assertThat(f1Body).contains("\"fieldType\":\"level\"");
            String f1Id = f1Body.split("\"id\":\"")[1].split("\"")[0];

            // 9. Host creates field #2: NUMBER (卡球次数)
            String numFieldJson = """
                {
                    "target": "MATCH",
                    "phase": "teleop",
                    "name": "卡球次数",
                    "fieldKey": "ball_jammed",
                    "fieldType": "number",
                    "minVal": 0.0,
                    "maxVal": 10.0,
                    "stepVal": 1.0,
                    "unit": "次"
                }
            """;
            var hostPost2 = client.post("/api/events/" + eventId + "/custom-fields", numFieldJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(hostPost2.code()).isEqualTo(201);
            assertThat(hostPost2.body().string()).contains("\"unit\":\"次\"");

            // 10. Host creates field #3: SELECT (取球路线)
            String selectFieldJson = """
                {
                    "target": "MATCH",
                    "phase": "auto",
                    "name": "取球路线",
                    "fieldKey": "trench_route",
                    "fieldType": "select",
                    "optionsJson": "[{\\"label\\":\\"外圈\\",\\"value\\":\\"outer\\",\\"color\\":\\"blue\\"},{\\"label\\":\\"内圈\\",\\"value\\":\\"inner\\",\\"color\\":\\"green\\"}]"
                }
            """;
            var hostPost3 = client.post("/api/events/" + eventId + "/custom-fields", selectFieldJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(hostPost3.code()).isEqualTo(201);

            // 11. Duplicate fieldKey for same target is rejected with 400
            var dupPost = client.post("/api/events/" + eventId + "/custom-fields", numFieldJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(dupPost.code()).isEqualTo(400);
            assertThat(dupPost.body().string()).contains("already exists");

            // 12. Member (scout) can query all custom fields
            var scoutGet = client.get("/api/events/" + eventId + "/custom-fields", b -> b.header("Authorization", "Bearer " + scoutToken));
            assertThat(scoutGet.code()).isEqualTo(200);
            String listBody = scoutGet.body().string();
            assertThat(listBody).contains("driver_level");
            assertThat(listBody).contains("ball_jammed");
            assertThat(listBody).contains("trench_route");

            // 13. Host updates field #1
            String updateJson = """
                {
                    "target": "MATCH",
                    "phase": "teleop",
                    "name": "飞手抗压 (修改版)",
                    "fieldType": "level",
                    "maxVal": 5.0,
                    "isActive": true
                }
            """;
            var updateRes = client.put("/api/events/" + eventId + "/custom-fields/" + f1Id, updateJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(updateRes.code()).isEqualTo(200);
            assertThat(updateRes.body().string()).contains("飞手抗压 (修改版)");

            // 14. Host deletes field #1
            var delRes = client.delete("/api/events/" + eventId + "/custom-fields/" + f1Id, null, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(delRes.code()).isEqualTo(200);

            // 15. Verify deleted field is gone
            var afterDel = client.get("/api/events/" + eventId + "/custom-fields", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(afterDel.code()).isEqualTo(200);
            assertThat(afterDel.body().string()).doesNotContain("飞手抗压");
        });
    }

    @Test
    void testCustomFieldEdgeCasesAndValidation() {
        JavalinTest.test(app, (server, client) -> {
            // Register host and create event
            var hostReg = client.post("/api/user/register", "{\"username\":\"edge_host\", \"password\":\"pass123\"}");
            assertThat(hostReg.code()).isEqualTo(200);
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Edge Cases Event\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(eventRes.code()).isEqualTo(200);
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 1. Blank name rejected
            var blankNameRes = client.post("/api/events/" + eventId + "/custom-fields", "{\"name\":\"   \", \"target\":\"MATCH\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(blankNameRes.code()).isEqualTo(400);
            assertThat(blankNameRes.body().string()).contains("Field name is required");

            // 2. Name exceeding 100 characters rejected
            String longName = "A".repeat(101);
            var longNameRes = client.post("/api/events/" + eventId + "/custom-fields", "{\"name\":\"" + longName + "\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(longNameRes.code()).isEqualTo(400);
            assertThat(longNameRes.body().string()).contains("exceed 100 characters");

            // 3. Invalid target rejected
            var badTargetRes = client.post("/api/events/" + eventId + "/custom-fields", "{\"name\":\"Valid\", \"target\":\"ROBOT\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badTargetRes.code()).isEqualTo(400);
            assertThat(badTargetRes.body().string()).contains("Invalid target: must be 'MATCH', 'PIT', or 'TEAM'");

            // 4. Invalid fieldType rejected
            var badTypeRes = client.post("/api/events/" + eventId + "/custom-fields", "{\"name\":\"Valid\", \"fieldType\":\"magic_box\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badTypeRes.code()).isEqualTo(400);
            assertThat(badTypeRes.body().string()).contains("Invalid fieldType");

            // 5. Invalid fieldKey with illegal chars rejected
            var badKeyRes = client.post("/api/events/" + eventId + "/custom-fields", "{\"name\":\"Valid\", \"fieldKey\":\"illegal key!@#\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badKeyRes.code()).isEqualTo(400);
            assertThat(badKeyRes.body().string()).contains("letters, numbers, and underscores");

            // 6. Cross-target key coexistence: MATCH and PIT can share the same fieldKey without collision
            var matchFieldRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "MATCH",
                    "phase": "teleop",
                    "name": "Match Hanging Speed",
                    "fieldKey": "climb_speed",
                    "fieldType": "number"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(matchFieldRes.code()).isEqualTo(201);

            var pitFieldRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "PIT",
                    "phase": "hardware",
                    "name": "Pit Hanging Speed",
                    "fieldKey": "climb_speed",
                    "fieldType": "number"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(pitFieldRes.code()).isEqualTo(201);

            // 7. Update non-existent field returns 404
            var update404 = client.put("/api/events/" + eventId + "/custom-fields/non_existent_id", "{\"name\":\"Updated\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(update404.code()).isEqualTo(404);

            // 8. Delete non-existent field returns 404
            var delete404 = client.delete("/api/events/" + eventId + "/custom-fields/non_existent_id", null, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(delete404.code()).isEqualTo(404);
        });
    }

    @Test
    void testTeamFormulasTimerAndValidation400s() {
        JavalinTest.test(app, (server, client) -> {
            var hostReg = client.post("/api/user/register", "{\"username\":\"formula_host\", \"password\":\"pass123\"}");
            assertThat(hostReg.code()).isEqualTo(200);
            String hostToken = hostReg.body().string().split("\"token\":\"")[1].split("\"")[0];

            var eventRes = client.post("/api/events", "{\"name\":\"Formula Event\"}", b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(eventRes.code()).isEqualTo(200);
            String eventId = eventRes.body().string().split("\"id\":\"")[1].split("\"")[0];

            // 1. Timer field with description, configJson, aggregationMode, displayFormat
            String timerJson = """
                {
                    "target": "MATCH",
                    "phase": "teleop",
                    "name": "Cycle Stopwatch",
                    "fieldKey": "cycle_timer",
                    "fieldType": "timer",
                    "description": "Measure cycle time",
                    "configJson": "{\\"decimalPlaces\\":2}",
                    "aggregationMode": "median",
                    "displayFormat": "number"
                }
            """;
            var timerRes = client.post("/api/events/" + eventId + "/custom-fields", timerJson, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(timerRes.code()).isEqualTo(201);
            String timerBody = timerRes.body().string();
            assertThat(timerBody).contains("\"fieldType\":\"timer\"");
            assertThat(timerBody).contains("\"description\":\"Measure cycle time\"");
            assertThat(timerBody).contains("\"aggregationMode\":\"median\"");

            // 2. TEAM target rejects non-formula fieldType
            var teamNonFormula = client.post("/api/events/" + eventId + "/custom-fields", """
                {"target":"TEAM","name":"Bad Team Field","fieldKey":"bad_team","fieldType":"number"}
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(teamNonFormula.code()).isEqualTo(400);
            assertThat(teamNonFormula.body().string()).contains("TEAM custom fields must have fieldType 'formula'");

            // 3. Description > 300 chars rejected
            String longDesc = "d".repeat(301);
            var longDescRes = client.post("/api/events/" + eventId + "/custom-fields",
                    "{\"target\":\"MATCH\",\"name\":\"Desc Test\",\"fieldType\":\"number\",\"description\":\"" + longDesc + "\"}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(longDescRes.code()).isEqualTo(400);

            // 4. Invalid configJson (array instead of object, and > 8192 bytes)
            var badCfgArray = client.post("/api/events/" + eventId + "/custom-fields",
                    "{\"target\":\"MATCH\",\"name\":\"Cfg Test\",\"fieldType\":\"number\",\"configJson\":\"[1,2,3]\"}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badCfgArray.code()).isEqualTo(400);

            String hugeCfg = "{\"k\":\"" + "x".repeat(8200) + "\"}";
            var badCfgSize = client.post("/api/events/" + eventId + "/custom-fields",
                    "{\"target\":\"MATCH\",\"name\":\"Cfg Size\",\"fieldType\":\"number\",\"configJson\":" + new com.google.gson.Gson().toJson(hugeCfg) + "}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badCfgSize.code()).isEqualTo(400);

            // 5. Invalid aggregationMode & displayFormat
            var badAgg = client.post("/api/events/" + eventId + "/custom-fields",
                    "{\"target\":\"MATCH\",\"name\":\"Bad Agg\",\"fieldType\":\"number\",\"aggregationMode\":\"bogus\"}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badAgg.code()).isEqualTo(400);

            var badFmt = client.post("/api/events/" + eventId + "/custom-fields",
                    "{\"target\":\"MATCH\",\"name\":\"Bad Fmt\",\"fieldType\":\"number\",\"displayFormat\":\"bogus\"}",
                    b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(badFmt.code()).isEqualTo(400);

            // 6. Valid MATCH formula
            var matchFormulaRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "MATCH",
                    "phase": "overall",
                    "name": "Match Double Auto",
                    "fieldKey": "match_double",
                    "fieldType": "formula",
                    "formulaExpr": "match.autoScore * 2"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(matchFormulaRes.code()).isEqualTo(201);
            assertThat(matchFormulaRes.body().string()).contains("match.autoScore");

            // 7. Valid TEAM formula referencing MATCH formula + OPR
            var teamFormulaRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "TEAM",
                    "phase": "overall",
                    "name": "Team Power Index",
                    "fieldKey": "team_power",
                    "fieldType": "formula",
                    "formulaExpr": "formula.match_double + opr.np * 0.5",
                    "aggregationMode": "trimmed_avg",
                    "displayFormat": "tier"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(teamFormulaRes.code()).isEqualTo(201);
            String teamBody = teamFormulaRes.body().string();
            assertThat(teamBody).contains("\"aggregationMode\":\"trimmed_avg\"");
            assertThat(teamBody).contains("\"displayFormat\":\"tier\"");
            assertThat(teamBody).contains("formula.match_double");
            String teamFormulaId = teamBody.split("\"id\":\"")[1].split("\"")[0];

            // 8. Cross-layer reference rejected (MATCH referencing TEAM formula)
            var crossLayerRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "MATCH",
                    "name": "Illegal Cross",
                    "fieldKey": "illegal_cross",
                    "fieldType": "formula",
                    "formulaExpr": "formula.team_power + 1"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(crossLayerRes.code()).isEqualTo(400);
            assertThat(crossLayerRes.body().string()).contains("CROSS_LAYER_REFERENCE");

            // 9. Injection rejected
            var injectionRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "TEAM",
                    "name": "Injection",
                    "fieldKey": "inj_test",
                    "fieldType": "formula",
                    "formulaExpr": "__proto__.polluted + 1"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(injectionRes.code()).isEqualTo(400);
            assertThat(injectionRes.body().string()).contains("FORBIDDEN_IDENTIFIER");

            // 10. Self-cycle rejected on POST
            var selfCycleRes = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "TEAM",
                    "name": "Self Cycle",
                    "fieldKey": "self_cyc",
                    "fieldType": "formula",
                    "formulaExpr": "formula.self_cyc + 1"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(selfCycleRes.code()).isEqualTo(400);
            String selfCycleBody = selfCycleRes.body().string();
            assertThat(selfCycleBody).contains("CIRCULAR_DEPENDENCY");
            assertThat(selfCycleBody).contains("self_cyc");

            // 11. Two-node cycle rejected on PUT
            var f2Res = client.post("/api/events/" + eventId + "/custom-fields", """
                {
                    "target": "TEAM",
                    "name": "Team Helper",
                    "fieldKey": "team_helper",
                    "fieldType": "formula",
                    "formulaExpr": "formula.team_power + 1"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(f2Res.code()).isEqualTo(201);

            var cyclePutRes = client.put("/api/events/" + eventId + "/custom-fields/" + teamFormulaId, """
                {
                    "name": "Team Power Index",
                    "fieldType": "formula",
                    "formulaExpr": "formula.team_helper + 1"
                }
            """, b -> b.header("Authorization", "Bearer " + hostToken));
            assertThat(cyclePutRes.code()).isEqualTo(400);
            String cyclePutBody = cyclePutRes.body().string();
            assertThat(cyclePutBody).contains("CIRCULAR_DEPENDENCY");
            assertThat(cyclePutBody).contains("team_power");
            assertThat(cyclePutBody).contains("team_helper");
        });
    }
}
