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
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;

public class Main {

    public static void main(String[] args) {
        // 1. 先在 EDT 上把启动动画显示出来
        SplashScreen splash = new SplashScreen();
        SwingUtilities.invokeLater(() -> splash.setVisible(true));

        // 2. 真正耗时的初始化放到后台线程，避免卡住 EDT 导致动画卡帧/掉帧
        new Thread(() -> initAndRun(args, splash), "app-init").start();
    }

    private static void initAndRun(String[] args, SplashScreen splash) {
        try {
            // ==========================================
            // 数据库配置 + 迁移
            // ==========================================
            splash.updateProgress(10, "Preparing database...");
            String dbUrl = "jdbc:h2:./app_data;AUTO_SERVER=TRUE";
            String dbUser = "sa";
            String dbPassword = "";

            System.out.println("执行数据库迁移...");
            Flyway flyway = Flyway.configure()
                    .dataSource(dbUrl, dbUser, dbPassword)
                    .locations("classpath:db")
                    .cleanDisabled(false)
                    .load();
            flyway.repair();
            flyway.migrate();

            splash.updateProgress(35, "Connecting to database...");
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
            splash.updateProgress(55, "Starting local server...");
            ApiRoutes apiRoutes = new ApiRoutes(jdbi);

            Javalin app = Javalin.create(config -> {
                config.staticFiles.add(staticFiles -> {
                    staticFiles.hostedPath = "/";
                    staticFiles.directory = "/public";
                    staticFiles.location = Location.CLASSPATH;
                });
                // CORS
                config.bundledPlugins.enableCors(cors -> {
                    cors.addRule(rule -> rule.anyHost());
                });
                // REST API 路由
                apiRoutes.register(config.routes);
            }).start(port);

            String localUrl = "http://localhost:" + app.port() + "/index.html";
            System.out.println("Javalin 运行在: " + localUrl);

            // ==========================================
            // 配置 JCEF 浏览器
            // ==========================================
            splash.updateProgress(70, "Initializing browser engine...");
            CefAppBuilder builder = new CefAppBuilder();
            builder.setInstallDir(new File("jcef-bundle"));
            builder.getCefSettings().windowless_rendering_enabled = false;

            // 为每个实例分配独立的缓存目录，防止多开时互相锁死崩溃
            File cacheDir = new File(System.getProperty("java.io.tmpdir"), "scoutingpro-jcef-" + java.util.UUID.randomUUID());
            cacheDir.mkdirs();
            builder.getCefSettings().cache_path = cacheDir.getAbsolutePath();

            CefApp cefApp = builder.build();
            CefClient cefClient = cefApp.createClient();

            splash.updateProgress(88, "Loading interface...");
            CefBrowser browser = cefClient.createBrowser(localUrl, false, false);
            Component browserUI = browser.getUIComponent();

            splash.updateProgress(100, "Ready");

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
                splash.closeSmoothly(() -> frame.setVisible(true));
            });

        } catch (Exception e) {
            e.printStackTrace();
            SwingUtilities.invokeLater(() -> {
                splash.dispose();
                JOptionPane.showMessageDialog(null, "Startup failed: " + e.getMessage());
            });
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