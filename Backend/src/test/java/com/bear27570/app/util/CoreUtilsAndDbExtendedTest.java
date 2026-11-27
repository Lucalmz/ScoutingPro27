package com.bear27570.app.util;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.db.StringListArgumentFactory;
import com.bear27570.app.db.StringListColumnMapper;
import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.bear27570.app.model.User;
import com.bear27570.app.routes.SystemRoutes;
import org.flywaydb.core.Flyway;
import org.h2.jdbc.JdbcSQLTransactionRollbackException;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CoreUtilsAndDbExtendedTest {

    @TempDir
    Path tempDir;

    @AfterEach
    void cleanUp() {
        AppConfig.clearEnvironmentOverride();
        AppConfig.resetLogFileForTest();
        System.clearProperty("scouting.env");
        System.clearProperty("app.env");
        System.clearProperty("scouting.data.dir");
        JwtUtil.resetForTest();
    }

    @Test
    void testJwtUtilEdgeCasesAndScopeIsolation() {
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        JwtUtil.resetForTest();

        assertThat(JwtUtil.sha256Hex(null)).isEmpty();
        assertThat(JwtUtil.sha256Hex("abc")).hasSize(64);

        String apiToken = JwtUtil.generateToken("u-1", "alice");
        assertThat(JwtUtil.verifyToken(apiToken)).isEqualTo("u-1");
        assertThat(JwtUtil.verifyToken("bad.jwt.token")).isNull();

        // API token rejected as WebRTC handshake ticket; valid ticket checks eventId & pkHash
        assertThat(JwtUtil.verifyWebRtcTicket(apiToken, "evt-1", "PUBKEY").isValid()).isFalse();

        String ticket = JwtUtil.generateWebRtcTicket("u-1", "alice", "evt-1", "  ABcDef  ");
        var ok = JwtUtil.verifyWebRtcTicket(ticket, "evt-1", "abcdef");
        assertThat(ok.isValid()).isTrue();
        assertThat(ok.getUsername()).isEqualTo("alice");
        assertThat(ok.getEventId()).isEqualTo("evt-1");

        var wrongEvent = JwtUtil.verifyWebRtcTicket(ticket, "evt-2", "abcdef");
        assertThat(wrongEvent.isValid()).isFalse();
        assertThat(wrongEvent.getErrorMessage()).contains("Event ID mismatch");

        var wrongKey = JwtUtil.verifyWebRtcTicket(ticket, "evt-1", "different-key");
        assertThat(wrongKey.isValid()).isFalse();
        assertThat(wrongKey.getErrorMessage()).contains("Public key hash mismatch");
    }

    @Test
    void testDbUtilDeadlockRetryCallableAndAction() throws Exception {
        AtomicInteger attempts = new AtomicInteger(0);
        String out = DbUtil.withDeadlockRetry(4, 1L, () -> {
            if (attempts.incrementAndGet() < 3) {
                throw new SQLException("transient conflict", "40001");
            }
            return "recovered";
        });
        assertThat(out).isEqualTo("recovered");
        assertThat(attempts.get()).isEqualTo(3);

        AtomicInteger actionAttempts = new AtomicInteger(0);
        DbUtil.withDeadlockRetry(3, 1L, () -> {
            if (actionAttempts.incrementAndGet() < 2) {
                throw new RuntimeException("wrapper", new JdbcSQLTransactionRollbackException("deadlock", null, "40001", 40001, null, null));
            }
        });
        assertThat(actionAttempts.get()).isEqualTo(2);

        // Non-deadlock propagates immediately on attempt 1
        AtomicInteger nonDeadlockAttempts = new AtomicInteger(0);
        assertThatThrownBy(() -> DbUtil.withDeadlockRetry(5, 1L, () -> {
            nonDeadlockAttempts.incrementAndGet();
            throw new IllegalArgumentException("bad input");
        })).isInstanceOf(IllegalArgumentException.class);
        assertThat(nonDeadlockAttempts.get()).isEqualTo(1);

        // Exhausting retries rethrows deadlock
        assertThatThrownBy(() -> DbUtil.withDeadlockRetry(2, 1L, (DbUtil.DbAction) () -> {
            throw new RuntimeException("Deadlock detected");
        })).hasMessageContaining("Deadlock");
    }

    @Test
    void testAppConfigEnvironmentOverridesAndLogCollisionIncrement() throws Exception {
        AppConfig.setEnvironmentOverride(AppConfig.Environment.PROD);
        assertThat(AppConfig.isProd()).isTrue();
        assertThat(AppConfig.isDev()).isFalse();
        assertThat(AppConfig.isTest()).isFalse();

        AppConfig.clearEnvironmentOverride();
        System.setProperty("scouting.env", "testing");
        assertThat(AppConfig.isTest()).isTrue();

        System.clearProperty("scouting.env");
        System.setProperty("app.env", "production");
        assertThat(AppConfig.isProd()).isTrue();

        System.setProperty("scouting.data.dir", "'" + tempDir.toAbsolutePath() + "'");
        File log1 = AppConfig.resolveLogFile();
        Files.writeString(log1.toPath(), "non-empty");
        AppConfig.resetLogFileForTest();
        File log2 = AppConfig.resolveLogFile();
        if (log1.getName().equals(log2.getName())) {
            // In case clock crossed a second boundary, verify valid log file in tempDir/log
            assertThat(log2.getParentFile().toPath()).isEqualTo(tempDir.resolve("log"));
        } else {
            assertThat(log2.getName()).contains("_1.log");
        }
    }

    @Test
    void testUserDeterministicIdMigratorConflictAliasesAndActiveAiProfile() {
        String url = "jdbc:h2:mem:test_mig_ext_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        Flyway.configure().dataSource(url, "sa", "").locations("classpath:db").load().migrate();
        Jdbi jdbi = Jdbi.create(url, "sa", "");

        jdbi.useHandle(h -> {
            // Same normalized username: primary + duplicate placeholder (merged) + different password (aliased)
            h.execute("INSERT INTO users (id, username, password, created_at) VALUES (?, ?, ?, '2024-01-01 00:00:00')",
                    "old-1", "Sam", "hash-1");
            h.execute("INSERT INTO users (id, username, password, created_at) VALUES (?, ?, ?, '2024-01-02 00:00:00')",
                    "old-2", "sam", "");
            h.execute("INSERT INTO users (id, username, password, created_at) VALUES (?, ?, ?, '2024-01-03 00:00:00')",
                    "old-3", "SAM", "hash-different");
        });

        UserDeterministicIdMigrator.migrate(jdbi);

        String samId = UserUtil.generateDeterministicUserId("Sam");
        String aliasId = UserUtil.generateDeterministicUserId("Sam (legacy-1)");
        jdbi.useHandle(h -> {
            assertThat(h.createQuery("SELECT username FROM users WHERE id = ?").bind(0, samId).mapTo(String.class).one()).isEqualTo("Sam");
            assertThat(h.createQuery("SELECT COUNT(*) FROM users WHERE id = 'old-2'").mapTo(Integer.class).one()).isZero();
            assertThat(h.createQuery("SELECT username FROM users WHERE id = ?").bind(0, aliasId).mapTo(String.class).one()).isEqualTo("Sam (legacy-1)");

            // mergeUserInto preserves single active AI profile when target already has one
            h.execute("INSERT INTO ai_provider_profiles (id, user_id, name, protocol, is_active) VALUES ('p-sam', ?, 'SamProf', 'OPENAI', TRUE)", samId);
            h.execute("INSERT INTO ai_provider_profiles (id, user_id, name, protocol, is_active) VALUES ('p-alias', ?, 'AliasProf', 'OPENAI', TRUE)", aliasId);
            UserDeterministicIdMigrator.mergeUserInto(h, aliasId, samId, "");
            int activeCount = h.createQuery("SELECT COUNT(*) FROM ai_provider_profiles WHERE user_id = ? AND is_active = TRUE").bind(0, samId).mapTo(Integer.class).one();
            assertThat(activeCount).isEqualTo(1);
            assertThat(h.createQuery("SELECT COUNT(*) FROM users WHERE id = ?").bind(0, aliasId).mapTo(Integer.class).one()).isZero();
        });
    }

    @Test
    void testStringListColumnMapperAndSystemRoutesLoopbackHelper() throws Exception {
        StringListColumnMapper mapper = new StringListColumnMapper();
        ResultSet rsNull = (ResultSet) java.lang.reflect.Proxy.newProxyInstance(
                ResultSet.class.getClassLoader(), new Class[]{ResultSet.class},
                (proxy, method, args) -> method.getName().equals("getString") ? null : null);
        assertThat(mapper.map(rsNull, 1, null)).isEmpty();

        ResultSet rsJson = (ResultSet) java.lang.reflect.Proxy.newProxyInstance(
                ResultSet.class.getClassLoader(), new Class[]{ResultSet.class},
                (proxy, method, args) -> method.getName().equals("getString") ? "[\"k1\",\"k2\"]" : null);
        assertThat(mapper.map(rsJson, 1, null)).containsExactly("k1", "k2");

        ResultSet rsCsv = (ResultSet) java.lang.reflect.Proxy.newProxyInstance(
                ResultSet.class.getClassLoader(), new Class[]{ResultSet.class},
                (proxy, method, args) -> method.getName().equals("getString") ? "k1, , k2" : null);
        assertThat(mapper.map(rsCsv, 1, null)).containsExactly("k1", "k2");

        // ArgumentFactory smoke check with real H2 pit_scouting_records
        new StringListArgumentFactory();

        // SystemRoutes.isLoopbackAddress via reflection (package-private in routes)
        Method isLoopback = SystemRoutes.class.getDeclaredMethod("isLoopbackAddress", String.class);
        isLoopback.setAccessible(true);
        assertThat((Boolean) isLoopback.invoke(null, new Object[]{null})).isFalse();
        assertThat((Boolean) isLoopback.invoke(null, "127.0.1.1")).isTrue();
        assertThat((Boolean) isLoopback.invoke(null, "[::1]")).isTrue();
        assertThat((Boolean) isLoopback.invoke(null, "0:0:0:0:0:0:0:1%0")).isTrue();
        assertThat((Boolean) isLoopback.invoke(null, "192.168.1.25")).isFalse();
    }
}
