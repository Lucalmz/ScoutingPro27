package com.bear27570.app.routes;

import com.bear27570.app.routes.ai.AiProfileRoutes;
import com.bear27570.app.routes.ai.AiSchemaBootstrap;
import com.bear27570.app.routes.ai.AiStreamAndProbeRoutes;
import com.bear27570.app.routes.ai.AiThreadRoutes;
import com.bear27570.app.routes.ai.AiUrlGuard;
import com.bear27570.app.routes.ai.AiVoiceRoutes;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.util.concurrent.ScheduledThreadPoolExecutor;

/**
 * Coordinates registration of cohesive AI Copilot route modules under {@code com.bear27570.app.routes.ai}.
 */
public class AiRoutes {
    private final AiProfileRoutes profileRoutes;
    private final AiThreadRoutes threadRoutes;
    private final AiStreamAndProbeRoutes streamAndProbeRoutes;
    private final AiVoiceRoutes voiceRoutes;

    public AiRoutes(Jdbi jdbi, Gson gson, ScheduledThreadPoolExecutor heartbeatScheduler) {
        this.profileRoutes = new AiProfileRoutes(jdbi, gson);
        this.threadRoutes = new AiThreadRoutes(jdbi, gson);
        this.streamAndProbeRoutes = new AiStreamAndProbeRoutes(jdbi, gson, heartbeatScheduler);
        this.voiceRoutes = new AiVoiceRoutes(jdbi, gson, heartbeatScheduler);
    }

    public static void ensureAiCopilotSchema(Jdbi jdbi) {
        AiSchemaBootstrap.ensureAiCopilotSchema(jdbi);
    }

    public void register(RoutesConfig routes) {
        profileRoutes.register(routes);
        streamAndProbeRoutes.register(routes);
        threadRoutes.register(routes);
        voiceRoutes.register(routes);
    }

    public void shutdown() {
        voiceRoutes.shutdown();
    }

    public static boolean isSafeUrl(String urlStr) {
        return AiUrlGuard.isSafeUrl(urlStr);
    }
}
