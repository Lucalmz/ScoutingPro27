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

import javax.swing.*;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;

public class Main {
    private static final String JCEF_BUNDLE_RESOURCE = "/jcef-bundle.zip";
    public static void main(String[] args) {
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
        File marker = new File(targetDir, ".extracted_ok");
        if (marker.exists()) {
            return targetDir;
        }
        try (InputStream in = Main.class.getResourceAsStream(JCEF_BUNDLE_RESOURCE)) {
            if (in == null) {
                // 开发环境没打包这个资源，走原来的联网下载
                return targetDir;
            }
            targetDir.mkdirs();
            try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(in)) {
                java.util.zip.ZipEntry entry;
                byte[] buf = new byte[8192];
                while ((entry = zis.getNextEntry()) != null) {
                    File outFile = new File(targetDir, entry.getName());
                    if (entry.isDirectory()) {
                        outFile.mkdirs();
                    } else {
                        outFile.getParentFile().mkdirs();
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            int len;
                            while ((len = zis.read(buf)) > 0) fos.write(buf, 0, len);
                        }
                    }
                }
            }
            new FileOutputStream(marker).close();
        }
        return targetDir;
    }
    private static void initAndRun(String[] args, SplashScreen splash) {
        try {
            // ==========================================
            // 数据库配置 + 迁移
            // ==========================================
            File appDataDir = new File(System.getProperty("user.home"), ".scoutingpro27");
            if (!appDataDir.exists()) {
                appDataDir.mkdirs();
            }
            File legacyDb = new File("app_data.mv.db");
            File targetDb = new File(appDataDir, "app_data.mv.db");
            if (legacyDb.exists() && !targetDb.exists()) {
                try {
                    Files.copy(legacyDb.toPath(), targetDb.toPath());
                    System.out.println("已自动将本地数据库迁移至用户主目录: " + targetDb.getAbsolutePath());
                } catch (Exception e) {
                    System.err.println("自动迁移本地数据库失败: " + e.getMessage());
                }
            }
            File dbFile = new File(appDataDir, "app_data");
            String dbUrl = System.getenv("DB_URL") != null ? System.getenv("DB_URL") : ("jdbc:h2:" + dbFile.getAbsolutePath().replace('\\', '/') + ";AUTO_SERVER=TRUE");
            String dbUser = "sa";
            String dbPassword = "";

            if (splash != null) splash.updateProgress(10, "Preparing database...");
            System.out.println("执行数据库迁移...");
            Flyway flyway = Flyway.configure()
                    .dataSource(dbUrl, dbUser, dbPassword)
                    .locations("classpath:db")
                    .cleanDisabled(false)
                    .load();
            flyway.repair();
            flyway.migrate();

            if (splash != null) splash.updateProgress(35, "Connecting to database...");
            System.out.println("连接 JDBI...");
            Jdbi jdbi = JdbiConfig.create(dbUrl, dbUser, dbPassword);

            // ==========================================
            // 端口配置：--port=N 或 DEV_PORT 环境变量，默认 0（随机）
            // ==========================================
            int port = 0;
            String devPort = System.getenv("DEV_PORT");
            if (devPort != null && !devPort.isBlank()) {
                port = Integer.parseInt(devPort);
            }
            for (String arg : args) {
                if (arg.startsWith("--port=")) {
                    port = Integer.parseInt(arg.substring(7));
                }
            }

            // ==========================================
            // 启动 Javalin（Javalin 7：路由在 config.routes 中注册）
            // ==========================================
            if (splash != null) splash.updateProgress(55, "Starting local server...");
            ApiRoutes apiRoutes = new ApiRoutes(jdbi);

            Javalin app = Javalin.create(config -> {
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
                // CORS
                config.bundledPlugins.enableCors(cors -> {
                    cors.addRule(rule -> rule.anyHost());
                });
                // REST API 路由
                apiRoutes.register(config.routes);
                // 生命周期优雅停机钩子
                config.events.serverStopped(apiRoutes::shutdown);
            }).start(port);

            String localUrl = "http://localhost:" + app.port() + "/index.html";
            System.out.println("Javalin 运行在: " + localUrl);
            
            boolean headless = false;
            for (String arg : args) {
                if ("--headless".equals(arg)) {
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
                frame.getContentPane().add(browserUI, BorderLayout.CENTER);
                frame.setSize(1024, 768);
                frame.setLocationRelativeTo(null);

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