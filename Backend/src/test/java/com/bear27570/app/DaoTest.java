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
        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("e1");
            e.setName("Test Event");
            e.setInviteCode("CODE1");
            e.setIsHost(true);
            dao.insert(e);

            ScoutingEvent found = dao.findById("e1");
            assertThat(found).isNotNull();
            assertThat(found.getName()).isEqualTo("Test Event");

            ScoutingEvent byCode = dao.findByInviteCode("CODE1");
            assertThat(byCode).isNotNull();
        });
    }

    @Test
    void testRecordDao() {
        // 先插入 event（外键依赖）
        jdbi.useExtension(EventDao.class, dao -> {
            ScoutingEvent e = new ScoutingEvent();
            e.setId("e1");
            e.setName("FK Event");
            e.setInviteCode("ZZZZZZ");
            e.setIsHost(true);
            dao.insert(e);
        });

        jdbi.useExtension(RecordDao.class, dao -> {
            ScoutingRecord r = new ScoutingRecord();
            r.setId("r1");
            r.setEventId("e1");
            r.setScoutId("scout1");
            r.setScoutName("TestScout");
            r.setMatchNumber(1);
            r.setTeamNumber(254);
            r.setSyncStatus("PENDING");
            dao.upsert(r);

            List<ScoutingRecord> pending = dao.findPendingByEventId("e1");
            assertThat(pending).hasSize(1);

            dao.markSynced("r1");
            List<ScoutingRecord> pendingAfter = dao.findPendingByEventId("e1");
            assertThat(pendingAfter).isEmpty();
        });
    }
}
