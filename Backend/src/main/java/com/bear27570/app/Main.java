package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.routes.ApiRoutes;
import com.bear27570.app.util.NetworkUtil;
import io.javalin.Javalin;
import io.javalin.http.staticfiles.Location;
import me.friwi.jcefmaven.CefAppBuilder;
import org.cef.CefApp;
import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;

import com.bear27570.app.ui.CustomTitleBar;
import com.bear27570.app.ui.WindowResizer;

import javax.imageio.ImageIO;
import javax.swing.*;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Main {
    private static final Logger logger = LoggerFactory.getLogger(Main.class);
    private static final String JCEF_BUNDLE_RESOURCE = "/jcef-bundle.zip";
    private static final String JCEF_BUNDLE_TAR_RESOURCE = "/jcef-bundle.tar.gz";

    private static java.nio.channels.FileLock heldProfileLock = null;
    private static java.nio.channels.FileChannel heldProfileChannel = null;
    private static Path heldProfileDir = null;
    private static java.io.PrintStream originalSystemOut = null;
    private static java.io.PrintStream originalSystemErr = null;
    private static FileOutputStream activeLogFileStream = null;

    /**
     * 解析需要在日志与数据库初始化前生效的引导级 CLI 参数（--data-dir、--no-auto-server）。
     */
    public static void applyBootstrapCliArgs(String[] args) {
        if (args == null) return;
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (arg == null) continue;
            if (arg.startsWith("--data-dir=")) {
                String value = stripQuotes(arg.substring("--data-dir=".length()));
                if (!value.isEmpty()) {
                    System.setProperty("scouting.data.dir", value);
                }
            } else if ("--data-dir".equals(arg) && i + 1 < args.length) {
                String value = stripQuotes(args[++i]);
                if (!value.isEmpty()) {
                    System.setProperty("scouting.data.dir", value);
                }
            } else if ("--no-auto-server".equals(arg)) {
                System.setProperty("scouting.noAutoServer", "true");
            }
        }
    }

    private static String stripQuotes(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.length() >= 2) {
            if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
                    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
                return trimmed.substring(1, trimmed.length() - 1).trim();
            }
        }
        return trimmed;
    }

    public static void main(String[] args) {
        applyBootstrapCliArgs(args);

        // 配置 SLF4J SimpleLogger 时间戳格式（毫秒级精度）
        if (System.getProperty("org.slf4j.simpleLogger.showDateTime") == null) {
            System.setProperty("org.slf4j.simpleLogger.showDateTime", "true");
        }
        if (System.getProperty("org.slf4j.simpleLogger.dateTimeFormat") == null) {
            System.setProperty("org.slf4j.simpleLogger.dateTimeFormat", "yyyy-MM-dd HH:mm:ss.SSS");
        }

        setupFileLogging();

        // Enforce Windows ClearType subpixel font antialiasing on all Swing components
        System.setProperty("awt.useSystemAAFontSettings", "lcd_hrgb");
        System.setProperty("swing.aatext", "true");
        System.setProperty("sun.java2d.uiScale.enabled", "true");

        if (args != null) {
            for (String arg : args) {
                if ("--jcef-prewarm".equals(arg)) {
                    prewarmJcef();
                    return;
                }
            }
        }
        boolean headless = NetworkUtil.hasHeadlessArg(args);

        if (headless) {
            System.setProperty("java.awt.headless", "true");
            initAndRun(args, null);
        } else {
            // 1. 先在 EDT 上把启动动画显示出来
            SplashScreen splash = new SplashScreen();
            SwingUtilities.invokeLater(() -> splash.setVisible(true));

            // 2. 真正耗时的初始化放到后台线程，避免卡住 EDT 导致动画卡帧/掉帧
            new Thread(() -> initAndRun(args, splash), "app-init").start();
        }
    }

    /**
     * 初始化根目录文件日志：
     * 创建 log/scoutingpro.log，使用双向流同时向终端控制台与日志文件实时写入，记录后端服务与前端报错。
     */
    private static void setupFileLogging() {
        try {
            File logFile = com.bear27570.app.db.AppConfig.resolveLogFile();
            FileOutputStream fos = new FileOutputStream(logFile, true);
            java.io.PrintStream originalOut = originalSystemOut != null ? originalSystemOut : System.out;
            java.io.PrintStream originalErr = originalSystemErr != null ? originalSystemErr : System.err;
            originalSystemOut = originalOut;
            originalSystemErr = originalErr;
            activeLogFileStream = fos;

            java.io.OutputStream dualOut = new java.io.OutputStream() {
                @Override
                public synchronized void write(int b) throws IOException {
                    originalOut.write(b);
                    try { fos.write(b); } catch (IOException ignored) {}
                }

                @Override
                public synchronized void write(byte[] b, int off, int len) throws IOException {
                    originalOut.write(b, off, len);
                    try { fos.write(b, off, len); } catch (IOException ignored) {}
                }

                @Override
                public synchronized void flush() throws IOException {
                    originalOut.flush();
                    try { fos.flush(); } catch (IOException ignored) {}
                }
            };

            java.io.OutputStream dualErr = new java.io.OutputStream() {
                @Override
                public synchronized void write(int b) throws IOException {
                    originalErr.write(b);
                    try { fos.write(b); } catch (IOException ignored) {}
                }

                @Override
                public synchronized void write(byte[] b, int off, int len) throws IOException {
                    originalErr.write(b, off, len);
                    try { fos.write(b, off, len); } catch (IOException ignored) {}
                }

                @Override
                public synchronized void flush() throws IOException {
                    originalErr.flush();
                    try { fos.flush(); } catch (IOException ignored) {}
                }
            };

            System.setOut(new java.io.PrintStream(dualOut, true, java.nio.charset.StandardCharsets.UTF_8));
            System.setErr(new java.io.PrintStream(dualErr, true, java.nio.charset.StandardCharsets.UTF_8));

            String startupTimestamp = java.time.LocalDateTime.now()
                    .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS"));
            System.out.println("=======================================================");
            System.out.println("[" + startupTimestamp + "] ScoutingPro27 日志系统启动: " + logFile.getAbsolutePath());
            System.out.println("[" + startupTimestamp + "] 启动时间戳: " + startupTimestamp);
            System.out.println("=======================================================");
        } catch (Exception e) {
            System.err.println("初始化文件日志失败: " + e.getMessage());
        }
    }

    /**
     * 恢复标准输出流并关闭活动日志文件句柄，释放 Windows 文件锁。
     */
    public static synchronized void closeFileLogging() {
        if (originalSystemOut != null) {
            System.setOut(originalSystemOut);
        }
        if (originalSystemErr != null) {
            System.setErr(originalSystemErr);
        }
        if (activeLogFileStream != null) {
            try {
                activeLogFileStream.flush();
                activeLogFileStream.close();
            } catch (IOException ignored) {
            } finally {
                activeLogFileStream = null;
            }
        }
    }

    /** 仅供 CI 使用：触发 jcefmaven 真实下载解压当前平台的原生库到 ./jcef-bundle，然后退出 */
    private static void prewarmJcef() {
        try {
            File installDir = new File("jcef-bundle");
            CefAppBuilder builder = new CefAppBuilder();
            builder.setInstallDir(installDir);
            CefApp cefApp = builder.build();
            cefApp.dispose();
            System.out.println("JCEF 原生库预热完成: " + installDir.getAbsolutePath());
            System.exit(0);
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
    /** 运行时优先使用内嵌的离线原生库，没有就退回 jcefmaven 默认联网下载 */
    private static File ensureJcefBundle() throws IOException {
        return ensureJcefBundle(new File(System.getProperty("user.home"), ".scoutingpro27/jcef-bundle"));
    }

    static File ensureJcefBundle(File targetDir) throws IOException {
        File markerV3 = new File(targetDir, ".extracted_v3_ok");
        boolean isWindows = System.getProperty("os.name", "").toLowerCase().contains("win");
        boolean isMac = System.getProperty("os.name", "").toLowerCase().contains("mac");

        // 检查是否已经存在完整可用的 JCEF 原生库（已解压或已被 jcefmaven 成功下载）
        boolean hasBinaries = markerV3.exists() ||
                (isWindows && new File(targetDir, "jcef.dll").exists() && new File(targetDir, "libcef.dll").exists()) ||
                (isMac && (new File(targetDir, "jcef Helper.app").exists() || new File(targetDir, "libjcef.dylib").exists())) ||
                (!isWindows && !isMac && new File(targetDir, "libjcef.so").exists());

        if (hasBinaries) {
            if (!markerV3.exists()) {
                try {
                    markerV3.createNewFile();
                } catch (Exception ignored) {}
            }
            if (!isWindows) {
                try {
                    new ProcessBuilder("chmod", "-R", "755", targetDir.getAbsolutePath()).start().waitFor();
                } catch (Exception ignored) {}
            }
            return targetDir;
        }

        // 1. 优先尝试 tar.gz 资源（macOS/Linux 打包产物，完美保留符号链接与 POSIX 执行权限）
        try (InputStream tarIn = Main.class.getResourceAsStream(JCEF_BUNDLE_TAR_RESOURCE)) {
            if (tarIn != null) {
                if (targetDir.exists()) {
                    deleteDir(targetDir);
                }
                targetDir.mkdirs();
                File tempTar = File.createTempFile("jcef-bundle-", ".tar.gz");
                try {
                    try (FileOutputStream fos = new FileOutputStream(tempTar)) {
                        byte[] buf = new byte[16384];
                        int len;
                        while ((len = tarIn.read(buf)) > 0) fos.write(buf, 0, len);
                    }
                    Process p = new ProcessBuilder("tar", "-xzf", tempTar.getAbsolutePath(), "-C", targetDir.getAbsolutePath()).start();
                    int code = p.waitFor();
                    if (code == 0) {
                        if (!isWindows) {
                            new ProcessBuilder("chmod", "-R", "755", targetDir.getAbsolutePath()).start().waitFor();
                        }
                        new FileOutputStream(markerV3).close();
                        return targetDir;
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                } finally {
                    tempTar.delete();
                }
            }
        }

        // 2. 尝试 zip 资源（Windows 打包产物）
        try (InputStream in = Main.class.getResourceAsStream(JCEF_BUNDLE_RESOURCE)) {
            if (in == null) {
                // 开发环境未打包离线资源，保留目标目录供 jcefmaven 缓存或下载
                targetDir.mkdirs();
                return targetDir;
            }
            if (targetDir.exists()) {
                deleteDir(targetDir);
            }
            targetDir.mkdirs();
            try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(in)) {
                java.util.zip.ZipEntry entry;
                byte[] buf = new byte[16384];
                while ((entry = zis.getNextEntry()) != null) {
                    File outFile = new File(targetDir, entry.getName());
                    if (!outFile.toPath().normalize().startsWith(targetDir.toPath().normalize())) {
                        throw new IOException("Zip entry outside target directory: " + entry.getName());
                    }
                    if (entry.isDirectory()) {
                        outFile.mkdirs();
                    } else {
                        outFile.getParentFile().mkdirs();
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            int len;
                            while ((len = zis.read(buf)) > 0) fos.write(buf, 0, len);
                        }
                        if (!isWindows) {
                            outFile.setExecutable(true, false);
                        }
                    }
                }
            }
            if (!isWindows) {
                try {
                    new ProcessBuilder("chmod", "-R", "755", targetDir.getAbsolutePath()).start().waitFor();
                } catch (Exception ignored) {}
            }
            try {
                markerV3.createNewFile();
            } catch (Exception ignored) {}
        }
        return targetDir;
    }

    static String buildLocalAppUrl(int port, boolean hasCustomTitleBar) {
        String base = "http://localhost:" + port + "/index.html";
        return hasCustomTitleBar ? base + "?shell=desktop" : base;
    }

    private static void initAndRun(String[] args, SplashScreen splash) {
        try {
            if (System.getProperty("h2.bindAddress") == null) {
                System.setProperty("h2.bindAddress", "127.0.0.1");
            }
            // ==========================================
            // 数据库配置 + 迁移
            // ==========================================
            String dbUrl = JdbiConfig.resolveAppDbUrl();
            String dbUser = "sa";
            String dbPassword = "";

            if (splash != null) splash.updateProgress(10, "Preparing database...");
            logger.info("初始化 HikariCP 数据库连接池并执行迁移...");
            javax.sql.DataSource dataSource = JdbiConfig.getOrCreateDataSource(dbUrl, dbUser, dbPassword);
            Flyway flyway = Flyway.configure()
                    .dataSource(dataSource)
                    .locations("classpath:db")
                    .cleanDisabled(false)
                    .load();
            flyway.repair();
            flyway.migrate();

            if (splash != null) splash.updateProgress(35, "Connecting to database...");
            logger.info("连接 JDBI 并执行确定性用户 ID 校验...");
            Jdbi jdbi = JdbiConfig.create(dataSource);
            com.bear27570.app.service.CrdtProjectionService.ensureCrdtSchema(jdbi);
            com.bear27570.app.routes.AiRoutes.ensureAiCopilotSchema(jdbi);
            com.bear27570.app.db.UserDeterministicIdMigrator.migrate(jdbi);

            // ==========================================
            // 端口配置：默认 8080（标准防火墙规则端口），可通过 --port=N 或 DEV_PORT 自定义
            // ==========================================
            int targetPort = 8080;
            String devPort = System.getenv("DEV_PORT");
            if (devPort != null && !devPort.isBlank()) {
                targetPort = Integer.parseInt(devPort);
            }
            for (String arg : args) {
                if (arg.startsWith("--port=")) {
                    targetPort = Integer.parseInt(arg.substring(7));
                }
            }

            // ==========================================
            // 启动 Javalin（监听 0.0.0.0，使局域网、电脑热点及手机热点均可连接）
            // ==========================================
            if (splash != null) splash.updateProgress(55, "Starting local server...");
            ApiRoutes apiRoutes = new ApiRoutes(jdbi);

            final Javalin app = startServerWithFallback(apiRoutes, targetPort);

            // 异步确认并配置 Windows 防火墙（同时放行 TCP 服务端口与 WebRTC UDP 49152-65535 入站端口）
            final int activePort = app.port();
            if (NetworkUtil.shouldSkipFirewallCheck(args)) {
                logger.info("已跳过 Windows 防火墙检测与 UAC 提权配置 (ENABLE_TEST_CLEANUP / SKIP_FIREWALL_CHECK)");
            } else {
                new Thread(() -> NetworkUtil.ensureWindowsFirewallPort(activePort), "firewall-check").start();
            }

            // 异步探测物理网卡上的路由器 UPnP IGD / NAT-PMP / PCP（含 IPv6 Pinholes），仅开放 50000-50009/UDP 且带短租约与退出自动清理
            final com.bear27570.app.util.PortForwardingService portForwardingService =
                    new com.bear27570.app.util.PortForwardingService();
            portForwardingService.startAsync();

            final AtomicBoolean shuttingDown = new AtomicBoolean(false);
            final Runnable gracefulShutdown = () -> {
                if (!shuttingDown.compareAndSet(false, true)) {
                    return;
                }
                try {
                    portForwardingService.shutdown();
                } catch (Throwable ignored) {}
                try {
                    apiRoutes.shutdown();
                } catch (Throwable ignored) {}
                try {
                    app.stop();
                } catch (Throwable ignored) {}
                try {
                    JdbiConfig.closeDataSources();
                } catch (Throwable ignored) {}
                try {
                    releaseProfileLock();
                } catch (Throwable ignored) {}
                try {
                    closeFileLogging();
                } catch (Throwable ignored) {}
            };

            apiRoutes.setShutdownCallback(() -> {
                gracefulShutdown.run();
                System.exit(0);
            });

            Runtime.getRuntime().addShutdownHook(new Thread(gracefulShutdown, "app-shutdown-hook"));

            String localUrl = "http://localhost:" + app.port() + "/index.html";
            logger.info("Javalin 运行在: {} (监听 IPv4/IPv6 双栈端口 :{})", localUrl, app.port());
            
            boolean headless = NetworkUtil.hasHeadlessArg(args);
            
            if (headless) {
                logger.info("运行在 Headless 模式，已跳过 JCEF UI 的启动。");
                return;
            }

            // ==========================================
            // 配置 JCEF 浏览器
            // ==========================================
            if (splash != null) splash.updateProgress(70, "Initializing browser engine...");
            CefAppBuilder builder = new CefAppBuilder();
            builder.setInstallDir(ensureJcefBundle());
            builder.getCefSettings().windowless_rendering_enabled = false;
            builder.addJcefArgs("--use-fake-ui-for-media-stream");
            builder.addJcefArgs("--disable-features=WebRtcHideLocalIpsWithMdns,WebUsb,MediaRouter,CalculateNativeWinOcclusion");
            // 开启 Chromium libwebrtc IPv6 默认探测、按物理网卡索引绑定 Socket（per-socket 设置，不修改系统路由）、快速 ICE 提名探测与 BBR 拥塞控制
            builder.addJcefArgs("--force-fieldtrials=WebRTC-IPv6Default/Enabled/WebRTC-BindUsingInterfaceIndex/Enabled/WebRTC-IceFieldTrials/send_ping_on_switch_ice_controlling:true,send_ping_on_selected_ice_controlling:true,send_ping_on_nomination_ice_controlled:true/WebRTC-Bwe-Bbr/Enabled/");
            builder.addJcefArgs("--disable-device-discovery-notifications");
            builder.addJcefArgs("--disable-usb-keyboard-detect");

            boolean isMac = System.getProperty("os.name", "").toLowerCase().contains("mac");
            if (isMac) {
                builder.addJcefArgs("--no-sandbox");
            }


            // 智能分配 JCEF 缓存目录（主实例持久化保证公私钥与信任稳定，多开实例自动隔离防止 CEF lockfile 崩溃）
            File cacheDir = resolveJcefProfileDir();
            builder.getCefSettings().cache_path = cacheDir.getAbsolutePath();

            // 将 libwebrtc UDP 端口分配在 50000-50099（100 个端口，支持 15+ 并发采集端而不耗尽），前 10 个端口与 PortForwardingService 可选映射重叠
            builder.setAppHandler(new me.friwi.jcefmaven.MavenCefAppHandlerAdapter() {
                @Override
                public void onContextInitialized() {
                    super.onContextInitialized();
                    configureJcefWebRtcUdpPortRange();
                }
            });

            CefApp cefApp = builder.build();
            CefClient cefClient = cefApp.createClient();

            // 拦截并转发前端控制台日志，统一追加落盘至 log/scoutingpro.log
            cefClient.addDisplayHandler(new org.cef.handler.CefDisplayHandlerAdapter() {
                @Override
                public boolean onConsoleMessage(CefBrowser browser, org.cef.CefSettings.LogSeverity level,
                                                String message, String source, int line) {
                    System.out.printf("[%s] [Frontend-Console] (%s:%d) %s%n",
                            java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                            source != null ? source : "unknown",
                            line,
                            message);
                    return false;
                }
            });
            
            // Handle file downloads (e.g. CSV exports)
            cefClient.addDownloadHandler(new org.cef.handler.CefDownloadHandlerAdapter() {
                @Override
                public boolean onBeforeDownload(CefBrowser browser, org.cef.callback.CefDownloadItem downloadItem,
                                                String suggestedName, org.cef.callback.CefBeforeDownloadCallback callback) {
                    SwingUtilities.invokeLater(() -> {
                        JFileChooser fileChooser = new JFileChooser();
                        fileChooser.setSelectedFile(new File(suggestedName));
                        int result = fileChooser.showSaveDialog(null);
                        if (result == JFileChooser.APPROVE_OPTION) {
                            callback.Continue(fileChooser.getSelectedFile().getAbsolutePath(), false);
                        } else {
                            callback.Continue("", false);
                        }
                    });
                    return true;
                }
            });

            if (splash != null) splash.updateProgress(88, "Loading interface...");
            final boolean isWindows = System.getProperty("os.name", "").toLowerCase().contains("win");
            String browserUrl = buildLocalAppUrl(app.port(), isWindows);
            CefBrowser browser = cefClient.createBrowser(browserUrl, false, false);
            Component browserUI = browser.getUIComponent();

            if (splash != null) splash.updateProgress(100, "Ready");

            // ==========================================
            // 切回 EDT：显示主窗口，动画淡出关闭
            // ==========================================
            SwingUtilities.invokeLater(() -> {
                JFrame frame = new JFrame("ScoutingPro27");

                // 统一全窗口 Pit Wall 冷石墨背景 (#0B0E10)，消除任何边缘和子像素间隙闪白/泛灰
                Color windowBg = new Color(0x0B, 0x0E, 0x10);
                frame.setBackground(windowBg);
                if (frame.getRootPane() != null) {
                    frame.getRootPane().setBackground(windowBg);
                    frame.getRootPane().setBorder(null);
                }
                if (frame.getContentPane() != null) {
                    frame.getContentPane().setBackground(windowBg);
                }

                if (isWindows) {
                    frame.setUndecorated(true);

                    // Set multi-resolution taskbar and window icons across all DPI scales
                    List<Image> appIcons = loadAppIcons();
                    if (!appIcons.isEmpty()) {
                        frame.setIconImages(appIcons);
                    }

                    // Custom title bar replacing system default title bar on Windows
                    CustomTitleBar customTitleBar = new CustomTitleBar(frame);
                    frame.getContentPane().setLayout(new BorderLayout());
                    frame.getContentPane().add(customTitleBar, BorderLayout.NORTH);
                    frame.getContentPane().add(browserUI, BorderLayout.CENTER);

                    // Attach edge & corner resizer for undecorated frame
                    WindowResizer.attach(frame);

                    // 监听窗口尺寸与状态变化，自适应保持大圆角 (24px 半径)，最大化时直角满屏
                    frame.addComponentListener(new java.awt.event.ComponentAdapter() {
                        @Override
                        public void componentResized(java.awt.event.ComponentEvent e) {
                            updateWindowShape(frame);
                        }
                    });
                    frame.addWindowStateListener(e -> updateWindowShape(frame));
                } else {
                    // macOS / Linux: 保持标准原生窗口，避免 JCEF 在 macOS 无边框 NSWindowStyleMaskBorderless 下发生 native SIGTRAP 崩溃
                    frame.getContentPane().setLayout(new BorderLayout());
                    frame.getContentPane().add(browserUI, BorderLayout.CENTER);
                }

                frame.setSize(1024, 768);
                frame.setLocationRelativeTo(null);
                updateWindowShape(frame);

                frame.addWindowListener(new WindowAdapter() {
                    @Override
                    public void windowClosing(WindowEvent e) {
                        frame.setVisible(false);
                        new Thread(() -> {
                            try {
                                browser.executeJavaScript("if (window.__rtcDisconnect) { window.__rtcDisconnect(); }", browser.getURL(), 0);
                                Thread.sleep(150);
                            } catch (Exception ignored) {}
                            try {
                                portForwardingService.shutdown();
                            } catch (Exception ignored) {}
                            try {
                                cefApp.dispose();
                            } catch (Exception ignored) {}
                            SwingUtilities.invokeLater(frame::dispose);
                            try {
                                app.stop();
                            } catch (Exception ignored) {}
                            // 1. 先释放 JCEF 实例文件锁与数据库连接池
                            releaseProfileLock();
                            com.bear27570.app.db.JdbiConfig.closeDataSources();
                            // 2. 仅清理多开降级产生的临时目录，绝不删除持久化主目录 jcef_profile！
                            if (cacheDir != null && cacheDir.getName().startsWith("scoutingpro-jcef-")) {
                                deleteDir(cacheDir);
                            }
                            closeFileLogging();
                            System.exit(0);
                        }, "app-graceful-shutdown").start();
                    }
                });

                // 动画满足最短展示时长后自动淡出，回调里再显示主窗口，
                // 这样视觉上是“动画放完 -> 主界面出现”，衔接不会有空档或闪烁。
                if (splash != null) {
                    splash.closeSmoothly(() -> frame.setVisible(true));
                } else {
                    frame.setVisible(true);
                }
            });

        } catch (Exception e) {
            e.printStackTrace();
            if (splash != null) {
                final String errMsg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                SwingUtilities.invokeLater(() -> {
                    splash.showFailure(errMsg);
                    splash.setVisible(true);
                });
            } else {
                System.exit(1);
            }
        }
    }

    private static void configureJcefWebRtcUdpPortRange() {
        try {
            org.cef.browser.CefRequestContext ctx = org.cef.browser.CefRequestContext.getGlobalContext();
            if (ctx == null) {
                logger.warn("[JCEF] CefRequestContext.getGlobalContext() is null; skipping webrtc.udp_port_range setup.");
                return;
            }
            final String prefName = "webrtc.udp_port_range";
            final String targetRange = com.bear27570.app.util.PortForwardingService.JCEF_WEBRTC_UDP_PORT_RANGE;
            boolean canSet = ctx.canSetPreference(prefName);
            String err = ctx.setPreference(prefName, targetRange);
            Object actualValue = ctx.getPreference(prefName);
            boolean verified = targetRange.equals(actualValue != null ? String.valueOf(actualValue) : null);
            if ((err == null || err.isEmpty()) && verified) {
                logger.info("[JCEF] Configured {}={} (canSet={}, verified={})",
                        prefName, targetRange, canSet, actualValue);
            } else {
                logger.warn("[JCEF] webrtc.udp_port_range={} not accepted/verified (canSet={}, err={}, verified={})",
                        targetRange, canSet, err, actualValue);
            }
        } catch (Throwable t) {
            logger.warn("[JCEF] Exception configuring webrtc.udp_port_range: {}", t.toString());
        }
    }

    private static Javalin startServerWithFallback(ApiRoutes apiRoutes, int targetPort) {
        // 优先使用 IPv4/IPv6 双栈通配地址 "::" 绑定，使局域网、电脑热点、手机 4G/5G 蜂窝网络及电脑间公网 IPv6 均可直接连通
        try {
            return createJavalinApp(apiRoutes).start("::", targetPort);
        } catch (Exception e) {
            System.err.println("IPv6/IPv4 双栈绑定目标端口 " + targetPort + " 异常，尝试 IPv4 (0.0.0.0): " + e.getMessage());
            try {
                return createJavalinApp(apiRoutes).start("0.0.0.0", targetPort);
            } catch (Exception e2) {
                System.err.println("目标端口 " + targetPort + " 启动失败，尝试备用端口: " + e2.getMessage());
                try {
                    return createJavalinApp(apiRoutes).start("::", targetPort == 8080 ? 8081 : 0);
                } catch (Exception e3) {
                    try {
                        return createJavalinApp(apiRoutes).start("0.0.0.0", targetPort == 8080 ? 8081 : 0);
                    } catch (Exception e4) {
                        return createJavalinApp(apiRoutes).start(0);
                    }
                }
            }
        }
    }

    private static Javalin createJavalinApp(ApiRoutes apiRoutes) {
        return Javalin.create(config -> {
            config.http.maxRequestSize = 15_000_000L; // 允许最大 15MB 请求体（支持移动端多张高清特写照片 Base64 批量回传）
            config.jetty.modifyWebSocketServletFactory(factory -> {
                factory.setMaxTextMessageSize(2 * 1024 * 1024);
                factory.setMaxBinaryMessageSize(2 * 1024 * 1024);
                factory.setIdleTimeout(java.time.Duration.ofMinutes(15));
            });
            config.staticFiles.add(staticFiles -> {
                staticFiles.hostedPath = "/";
                staticFiles.directory = "/public";
                staticFiles.location = Location.CLASSPATH;
            });
            config.staticFiles.add(staticFiles -> {
                staticFiles.hostedPath = "/assets";
                staticFiles.directory = "/assets";
                staticFiles.location = Location.CLASSPATH;
            });
            config.bundledPlugins.enableCors(cors -> {
                cors.addRule(rule -> rule.anyHost());
            });
            apiRoutes.register(config.routes);
            config.events.serverStopped(apiRoutes::shutdown);
        });
    }

    public static final int WINDOW_CORNER_RADIUS = 24;

    public static void updateWindowShape(JFrame frame) {
        if (frame == null) return;
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) return;
        if (!frame.isUndecorated()) return;
        if ((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0) {
            frame.setShape(null);
        } else {
            int w = frame.getWidth();
            int h = frame.getHeight();
            if (w > 0 && h > 0) {
                frame.setShape(new RoundRectangle2D.Float(0, 0, w, h, WINDOW_CORNER_RADIUS, WINDOW_CORNER_RADIUS));
            }
        }
    }

    public static List<Image> loadAppIcons() {
        List<Image> icons = new ArrayList<>();
        BufferedImage master = null;
        String[] paths = { "/icon.png", "/logo_transparent.png", "/logo.png", "/public/logo_transparent.png", "/app_icon.png" };
        for (String p : paths) {
            try (InputStream in = Main.class.getResourceAsStream(p)) {
                if (in != null) {
                    master = ImageIO.read(in);
                    if (master != null) break;
                }
            } catch (Exception ignored) {}
        }
        if (master == null) return icons;

        BufferedImage trimmed = trimTransparentPadding(master);
        BufferedImage source = trimmed != null ? trimmed : master;

        int[] targetSizes = { 16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512 };
        for (int size : targetSizes) {
            if (size <= source.getWidth() && size <= source.getHeight()) {
                icons.add(scaleImageBicubic(source, size, size));
            }
        }
        icons.add(source);
        return icons;
    }

    private static BufferedImage trimTransparentPadding(BufferedImage src) {
        if (src == null) return null;
        int width = src.getWidth();
        int height = src.getHeight();
        int minX = width, minY = height, maxX = 0, maxY = 0;
        boolean hasContent = false;

        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int alpha = (src.getRGB(x, y) >>> 24);
                if (alpha > 15) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasContent = true;
                }
            }
        }

        if (!hasContent) return src;

        int cropW = maxX - minX + 1;
        int cropH = maxY - minY + 1;
        int pad = Math.max(2, Math.max(cropW, cropH) / 25);
        int paddedX = Math.max(0, minX - pad);
        int paddedY = Math.max(0, minY - pad);
        int paddedW = Math.min(width - paddedX, cropW + (minX - paddedX) + pad);
        int paddedH = Math.min(height - paddedY, cropH + (minY - paddedY) + pad);

        return src.getSubimage(paddedX, paddedY, paddedW, paddedH);
    }

    private static BufferedImage scaleImageBicubic(BufferedImage src, int w, int h) {
        BufferedImage dst = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g2 = dst.createGraphics();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g2.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);
        g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g2.drawImage(src, 0, 0, w, h, null);
        g2.dispose();
        return dst;
    }

    private static void deleteDir(File file) {
        if (file.isDirectory()) {
            File[] files = file.listFiles();
            if (files != null) {
                for (File f : files) {
                    deleteDir(f);
                }
            }
        }
        file.delete();
    }

    /**
     * 为当前 JCEF 实例智能分配 profile 缓存目录：
     * 1. 优先使用主持久化目录 (jcef_profile)，保证单实例日常使用时 IndexedDB、公私钥、SAS 信任持久留存。
     * 2. 若检测到主目录已被其他实例独占持有（多开场景），自动探测并分配独立的 jcef_profile_2, jcef_profile_3 等。
     *    既允许同机多开实例平稳并存（杜绝 Chromium/CEF lockfile 锁冲突导致 AbortError 崩溃），
     *    又为多开的实例赋予独立的设备身份与 LocalStorage。
     */
    static File resolveJcefProfileDir() {
        File baseDir = com.bear27570.app.db.AppConfig.resolveBaseDataDir();
        File primary = new File(baseDir, "jcef_profile");
        primary.mkdirs();
        if (tryAcquireProfileLock(primary)) {
            logger.info("成功分配并锁定主 JCEF 缓存目录: {}", primary.getAbsolutePath());
            return primary;
        }

        for (int i = 2; i <= 10; i++) {
            File multiDir = new File(baseDir, "jcef_profile_" + i);
            multiDir.mkdirs();
            if (tryAcquireProfileLock(multiDir)) {
                logger.info("检测到主实例正在运行，多实例隔离模式已激活，当前实例使用独立缓存目录: {}", multiDir.getAbsolutePath());
                return multiDir;
            }
        }

        File fallback = new File(System.getProperty("java.io.tmpdir"), "scoutingpro-jcef-" + System.currentTimeMillis());
        fallback.mkdirs();
        logger.info("多实例预置目录已满，使用临时缓存目录: {}", fallback.getAbsolutePath());
        return fallback;
    }

    private static Path normalizeProfilePath(File dir) {
        Path rawPath = dir.toPath();
        try {
            return rawPath.toRealPath();
        } catch (IOException e) {
            return rawPath.toAbsolutePath().normalize();
        }
    }

    static synchronized boolean tryAcquireProfileLock(File profileDir) {
        if (profileDir == null) {
            return false;
        }
        Path normalizedDir = normalizeProfilePath(profileDir);
        if (heldProfileLock != null && heldProfileLock.isValid() && normalizedDir.equals(heldProfileDir)) {
            return false;
        }

        // 1. 探测 Chromium 自身的 lockfile 是否被其他活动进程独占
        File cefLock = new File(profileDir, "lockfile");
        if (cefLock.exists()) {
            try (FileOutputStream fos = new FileOutputStream(cefLock, true);
                 java.nio.channels.FileLock l = fos.getChannel().tryLock()) {
                if (l == null) {
                    return false;
                }
            } catch (Throwable e) {
                // 正被运行中的 Chromium 或其他进程独占
                return false;
            }
        }

        // 2. 探测并持有当前 Java 进程的应用级独占锁 (.instance.lock)
        java.nio.channels.FileChannel channel = null;
        try {
            File lockFile = new File(profileDir, ".instance.lock");
            channel = java.nio.channels.FileChannel.open(
                    lockFile.toPath(),
                    java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.WRITE);
            java.nio.channels.FileLock lock = channel.tryLock();
            if (lock != null) {
                releaseProfileLock();
                heldProfileChannel = channel;
                heldProfileLock = lock;
                heldProfileDir = normalizedDir;
                return true;
            } else {
                channel.close();
                return false;
            }
        } catch (Throwable e) {
            if (channel != null) {
                try {
                    channel.close();
                } catch (Exception ignored) {}
            }
            return false;
        }
    }

    static synchronized void releaseProfileLock() {
        try {
            if (heldProfileLock != null && heldProfileLock.isValid()) {
                heldProfileLock.release();
            }
        } catch (Exception ignored) {
        } finally {
            heldProfileLock = null;
            heldProfileDir = null;
            if (heldProfileChannel != null) {
                try {
                    if (heldProfileChannel.isOpen()) {
                        heldProfileChannel.close();
                    }
                } catch (Exception ignored) {
                } finally {
                    heldProfileChannel = null;
                }
            }
        }
    }
}