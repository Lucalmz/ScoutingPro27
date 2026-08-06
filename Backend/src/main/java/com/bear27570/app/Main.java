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
        // 1. 启动提示框
        JFrame splash = new JFrame("启动中...");
        JLabel splashLabel = new JLabel("程序正在初始化，请稍候...", SwingConstants.CENTER);
        splash.add(splashLabel);
        splash.setSize(300, 100);
        splash.setLocationRelativeTo(null);
        splash.setUndecorated(true);
        splash.setVisible(true);

        try {
            // ==========================================
            // 2. 数据库配置
            // ==========================================
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

            System.out.println("连接 JDBI...");
            Jdbi jdbi = JdbiConfig.create(dbUrl, dbUser, dbPassword);

            // ==========================================
            // 3. 端口配置：--port=N 或 DEV_PORT 环境变量，默认 0（随机）
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
            // 4. 启动 Javalin（Javalin 7：路由在 config.routes 中注册）
            // ==========================================
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
            // 5. 配置 JCEF 浏览器
            // ==========================================
            CefAppBuilder builder = new CefAppBuilder();
            builder.setInstallDir(new File("jcef-bundle"));
            builder.getCefSettings().windowless_rendering_enabled = false;
            
            // 为每个实例分配独立的缓存目录，防止多开时互相锁死崩溃
            File cacheDir = new File(System.getProperty("java.io.tmpdir"), "scoutingpro-jcef-" + java.util.UUID.randomUUID().toString());
            cacheDir.mkdirs();
            builder.getCefSettings().cache_path = cacheDir.getAbsolutePath();

            CefApp cefApp = builder.build();
            CefClient cefClient = cefApp.createClient();
            CefBrowser browser = cefClient.createBrowser(localUrl, false, false);
            Component browserUI = browser.getUIComponent();

            // ==========================================
            // 6. 显示主窗口
            // ==========================================
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

            splash.dispose();
            frame.setVisible(true);

        } catch (Exception e) {
            e.printStackTrace();
            JOptionPane.showMessageDialog(null, "启动失败: " + e.getMessage());
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