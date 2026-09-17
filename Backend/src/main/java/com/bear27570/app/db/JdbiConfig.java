package com.bear27570.app.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;

import javax.sql.DataSource;
import java.util.concurrent.ConcurrentHashMap;

/**
 * JDBI 配置工厂（集成 HikariCP 高性能连接池）。
 * 杜绝多线程环境下频繁调用 DriverManager.getConnection 导致 H2 产生
 * "Database may be already in use", "Lock file recently modified", "Concurrent update" 锁竞争崩溃。
 */
public class JdbiConfig {

    private static final ConcurrentHashMap<String, HikariDataSource> DATA_SOURCES = new ConcurrentHashMap<>();

    /**
     * 获取或创建与指定 JDBC URL 绑定的 HikariCP 单例连接池。
     */
    public static HikariDataSource getOrCreateDataSource(String url, String user, String password) {
        String key = (url != null ? url : "") + "|" + (user != null ? user : "");
        return DATA_SOURCES.computeIfAbsent(key, k -> {
            HikariConfig config = new HikariConfig();
            config.setJdbcUrl(url);
            config.setUsername(user);
            config.setPassword(password);
            config.setMaximumPoolSize(10);
            config.setMinimumIdle(2);
            config.setConnectionTimeout(10000);
            config.setIdleTimeout(60000);
            config.setMaxLifetime(1800000);
            config.setPoolName("ScoutingPro-Pool-" + Math.abs(key.hashCode()));
            return new HikariDataSource(config);
        });
    }

    /**
     * 创建基于 HikariCP 连接池的 Jdbi 实例。
     */
    public static Jdbi create(String url, String user, String password) {
        HikariDataSource ds = getOrCreateDataSource(url, user, password);
        return create(ds);
    }

    /**
     * 基于指定 DataSource 创建 Jdbi 实例并安装所有核心插件与类型映射器。
     */
    public static Jdbi create(DataSource dataSource) {
        Jdbi jdbi = Jdbi.create(dataSource);
        jdbi.installPlugin(new SqlObjectPlugin());
        jdbi.registerColumnMapper(new StringListColumnMapper());
        jdbi.registerArgument(new StringListArgumentFactory());
        return jdbi;
    }

    /**
     * 关闭所有缓存的 HikariCP 连接池（用于 JVM 退出或测试清理）。
     */
    public static void closeDataSources() {
        DATA_SOURCES.forEach((k, ds) -> {
            try {
                if (!ds.isClosed()) {
                    ds.close();
                }
            } catch (Exception ignored) {}
        });
        DATA_SOURCES.clear();
    }

    /**
     * 统一解析开发与生产环境下的 H2 数据库文件。
     * 委托给 AppConfig 统一管理。
     */
    public static java.io.File resolveAppDbFile() {
        return AppConfig.resolveAppDbFile();
    }

    public static String resolveAppDbUrl() {
        return AppConfig.resolveAppDbUrl();
    }
}
