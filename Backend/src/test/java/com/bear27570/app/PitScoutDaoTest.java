package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.PitScoutDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.OfficialTeam;
import com.bear27570.app.model.PitScoutingRecord;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PitScoutDaoTest {
    private Jdbi jdbi;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_pitscout_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        // Prepare host and event
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host_1", "hostuser");
            host.setPassword("pass");
            dao.upsert(host);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("evt_pit");
            e.setName("FTC Test Championship");
            e.setInviteCode("PIT123");
            e.setHostId("host_1");
            e.setFtcYear(2026);
            e.setFtcEventCode("CNCMP");
            dao.insert(e);
        });
    }

    @Test
    void testPitScoutRecordUpsertAndQuery() {
        PitScoutingRecord record = new PitScoutingRecord();
        record.setId("pit_rec_1");
        record.setEventId("evt_pit");
        record.setTeamNumber(27570);
        record.setScoutId("host_1");
        record.setScoutName("hostuser");
        record.setRobotName("Polaris");
        record.setDrivetrainType("mecanum");
        record.setWeightLbs(38.5);
        record.setSizingPassed(true);
        record.setMechanismType("slide_claw");
        record.setHangType("winch");
        record.setOdometryType("two_wheel");
        record.setClaimedAutoScore(85);
        record.setClaimedAutoPieces(3);
        record.setClaimedAutoHangLevel(1);
        record.setClaimedTeleopScore(110);
        record.setClaimedTeleopCycleSec(8.5);
        record.setClaimedEndgameHangLevel(3);
        record.setClaimedEndgameTimeSec(4.0);
        record.setClaimedTotalScore(195);
        record.setVersion(1);

        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        // Query back
        PitScoutingRecord fetched = jdbi.withExtension(PitScoutDao.class, dao -> dao.findPitRecordByTeam("evt_pit", 27570));
        assertThat(fetched).isNotNull();
        assertThat(fetched.getTeamNumber()).isEqualTo(27570);
        assertThat(fetched.getRobotName()).isEqualTo("Polaris");
        assertThat(fetched.getWeightLbs()).isEqualTo(38.5);
        assertThat(fetched.getClaimedAutoScore()).isEqualTo(85);
        assertThat(fetched.getClaimedEndgameHangLevel()).isEqualTo(3);
        assertThat(fetched.getClaimedTotalScore()).isEqualTo(195);

        // Update record (LWW / edit)
        record.setClaimedAutoScore(95);
        record.setVersion(2);
        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        PitScoutingRecord updated = jdbi.withExtension(PitScoutDao.class, dao -> dao.findPitRecordByTeam("evt_pit", 27570));
        assertThat(updated).isNotNull();
        assertThat(updated.getClaimedAutoScore()).isEqualTo(95);
        assertThat(updated.getVersion()).isEqualTo(2);
    }

    @Test
    void testSoftDeleteAndActiveQuery() {
        PitScoutingRecord record = new PitScoutingRecord();
        record.setId("pit_rec_del");
        record.setEventId("evt_pit");
        record.setTeamNumber(11111);
        record.setScoutId("host_1");
        record.setScoutName("hostuser");
        record.setDrivetrainType("tank");
        record.setClaimedAutoScore(50);
        record.setVersion(1);

        jdbi.useExtension(PitScoutDao.class, dao -> dao.upsertPitRecord(record));

        List<PitScoutingRecord> activeList = jdbi.withExtension(PitScoutDao.class, dao -> dao.findActivePitRecordsByEvent("evt_pit"));
        assertThat(activeList).hasSize(1);

        // Soft delete
        jdbi.useExtension(PitScoutDao.class, dao -> dao.softDeletePitRecord("evt_pit", 11111));

        List<PitScoutingRecord> activeAfter = jdbi.withExtension(PitScoutDao.class, dao -> dao.findActivePitRecordsByEvent("evt_pit"));
        assertThat(activeAfter).isEmpty();

        List<PitScoutingRecord> allAfter = jdbi.withExtension(PitScoutDao.class, dao -> dao.findAllPitRecordsByEvent("evt_pit"));
        assertThat(allAfter).hasSize(1);
        assertThat(allAfter.get(0).isDeleted()).isTrue();
    }

    @Test
    void testOfficialTeamsCache() {
        OfficialTeam t1 = new OfficialTeam("evt_pit", 27570, "B.E.A.R.", "Polaris", "Shenzhen", "China");
        OfficialTeam t2 = new OfficialTeam("evt_pit", 25787, "TechBY", "Byte", "Guangzhou", "China");

        jdbi.useExtension(PitScoutDao.class, dao -> {
            dao.upsertOfficialTeam(t1);
            dao.upsertOfficialTeam(t2);
        });

        List<OfficialTeam> teams = jdbi.withExtension(PitScoutDao.class, dao -> dao.findOfficialTeamsByEvent("evt_pit"));
        assertThat(teams).hasSize(2);
        assertThat(teams.get(0).getTeamNumber()).isEqualTo(25787);
        assertThat(teams.get(1).getTeamNumber()).isEqualTo(27570);
    }
}
