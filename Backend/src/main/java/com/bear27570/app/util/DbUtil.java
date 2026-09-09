package com.bear27570.app.util;

import java.sql.SQLException;

/**
 * 数据库操作事务与死锁自愈工具。
 * 针对并发写入时产生的 transient deadlock (H2/PostgreSQL SQLState 40001) 提供退避重试。
 */
public class DbUtil {

    public static final Object RECORD_WRITE_LOCK = new Object();

    @FunctionalInterface
    public interface DbAction {
        void run() throws Exception;
    }

    @FunctionalInterface
    public interface DbCallable<T> {
        T call() throws Exception;
    }

    public static void withDeadlockRetry(DbAction action) throws Exception {
        withDeadlockRetry(5, 40L, action);
    }

    public static <T> T withDeadlockRetry(DbCallable<T> callable) throws Exception {
        return withDeadlockRetry(5, 40L, callable);
    }

    public static <T> T withDeadlockRetry(int maxRetries, long baseDelayMs, DbCallable<T> callable) throws Exception {
        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return callable.call();
            } catch (Exception e) {
                if (isDeadlockException(e) && attempt < maxRetries) {
                    try {
                        long sleepMs = baseDelayMs * attempt + (long) (Math.random() * baseDelayMs);
                        Thread.sleep(sleepMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw e;
                    }
                    continue;
                }
                throw e;
            }
        }
        throw new IllegalStateException("Exceeded retry attempts without return or exception");
    }

    public static void withDeadlockRetry(int maxRetries, long baseDelayMs, DbAction action) throws Exception {
        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                action.run();
                return;
            } catch (Exception e) {
                if (isDeadlockException(e) && attempt < maxRetries) {
                    try {
                        long sleepMs = baseDelayMs * attempt + (long) (Math.random() * baseDelayMs);
                        Thread.sleep(sleepMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw e;
                    }
                    continue;
                }
                throw e;
            }
        }
    }

    public static boolean isDeadlockException(Throwable t) {
        while (t != null) {
            if (t instanceof org.h2.jdbc.JdbcSQLTransactionRollbackException) {
                return true;
            }
            if (t instanceof SQLException) {
                String state = ((SQLException) t).getSQLState();
                if (state != null && state.startsWith("40")) {
                    return true;
                }
            }
            String msg = t.getMessage();
            if (msg != null && (msg.toLowerCase().contains("deadlock") || msg.contains("40001"))) {
                return true;
            }
            t = t.getCause();
        }
        return false;
    }
}
