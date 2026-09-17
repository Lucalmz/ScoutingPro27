package com.bear27570.app;

import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.routes.ApiRoutes;
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
import java.util.ArrayList;
import java.util.List;

public class Main {
    private static final String JCEF_BUNDLE_RESOURCE = "/jcef-bundle.zip";
    private static final String JCEF_BUNDLE_TAR_RESOURCE = "/jcef-bundle.tar.gz";

    public static void main(String[] args) {
        // Enforce Windows ClearType subpixel font antialiasing on all Swing components
        System.setProperty("awt.useSystemAAFontSettings", "lcd_hrgb");
        System.setProperty("swing.aatext", "true");
        System.setProperty("sun.java2d.uiScale.enabled", "true");

        boolean headless = false;
        for (String arg : args) {
            if ("--jcef-prewarm".equals(arg)) {
                prewarmJcef();
                return;
            }
            if ("--headless".equals(arg)) {
                headless = true;
                break;
            }
        }

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
        File targetDir = new File(System.getProperty("user.home"), ".scoutingpro27/jcef-bundle");
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
            System.out.println("初始化 HikariCP 数据库连接池并执行迁移...");
            javax.sql.DataSource dataSource = JdbiConfig.getOrCreateDataSource(dbUrl, dbUser, dbPassword);
            Flyway flyway = Flyway.configure()
                    .dataSource(dataSource)
                    .locations("classpath:db")
                    .cleanDisabled(false)
                    .load();
            flyway.repair();
            flyway.migrate();

            if (splash != null) splash.updateProgress(35, "Connecting to database...");
            System.out.println("连接 JDBI...");
            Jdbi jdbi = JdbiConfig.create(dataSource);

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

            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try {
                    apiRoutes.shutdown();
                    app.stop();
                    JdbiConfig.closeDataSources();
                } catch (Throwable ignored) {}
            }, "app-shutdown-hook"));

            String localUrl = "http://localhost:" + app.port() + "/index.html";
            System.out.println("Javalin 运行在: " + localUrl + " (监听 IPv4/IPv6 双栈端口 :" + app.port() + ")");
            
            boolean headless = false;
            for (String arg : args) {
                if (arg != null && arg.replace("\"", "").trim().equals("--headless")) {
                    headless = true;
                    break;
                }
            }
            
            if (headless) {
                System.out.println("运行在 Headless 模式，已跳过 JCEF UI 的启动。");
                return;
            }

            // ==========================================
            // 配置 JCEF 浏览器
            // ==========================================
            if (splash != null) splash.updateProgress(70, "Initializing browser engine...");
            CefAppBuilder builder = new CefAppBuilder();
            builder.setInstallDir(ensureJcefBundle());
            builder.getCefSettings().windowless_rendering_enabled = false;
            // 允许暴露真实本地网卡 IP（包括公网 IPv6），避免 Chromium 默认用 mDNS .local 掩盖导致跨网络 IPv6 直连打洞失败
            // 同时禁用 WebUsb、MediaRouter、CalculateNativeWinOcclusion 等探测，彻底消除 Windows 下 ~6 秒启动卡顿
            builder.addJcefArgs("--disable-features=WebRtcHideLocalIpsWithMdns,WebUsb,MediaRouter,CalculateNativeWinOcclusion");
            builder.addJcefArgs("--disable-device-discovery-notifications");
            builder.addJcefArgs("--disable-usb-keyboard-detect");

            boolean isMac = System.getProperty("os.name", "").toLowerCase().contains("mac");
            if (isMac) {
                builder.addJcefArgs("--no-sandbox");
            }


            // 为每个实例分配独立的缓存目录，防止多开时互相锁死崩溃
            File cacheDir = new File(System.getProperty("java.io.tmpdir"), "scoutingpro-jcef-" + java.util.UUID.randomUUID());
            cacheDir.mkdirs();
            builder.getCefSettings().cache_path = cacheDir.getAbsolutePath();

            CefApp cefApp = builder.build();
            CefClient cefClient = cefApp.createClient();
            
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
            CefBrowser browser = cefClient.createBrowser(localUrl, false, false);
            Component browserUI = browser.getUIComponent();

            if (splash != null) splash.updateProgress(100, "Ready");

            // ==========================================
            // 切回 EDT：显示主窗口，动画淡出关闭
            // ==========================================
            SwingUtilities.invokeLater(() -> {
                JFrame frame = new JFrame("ScoutingPro27");
                boolean isWindows = System.getProperty("os.name", "").toLowerCase().contains("win");

                // 统一全窗口深色背景，消除任何边缘和子像素间隙闪白/泛灰
                Color windowBg = new Color(10, 10, 10);
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
                        CefApp.getInstance().dispose();
                        app.stop();
                        frame.dispose();
                        // 尝试清理临时缓存目录
                        deleteDir(cacheDir);
                        System.exit(0);
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
                SwingUtilities.invokeLater(() -> {
                    splash.dispose();
                    JOptionPane.showMessageDialog(null, "Startup failed: " + e.getMessage());
                });
            }
            System.exit(1);
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
}