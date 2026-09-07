package com.bear27570.app.routes;

import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.util.FtcApiClient;
import com.bear27570.app.util.JwtUtil;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Type;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * REST API 路由协调注册器。
 * Javalin 7：通过 config.routes 注册，在 start() 之前完成。
 * 保持全局 Filter 垄断与各个领域子路由协调派发。
 */
public class ApiRoutes {

    private static final Logger logger = LoggerFactory.getLogger(ApiRoutes.class);
    private final Jdbi jdbi;
    private final FtcApiClient ftcApiClient;
    private final Gson gson = new com.google.gson.GsonBuilder().setDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ").create();
    private final ScheduledExecutorService gcScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "tombstone-gc-thread");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledThreadPoolExecutor heartbeatScheduler = createHeartbeatScheduler();

    private static ScheduledThreadPoolExecutor createHeartbeatScheduler() {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(2, r -> {
            Thread t = new Thread(r, "sse-heartbeat-thread");
            t.setDaemon(true);
            return t;
        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    public ApiRoutes(Jdbi jdbi) {
        this(jdbi, new FtcApiClient());
    }

    public ApiRoutes(Jdbi jdbi, FtcApiClient ftcApiClient) {
        this.jdbi = jdbi;
        this.ftcApiClient = ftcApiClient;
        // 自动注册并启动 14 天过期墓碑后台周期性清理任务：服务启动后立即执行一次，随后每 24 小时自动巡检清理
        gcScheduler.scheduleAtFixedRate(() -> {
            try {
                jdbi.useExtension(RecordDao.class, dao -> {
                    int purged = dao.purgeExpiredTombstones();
                    if (purged > 0) {
                        System.out.println("[Tombstone GC] Cleaned up " + purged + " expired tombstones older than 14 days.");
                    }
                });
            } catch (Exception e) {
                System.err.println("[Tombstone GC] Periodic cleanup error: " + e.getMessage());
            }
        }, 0, 24, TimeUnit.HOURS);
    }

    public void shutdown() {
        gcScheduler.shutdownNow();
        heartbeatScheduler.shutdownNow();
    }

    public static String asString(Object val) {
        if (val == null) return null;
        if (val instanceof Number) {
            Number n = (Number) val;
            if (n.doubleValue() == (double) n.longValue()) {
                return String.valueOf(n.longValue());
            }
        }
        return String.valueOf(val);
    }

    public static boolean isSafeUrl(String urlStr) {
        return AiRoutes.isSafeUrl(urlStr);
    }

    public void register(RoutesConfig routes) {

        routes.exception(NullPointerException.class, (e, ctx) -> {
            // Ignore Jetty 12 request recycling exception on client abort/disconnect
        });
        routes.exception(com.google.gson.JsonSyntaxException.class, (e, ctx) -> {
            ctx.status(400).result("Invalid JSON body");
        });

        // ==================== User Routes ====================
        new UserRoutes(jdbi, gson).register(routes);

        // Global Authentication Interceptor (Filter Monopoly)
        routes.before("/api/*", ctx -> {
            String path = ctx.path();
            if (path.equals("/api/user/login") || path.equals("/api/user/register") || path.equals("/api/user/check") || path.equals("/api/user/verify-token") || path.equals("/api/test/cleanup") || path.equals("/api/system/network-info")) return; // skip user and system info routes
            if (ctx.method().name().equals("GET") && path.matches("^/api/events/[^/]+/pit/photos/[^/]+$")) return; // skip public photo streaming for <img>
            if (ctx.method().name().equals("OPTIONS")) return; // skip CORS preflight
            
            String authHeader = ctx.header("Authorization");
            if (authHeader == null || !authHeader.startsWith("Bearer ")) {
                throw new io.javalin.http.UnauthorizedResponse("Missing or invalid token");
            }
            String token = authHeader.substring(7);
            String userId = JwtUtil.verifyToken(token);
            if (userId == null) {
                throw new io.javalin.http.UnauthorizedResponse("Invalid or expired token");
            }
            ctx.attribute("userId", userId);
        });

        // ==================== Domain Sub-Routes ====================
        new SystemRoutes(gson).register(routes);
        new WebRtcRoutes(jdbi, gson).register(routes);
        new EventRoutes(jdbi, gson).register(routes);
        new TeamTagRoutes(jdbi, gson).register(routes);
        new ScheduleRoutes(jdbi, gson).register(routes);
        new FtcProxyRoutes(ftcApiClient, gson).register(routes);
        new RecordRoutes(jdbi, gson).register(routes);
        new PitScoutRoutes(jdbi, gson).register(routes);
        new AiRoutes(jdbi, gson, heartbeatScheduler).register(routes);

        // ==================== Test Cleanup ====================
        if ("true".equals(System.getenv("ENABLE_TEST_CLEANUP")) || "true".equals(System.getProperty("ENABLE_TEST_CLEANUP"))) {
            routes.post("/api/test/cleanup", ctx -> {
                try {
                    Type t = new TypeToken<List<String>>() {}.getType();
                    List<String> usernames = gson.fromJson(ctx.body(), t);
                    if (usernames != null && !usernames.isEmpty()) {
                        jdbi.useTransaction(handle -> {
                            for (String username : usernames) {
                                handle.execute("DELETE FROM events WHERE host_id IN (SELECT id FROM users WHERE username = ?)", username);
                                handle.execute("DELETE FROM users WHERE username = ?", username);
                            }
                        });
                    }
                    ctx.status(200).result("Cleanup OK");
                } catch (Exception e) {
                    ctx.status(500).result("Cleanup Failed: " + e.getMessage());
                }
            });
        }
    }
}
