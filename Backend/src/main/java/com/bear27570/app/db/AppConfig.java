package com.bear27570.app.db;

import java.io.File;

/**
 * 统一环境与持久化资产配置中心（单一真相来源）。
 * 负责解析：
 * 1. 运行环境 (DEV, PROD, TEST)
 * 2. H2 数据库文件与 JDBC URL
 * 3. JWT 鉴权密钥 (jwt.secret) 物理文件路径
 * 4. AES 对称加密主密钥 (master.key) 物理文件路径
 */
public class AppConfig {

    public enum Environment {
        DEV, PROD, TEST
    }

    private static volatile Environment environmentOverride = null;

    /**
     * 设置环境覆盖（仅供单元测试使用）
     */
    public static void setEnvironmentOverride(Environment env) {
        environmentOverride = env;
    }

    public static void clearEnvironmentOverride() {
        environmentOverride = null;
    }

    /**
     * 智能定位项目源码根目录（包含 Backend/pom.xml 的目录）。
     * 从当前工作目录逐级向上查找，确保无论从根目录、Backend 子目录还是 target 目录启动都能精准定位。
     * 若在打包安装模式下（不在源码仓库内），返回 null。
     */
    public static File findProjectRootDir() {
        try {
            File curr = new File(".").getCanonicalFile();
            while (curr != null) {
                if (new File(curr, "Backend" + File.separator + "pom.xml").exists()) {
                    return curr;
                }
                curr = curr.getParentFile();
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * 获取当前运行环境。
     * 判定优先级：
     * 1. 显式覆盖 environmentOverride
     * 2. JVM 系统属性 scouting.env 或 app.env
     * 3. 系统环境变量 SCOUTING_ENV 或 APP_ENV
     * 4. 基于源码结构自动判定（存在 Backend/pom.xml 为 DEV，否则为 PROD）
     */
    public static Environment getEnvironment() {
        if (environmentOverride != null) {
            return environmentOverride;
        }

        String sysProp = System.getProperty("scouting.env");
        if (sysProp == null || sysProp.isBlank()) {
            sysProp = System.getProperty("app.env");
        }
        if (sysProp != null && !sysProp.isBlank()) {
            return parseEnvironment(sysProp);
        }

        String envVar = System.getenv("SCOUTING_ENV");
        if (envVar == null || envVar.isBlank()) {
            envVar = System.getenv("APP_ENV");
        }
        if (envVar != null && !envVar.isBlank()) {
            return parseEnvironment(envVar);
        }

        return findProjectRootDir() != null ? Environment.DEV : Environment.PROD;
    }

    private static Environment parseEnvironment(String val) {
        String trimmed = val.trim().toLowerCase();
        if (trimmed.equals("prod") || trimmed.equals("production")) {
            return Environment.PROD;
        }
        if (trimmed.equals("test") || trimmed.equals("testing")) {
            return Environment.TEST;
        }
        return Environment.DEV;
    }

    public static boolean isDev() {
        return getEnvironment() == Environment.DEV;
    }

    public static boolean isProd() {
        return getEnvironment() == Environment.PROD;
    }

    public static boolean isTest() {
        return getEnvironment() == Environment.TEST;
    }

    /**
     * 获取数据与资产的基准目录。
     * DEV: <project_root>/app_data
     * PROD: ~/.scoutingpro27
     */
    public static File resolveBaseDataDir() {
        if (isDev()) {
            File root = findProjectRootDir();
            File devDataDir = root != null ? new File(root, "app_data") : new File("app_data");
            if (!devDataDir.exists()) {
                devDataDir.mkdirs();
            }
            return devDataDir;
        } else {
            File prodDir = new File(System.getProperty("user.home"), ".scoutingpro27");
            if (!prodDir.exists()) {
                prodDir.mkdirs();
            }
            return prodDir;
        }
    }

    /**
     * 获取 H2 数据库物理文件前缀（H2 会自动追加 .mv.db）。
     * DEV: <project_root>/app_data
     * PROD: ~/.scoutingpro27/app_data
     */
    public static File resolveAppDbFile() {
        if (isDev()) {
            File root = findProjectRootDir();
            return root != null ? new File(root, "app_data") : new File("app_data");
        } else {
            File prodDir = resolveBaseDataDir();
            return new File(prodDir, "app_data");
        }
    }

    /**
     * 解析 H2 数据库 JDBC 连接 URL。
     * 支持 DB_URL 环境变量直接覆盖。
     */
    public static String resolveAppDbUrl() {
        String envDb = System.getenv("DB_URL");
        if (envDb != null && !envDb.isBlank()) {
            return envDb;
        }
        File dbFile = resolveAppDbFile();
        return "jdbc:h2:" + dbFile.getAbsolutePath().replace('\\', '/') + ";AUTO_SERVER=TRUE";
    }

    /**
     * 获取 JWT Secret 文件路径。
     * DEV: <project_root>/app_data/jwt.secret
     * PROD: ~/.scoutingpro27/jwt.secret
     */
    public static File resolveJwtSecretFile() {
        return new File(resolveBaseDataDir(), "jwt.secret");
    }

    /**
     * 获取 AES Master Key 文件路径。
     * DEV: <project_root>/app_data/master.key
     * PROD: ~/.scoutingpro27/master.key
     */
    public static File resolveMasterKeyFile() {
        return new File(resolveBaseDataDir(), "master.key");
    }
}
