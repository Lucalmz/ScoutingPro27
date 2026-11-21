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

    static {
        // Ensure H2's AUTO_SERVER socket always binds to loopback interface (127.0.0.1),
        // preventing it from selecting VPN/Clash TUN virtual adapters (e.g. 198.18.0.1)
        // which block inter-process local communication on Windows.
        if (System.getProperty("h2.bindAddress") == null) {
            System.setProperty("h2.bindAddress", "127.0.0.1");
        }
    }

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
     * 解析显式指定的多实例隔离数据目录。
     * 优先级：JVM 系统属性 {@code scouting.data.dir} > 环境变量 {@code SCOUTING_DATA_DIR}。
     */
    public static File resolveExplicitDataDir() {
        String raw = System.getProperty("scouting.data.dir");
        if (raw == null || raw.isBlank()) {
            raw = System.getenv("SCOUTING_DATA_DIR");
        }
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String cleaned = stripMatchingQuotes(raw);
        if (cleaned.isEmpty()) {
            return null;
        }
        File dir = new File(cleaned);
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    /**
     * 是否禁用 H2 AUTO_SERVER（多进程临时库 E2E 隔离时开启，加快句柄释放且避免端口抢占）。
     */
    public static boolean isNoAutoServer() {
        String sysProp = System.getProperty("scouting.noAutoServer");
        if ("true".equalsIgnoreCase(sysProp)) {
            return true;
        }
        String envVar = System.getenv("SCOUTING_NO_AUTO_SERVER");
        return "true".equalsIgnoreCase(envVar);
    }

    private static String stripMatchingQuotes(String raw) {
        String trimmed = raw.trim();
        if (trimmed.length() >= 2) {
            if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
                    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
                return trimmed.substring(1, trimmed.length() - 1).trim();
            }
        }
        return trimmed;
    }

    /**
     * 获取数据与资产的基准目录。
     * 显式隔离目录 > DEV (<project_root>/app_data) > PROD (~/.scoutingpro27)
     */
    public static File resolveBaseDataDir() {
        File explicitDir = resolveExplicitDataDir();
        if (explicitDir != null) {
            return explicitDir;
        }
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
     * 显式隔离目录 (<dataDir>/app_data) > DEV (<project_root>/app_data) > PROD (~/.scoutingpro27/app_data)
     */
    public static File resolveAppDbFile() {
        File explicitDir = resolveExplicitDataDir();
        if (explicitDir != null) {
            return new File(explicitDir, "app_data");
        }
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
     * 支持 DB_URL 环境变量直接覆盖，以及 --no-auto-server / scouting.noAutoServer 禁用 AUTO_SERVER。
     */
    public static String resolveAppDbUrl() {
        String envDb = System.getenv("DB_URL");
        if (envDb != null && !envDb.isBlank()) {
            return envDb;
        }
        File dbFile = resolveAppDbFile();
        String dbPath = dbFile.getAbsolutePath().replace('\\', '/');
        if (isNoAutoServer()) {
            return "jdbc:h2:" + dbPath + ";AUTO_SERVER=FALSE;LOCK_TIMEOUT=15000";
        }
        return "jdbc:h2:" + dbPath + ";AUTO_SERVER=TRUE;LOCK_TIMEOUT=15000;AUTO_RECONNECT=TRUE";
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

    /**
     * 获取根目录日志文件夹 (log/) 与主日志文件 (scoutingpro.log)。
     * 若指定显式隔离目录则写入 <dataDir>/log；否则优先项目根目录 log/，或用户资产目录下 log/。
     */
    public static File resolveLogDir() {
        File explicitDir = resolveExplicitDataDir();
        if (explicitDir != null) {
            File logDir = new File(explicitDir, "log");
            if (!logDir.exists()) {
                logDir.mkdirs();
            }
            return logDir;
        }
        File root = findProjectRootDir();
        File logDir = root != null ? new File(root, "log") : new File(resolveBaseDataDir(), "log");
        if (!logDir.exists()) {
            logDir.mkdirs();
        }
        return logDir;
    }

    private static File currentLogFile = null;

    /**
     * 获取当前运行实例的独立日志文件 (log/scoutingpro_yyyy-MM-dd_HH-mm-ss.log)。
     * 每次运行（JVM 启动）都独立出一个新的日志文件，单次运行内缓存单例复用。
     */
    public static synchronized File resolveLogFile() {
        if (currentLogFile == null) {
            String timestamp = java.time.LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss"));
            File dir = resolveLogDir();
            File candidate = new File(dir, "scoutingpro_" + timestamp + ".log");
            int counter = 1;
            while (candidate.exists() && candidate.length() > 0) {
                candidate = new File(dir, "scoutingpro_" + timestamp + "_" + counter + ".log");
                counter++;
            }
            currentLogFile = candidate;
        }
        return currentLogFile;
    }

    /**
     * 仅供单元测试重置当前运行日志文件
     */
    public static synchronized void resetLogFileForTest() {
        currentLogFile = null;
    }
}
