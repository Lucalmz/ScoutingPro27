package com.bear27570.app.db;

import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;

/**
 * JDBI 配置工厂。
 * JDBI 3.45 默认已支持 snake_case → camelCase 自动映射（BeanMapper），
 * 无需额外 ColumnNameMapping 配置。
 */
public class JdbiConfig {
    public static Jdbi create(String url, String user, String password) {
        Jdbi jdbi = Jdbi.create(url, user, password);
        jdbi.installPlugin(new SqlObjectPlugin());
        return jdbi;
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
