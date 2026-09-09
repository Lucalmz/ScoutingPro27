package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.ScheduleDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.MatchScheduleItem;
import com.bear27570.app.model.ScoutAssignment;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.User;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ScheduleDaoTest {
    private Jdbi jdbi;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_schedule_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";

        Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db")
                .load()
                .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        // Prepare a host user and an event
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host_1", "hostuser");
            host.setPassword("pass");
            dao.upsert(host);

            User scout1 = new User("scout_1", "scoutAlice");
            scout1.setPassword("pass");
            dao.upsert(scout1);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("evt_1");
            e.setName("FTC Championship 2026");
            e.setInviteCode("SCHED1");
            e.setHostId("host_1");
            e.setFtcYear(2026);
            e.setFtcEventCode("CNCMP");
            dao.insert(e);
        });
    }

    @Test
    void testScheduleUpsertAndQuery() {
        jdbi.useExtension(ScheduleDao.class, dao -> {
            MatchScheduleItem m1 = new MatchScheduleItem("m_1", "evt_1", 1, "QUALIFICATION", 18223, 27570, 25787, 11115);
            MatchScheduleItem m2 = new MatchScheduleItem("m_2", "evt_1", 2, "QUALIFICATION", 11115, 18223, 27570, 25787);

            dao.upsertSchedule(m1);
            dao.upsertSchedule(m2);

            List<MatchScheduleItem> list = dao.findSchedulesByEvent("evt_1");
            assertThat(list).hasSize(2);
            assertThat(list.get(0).getMatchNumber()).isEqualTo(1);
            assertThat(list.get(0).getRed1()).isEqualTo(18223);
            assertThat(list.get(1).getMatchNumber()).isEqualTo(2);

            // Test update match 1 teams
            MatchScheduleItem m1Updated = new MatchScheduleItem("m_1_new", "evt_1", 1, "QUALIFICATION", 99999, 27570, 25787, 11115);
            dao.upsertSchedule(m1Updated);

            List<MatchScheduleItem> listAfter = dao.findSchedulesByEvent("evt_1");
            assertThat(listAfter).hasSize(2);
            assertThat(listAfter.get(0).getRed1()).isEqualTo(99999);
        });
    }

    @Test
    void testScoutAssignmentsSupportsUnassigned() {
        jdbi.useExtension(ScheduleDao.class, dao -> {
            // Station 1: Unassigned (留空)
            ScoutAssignment a1 = new ScoutAssignment("a_1", "evt_1", 1, "QUALIFICATION", "red1", 18223, null, null);
            // Station 2: Assigned to scout_1
            ScoutAssignment a2 = new ScoutAssignment("a_2", "evt_1", 1, "QUALIFICATION", "red2", 27570, "scout_1", "scoutAlice");

            dao.upsertAssignment(a1);
            dao.upsertAssignment(a2);

            List<ScoutAssignment> all = dao.findAssignmentsByEvent("evt_1");
            assertThat(all).hasSize(2);

            ScoutAssignment red1 = all.stream().filter(a -> a.getStation().equals("red1")).findFirst().orElseThrow();
            assertThat(red1.getScoutId()).isNull();
            assertThat(red1.getScoutName()).isNull();
            assertThat(red1.getTeamNumber()).isEqualTo(18223);

            ScoutAssignment red2 = all.stream().filter(a -> a.getStation().equals("red2")).findFirst().orElseThrow();
            assertThat(red2.getScoutId()).isEqualTo("scout_1");
            assertThat(red2.getScoutName()).isEqualTo("scoutAlice");

            // Query by scout
            List<ScoutAssignment> byScout = dao.findAssignmentsByScout("evt_1", "scout_1");
            assertThat(byScout).hasSize(1);
            assertThat(byScout.get(0).getTeamNumber()).isEqualTo(27570);

            // Clear assignment back to unassigned (留空)
            ScoutAssignment a2Cleared = new ScoutAssignment("a_2", "evt_1", 1, "QUALIFICATION", "red2", 27570, null, null);
            dao.upsertAssignment(a2Cleared);

            List<ScoutAssignment> afterClear = dao.findAssignmentsByEvent("evt_1");
            ScoutAssignment red2After = afterClear.stream().filter(a -> a.getStation().equals("red2")).findFirst().orElseThrow();
            assertThat(red2After.getScoutId()).isNull();
        });
    }

    @Test
    void testCascadeDelete() {
        jdbi.useExtension(ScheduleDao.class, dao -> {
            dao.upsertSchedule(new MatchScheduleItem("m_1", "evt_1", 1, "QUALIFICATION", 18223, 27570, 25787, 11115));
            dao.upsertAssignment(new ScoutAssignment("a_1", "evt_1", 1, "QUALIFICATION", "red1", 18223, "scout_1", "scoutAlice"));
        });

        // Delete the event
        jdbi.useExtension(EventDao.class, dao -> dao.delete("evt_1"));

        // Schedules and assignments should be cascaded
        jdbi.useExtension(ScheduleDao.class, dao -> {
            assertThat(dao.findSchedulesByEvent("evt_1")).isEmpty();
            assertThat(dao.findAssignmentsByEvent("evt_1")).isEmpty();
        });
    }

    @Test
    void testSuperLongCompositeIdsForSuperEvent() {
        String uuidEventId = "b2609bb0-e0cb-4d43-9878-831e5e042be6";
        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId(uuidEventId);
            e.setName("Super Regional World Championship 2026");
            e.setInviteCode("SUPER1");
            e.setHostId("host_1");
            e.setFtcYear(2026);
            e.setFtcEventCode("WORLDS");
            dao.insert(e);
        });

        jdbi.useExtension(ScheduleDao.class, dao -> {
            // Test ID length > 36 chars (which previously crashed with VARCHAR(36) overflow)
            String superLongMatchId = uuidEventId + "_SUPER_DIVISION_CHAMPIONSHIP_QUALIFICATION_MATCH_NUMBER_9999_EXTRA_LONG_IDENTIFIER";
            String superLongAssignId = uuidEventId + "_SUPER_DIVISION_CHAMPIONSHIP_QUALIFICATION_MATCH_NUMBER_9999_STATION_BLUE2_RESERVED";

            MatchScheduleItem m = new MatchScheduleItem(superLongMatchId, uuidEventId, 9999, "QUALIFICATION", 18223, 27570, 25787, 11115);
            dao.upsertSchedule(m);

            ScoutAssignment a = new ScoutAssignment(superLongAssignId, uuidEventId, 9999, "QUALIFICATION", "blue2", 11115, "scout_uuid_12345", "SuperScout");
            dao.upsertAssignment(a);

            List<MatchScheduleItem> schedules = dao.findSchedulesByEvent(uuidEventId);
            assertThat(schedules).hasSize(1);
            assertThat(schedules.get(0).getId()).isEqualTo(superLongMatchId);

            List<ScoutAssignment> assignments = dao.findAssignmentsByEvent(uuidEventId);
            assertThat(assignments).hasSize(1);
            assertThat(assignments.get(0).getId()).isEqualTo(superLongAssignId);
        });
    }

    @Test
    void testFindAssignmentAndPreserveScout() {
        jdbi.useExtension(ScheduleDao.class, dao -> {
            ScoutAssignment a = new ScoutAssignment("a_test", "evt_1", 1, "QUALIFICATION", "red1", 18223, "scout_1", "ScoutAlice");
            dao.upsertAssignment(a);

            ScoutAssignment found = dao.findAssignment("evt_1", 1, "QUALIFICATION", "red1");
            assertThat(found).isNotNull();
            assertThat(found.getScoutId()).isEqualTo("scout_1");
            assertThat(found.getScoutName()).isEqualTo("ScoutAlice");
            assertThat(found.getTeamNumber()).isEqualTo(18223);

            ScoutAssignment notFound = dao.findAssignment("evt_1", 99, "QUALIFICATION", "blue2");
            assertThat(notFound).isNull();
        });
    }

    @Test
    void testPlayoffQualificationIdCollision() {
        jdbi.useExtension(ScheduleDao.class, dao -> {
            // Fixed ID generation: including tournamentLevel:
            String qualId = "evt_1_QUALIFICATION_1_red1";
            String playoffId = "evt_1_PLAYOFF_1_red1"; // No collision!

            ScoutAssignment qualAssign = new ScoutAssignment(qualId, "evt_1", 1, "QUALIFICATION", "red1", 18223, null, null);
            dao.upsertAssignment(qualAssign);

            // Now playoff match 1 red1 comes along with distinct ID:
            ScoutAssignment playoffAssign = new ScoutAssignment(playoffId, "evt_1", 1, "PLAYOFF", "red1", 27570, null, null);
            dao.upsertAssignment(playoffAssign);

            List<ScoutAssignment> list = dao.findAssignmentsByEvent("evt_1");
            assertThat(list).hasSize(2);
        });
    }
}

