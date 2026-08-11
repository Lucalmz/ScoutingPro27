package com.bear27570.app;

import com.bear27570.app.model.ScoutingEvent;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.Test;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.assertTrue;

public class JdbiMapperTest {
    @Test
    public void testIsHostMapper() {
        Jdbi jdbi = Jdbi.create("jdbc:h2:mem:test");
        jdbi.installPlugin(new SqlObjectPlugin());
        jdbi.useHandle(h -> {
            h.execute("CREATE TABLE events (id VARCHAR(36) PRIMARY KEY, name VARCHAR(100), invite_code VARCHAR(10), is_host BOOLEAN NOT NULL)");
            h.execute("INSERT INTO events (id, name, invite_code, is_host) VALUES (?, ?, ?, ?)", UUID.randomUUID().toString(), "Test", "123", true);
            
            ScoutingEvent event = h.createQuery("SELECT * FROM events").mapToBean(ScoutingEvent.class).one();
        });
    }
}
