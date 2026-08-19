package com.bear27570.app;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.model.User;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class DaoTest {
    private Jdbi jdbi;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        
        Flyway.configure()
            .dataSource(url, "sa", "")
            .locations("classpath:db")
            .load()
            .migrate();
        
        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());
    }

    @Test
    void testUserDao() {
        jdbi.useExtension(UserDao.class, dao -> {
            User u = new User("u1", "testuser");
            u.setPassword("pass");
            dao.upsert(u);
            User found = dao.findByUsername("testuser");
            assertThat(found).isNotNull();
            assertThat(found.getId()).isEqualTo("u1");
            assertThat(found.getPassword()).isEqualTo("pass");
        });
    }

    @Test
    void testEventDao() {
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host1", "hostuser");
            host.setPassword("pass");
            dao.upsert(host);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("e1");
            e.setName("Test Event");
            e.setInviteCode("CODE1");
            e.setHostId("host1");
            dao.insert(e);

            ScoutingEvent found = dao.findById("e1");
            assertThat(found).isNotNull();
            assertThat(found.getName()).isEqualTo("Test Event");

            ScoutingEvent byCode = dao.findByInviteCode("CODE1");
            assertThat(byCode).isNotNull();
        });
    }

    @Test
    void testRecordDaoTieBreakerAndVersionPrecedence() {
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host1", "hostuser");
            host.setPassword("pass");
            dao.upsert(host);
            User scoutA = new User("scoutA", "scoutA");
            scoutA.setPassword("pass");
            dao.upsert(scoutA);
            User scoutB = new User("scoutB", "scoutB");
            scoutB.setPassword("pass");
            dao.upsert(scoutB);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("e1");
            e.setName("Tie Breaker Event");
            e.setInviteCode("TIEBRK");
            e.setHostId("host1");
            dao.insert(e);
        });

        jdbi.useExtension(RecordDao.class, dao -> {
            // 1. Initial insert: version 1, totalScore = 100, host_seq = 5
            ScoutingRecord r1 = new ScoutingRecord();
            r1.setId("rec1");
            r1.setEventId("e1");
            r1.setScoutId("scoutA");
            r1.setScoutName("Scout A");
            r1.setMatchNumber(1);
            r1.setTeamNumber(27570);
            r1.setTotalScore(100);
            r1.setVersion(1);
            r1.setHostSeq(5);
            r1.setUpdatedAt("2026-08-14 10:00:00");
            dao.upsert(r1);

            ScoutingRecord fetched = dao.findById("rec1");
            assertThat(fetched).isNotNull();
            assertThat(fetched.getTotalScore()).isEqualTo(100);
            assertThat(fetched.getVersion()).isEqualTo(1);
            assertThat(fetched.getHostSeq()).isEqualTo(5);

            // 2. Higher version (version 2) should overwrite
            ScoutingRecord r2 = new ScoutingRecord();
            r2.setId("rec1");
            r2.setEventId("e1");
            r2.setScoutId("scoutA");
            r2.setScoutName("Scout A");
            r2.setMatchNumber(1);
            r2.setTeamNumber(27570);
            r2.setTotalScore(150);
            r2.setVersion(2);
            r2.setHostSeq(8);
            r2.setUpdatedAt("2026-08-14 10:05:00");
            dao.upsert(r2);

            fetched = dao.findById("rec1");
            assertThat(fetched.getTotalScore()).isEqualTo(150);
            assertThat(fetched.getVersion()).isEqualTo(2);
            assertThat(fetched.getHostSeq()).isEqualTo(8);

            // 3. Lower version (version 1) should be REJECTED (not overwrite)
            ScoutingRecord rOld = new ScoutingRecord();
            rOld.setId("rec1");
            rOld.setEventId("e1");
            rOld.setScoutId("scoutA");
            rOld.setScoutName("Scout A");
            rOld.setMatchNumber(1);
            rOld.setTeamNumber(27570);
            rOld.setTotalScore(50);
            rOld.setVersion(1);
            rOld.setUpdatedAt("2026-08-14 10:10:00");
            dao.upsert(rOld);

            fetched = dao.findById("rec1");
            assertThat(fetched.getTotalScore()).isEqualTo(150); // Still 150
            assertThat(fetched.getVersion()).isEqualTo(2);

            // 4. host_seq monotonicity: incoming null or smaller host_seq preserves existing
            ScoutingRecord r3 = new ScoutingRecord();
            r3.setId("rec1");
            r3.setEventId("e1");
            r3.setScoutId("scoutA");
            r3.setScoutName("Scout A");
            r3.setMatchNumber(1);
            r3.setTeamNumber(27570);
            r3.setTotalScore(200);
            r3.setVersion(3);
            r3.setHostSeq(3); // Smaller than 8
            r3.setUpdatedAt("2026-08-14 10:15:00");
            dao.upsert(r3);

            fetched = dao.findById("rec1");
            assertThat(fetched.getTotalScore()).isEqualTo(200);
            assertThat(fetched.getVersion()).isEqualTo(3);
            assertThat(fetched.getHostSeq()).isEqualTo(8); // Monotonically kept at 8

            // 5. Same version: newer updatedAt overwrites older updatedAt
            ScoutingRecord r4 = new ScoutingRecord();
            r4.setId("rec1");
            r4.setEventId("e1");
            r4.setScoutId("scoutA");
            r4.setScoutName("Scout A");
            r4.setMatchNumber(1);
            r4.setTeamNumber(27570);
            r4.setTotalScore(220);
            r4.setVersion(3); // Same version 3
            r4.setUpdatedAt("2026-08-14 10:20:00"); // Newer than 10:15:00
            dao.upsert(r4);

            fetched = dao.findById("rec1");
            assertThat(fetched.getTotalScore()).isEqualTo(220);

            // 6. Same version: older updatedAt is rejected
            ScoutingRecord r5 = new ScoutingRecord();
            r5.setId("rec1");
            r5.setEventId("e1");
            r5.setScoutId("scoutA");
            r5.setScoutName("Scout A");
            r5.setMatchNumber(1);
            r5.setTeamNumber(27570);
            r5.setTotalScore(210);
            r5.setVersion(3);
            r5.setUpdatedAt("2026-08-14 10:10:00"); // Older than 10:20:00
            dao.upsert(r5);

            fetched = dao.findById("rec1");
            assertThat(fetched.getTotalScore()).isEqualTo(220); // Not overwritten
        });
    }

    @Test
    void testFutureTimeClampingAndTombstoneGC() {
        jdbi.useExtension(UserDao.class, dao -> {
            User host = new User("host1", "hostuser");
            host.setPassword("pass");
            dao.upsert(host);
        });

        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("e1");
            e.setName("Time Event");
            e.setInviteCode("TIMEEVT");
            e.setHostId("host1");
            dao.insert(e);
        });

        jdbi.useExtension(RecordDao.class, dao -> {
            // 1. Future time clamping: updatedAt > 5 seconds in future gets clamped
            ScoutingRecord futureRecord = new ScoutingRecord();
            futureRecord.setId("future_rec");
            futureRecord.setEventId("e1");
            futureRecord.setScoutId("host1");
            futureRecord.setScoutName("Host");
            futureRecord.setMatchNumber(1);
            futureRecord.setTeamNumber(27570);
            futureRecord.setTotalScore(99);
            futureRecord.setVersion(1);
            // Set 1 hour in the future
            futureRecord.setUpdatedAt("2099-01-01 00:00:00");
            dao.upsert(futureRecord);

            ScoutingRecord fetched = dao.findById("future_rec");
            assertThat(fetched).isNotNull();
            assertThat(fetched.getUpdatedAt()).doesNotContain("2099-01-01"); // Clamped to server timestamp!

            // 2. Tombstone GC test
            // Insert active record
            ScoutingRecord active = new ScoutingRecord();
            active.setId("active_rec");
            active.setEventId("e1");
            active.setScoutId("host1");
            active.setScoutName("Host");
            active.setMatchNumber(2);
            active.setTeamNumber(27570);
            active.setIsDeleted(false);
            dao.upsert(active);

            // Insert recent tombstone (< 14 days)
            ScoutingRecord recentTombstone = new ScoutingRecord();
            recentTombstone.setId("recent_deleted");
            recentTombstone.setEventId("e1");
            recentTombstone.setScoutId("host1");
            recentTombstone.setScoutName("Host");
            recentTombstone.setMatchNumber(3);
            recentTombstone.setTeamNumber(27570);
            recentTombstone.setIsDeleted(true);
            dao.upsert(recentTombstone);

            // Insert expired tombstone (> 14 days ago) directly into table
            jdbi.useHandle(handle -> {
                handle.execute("""
                    INSERT INTO scouting_records (
                        id, event_id, scout_id, scout_name, match_number, team_number,
                        is_deleted, updated_at
                    ) VALUES (
                        'old_deleted', 'e1', 'host1', 'Host', 4, 27570,
                        TRUE, DATEADD('DAY', -20, CURRENT_TIMESTAMP)
                    )
                """);
            });

            // Run GC
            int purged = dao.purgeExpiredTombstones();
            assertThat(purged).isEqualTo(1);

            assertThat(dao.findById("active_rec")).isNotNull();
            assertThat(dao.findById("recent_deleted")).isNotNull();
            assertThat(dao.findById("old_deleted")).isNull(); // Purged!
        });
    }
}
