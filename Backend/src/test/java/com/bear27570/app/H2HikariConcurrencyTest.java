package com.bear27570.app;

import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.model.User;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sql.DataSource;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

public class H2HikariConcurrencyTest {

    @TempDir
    File tempDir;

    @AfterEach
    void tearDown() {
        JdbiConfig.closeDataSources();
    }

    @Test
    void testConcurrentWritesAndReadsUnderHikariPool() throws Exception {
        File dbFile = new File(tempDir, "concurrency_test_db");
        String jdbcUrl = "jdbc:h2:" + dbFile.getAbsolutePath().replace('\\', '/') + ";AUTO_SERVER=TRUE;LOCK_TIMEOUT=15000;AUTO_RECONNECT=TRUE";

        // Initialize shared DataSource and migrate schema
        DataSource dataSource = JdbiConfig.getOrCreateDataSource(jdbcUrl, "sa", "");
        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db")
                .cleanDisabled(false)
                .load()
                .migrate();

        Jdbi jdbi = JdbiConfig.create(dataSource);

        int threadCount = 20;
        int operationsPerThread = 15;
        ExecutorService executor = Executors.newFixedThreadPool(threadCount);
        CountDownLatch latch = new CountDownLatch(1);
        List<Future<Integer>> futures = new ArrayList<>();
        AtomicInteger totalSuccess = new AtomicInteger(0);

        for (int i = 0; i < threadCount; i++) {
            final int threadIdx = i;
            futures.add(executor.submit(() -> {
                latch.await(); // ensure all 20 threads hit Jdbi at the exact same instant
                int count = 0;
                for (int op = 0; op < operationsPerThread; op++) {
                    String userId = "user_conc_" + threadIdx + "_" + op;
                    String username = "Scout_" + threadIdx + "_" + op;
                    jdbi.useExtension(UserDao.class, dao -> {
                        User u = new User(userId, username);
                        u.setPassword("pwd_" + threadIdx);
                        dao.upsert(u);
                    });

                    User found = jdbi.withExtension(UserDao.class, dao -> dao.findById(userId));
                    if (found != null && username.equals(found.getUsername())) {
                        count++;
                        totalSuccess.incrementAndGet();
                    }
                }
                return count;
            }));
        }

        // Fire all threads simultaneously
        latch.countDown();

        for (Future<Integer> future : futures) {
            future.get(30, TimeUnit.SECONDS);
        }

        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();

        int expectedTotal = threadCount * operationsPerThread;
        assertThat(totalSuccess.get()).isEqualTo(expectedTotal);

        // Verify total records in database
        int actualCount = jdbi.withHandle(h -> h.createQuery("SELECT COUNT(*) FROM users WHERE id LIKE 'user_conc_%'").mapTo(Integer.class).one());
        assertThat(actualCount).isEqualTo(expectedTotal);
    }
}
