package com.bear27570.app.routes.ai;

import org.jdbi.v3.core.Jdbi;

/**
 * Idempotently ensures V9 AI Copilot tables and indexes exist when upgrading an existing dev database.
 */
public final class AiSchemaBootstrap {
    private AiSchemaBootstrap() {}

    public static void ensureAiCopilotSchema(Jdbi jdbi) {
        jdbi.useHandle(handle -> {
            handle.execute("""
                    CREATE TABLE IF NOT EXISTS ai_provider_profiles (
                        id                 VARCHAR(128)  PRIMARY KEY,
                        user_id            VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        name               VARCHAR(120)  NOT NULL,
                        preset_id          VARCHAR(48)   DEFAULT 'custom',
                        protocol           VARCHAR(20)   NOT NULL,
                        api_key_encrypted  TEXT          DEFAULT '',
                        base_url           VARCHAR(500)  DEFAULT '',
                        model_name         VARCHAR(200)  DEFAULT '',
                        custom_models_json CLOB          DEFAULT '[]',
                        system_prompt      TEXT,
                        temperature        DOUBLE        DEFAULT 0.4,
                        max_tokens         INT           DEFAULT 4096,
                        enable_thinking    BOOLEAN       NOT NULL DEFAULT FALSE,
                        thinking_budget    INT           DEFAULT 4096,
                        anthropic_version  VARCHAR(32)   DEFAULT '2023-06-01',
                        max_context_msgs   INT           DEFAULT 16,
                        proxy_host         VARCHAR(255)  DEFAULT '',
                        proxy_port         INT           DEFAULT NULL,
                        is_active          BOOLEAN       NOT NULL DEFAULT FALSE,
                        created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                        updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
                    )
                    """);
            handle.execute("CREATE INDEX IF NOT EXISTS idx_ai_profiles_user ON ai_provider_profiles(user_id, is_active DESC, updated_at DESC)");
            handle.execute("""
                    CREATE TABLE IF NOT EXISTS ai_chat_threads (
                        id                  VARCHAR(128)  PRIMARY KEY,
                        user_id             VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        event_id            VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                        title               VARCHAR(200)  NOT NULL DEFAULT 'New Tactical Chat',
                        persona_id          VARCHAR(48)   DEFAULT 'strategist',
                        pinned              BOOLEAN       NOT NULL DEFAULT FALSE,
                        messages_json       CLOB          NOT NULL DEFAULT '[]',
                        context_config_json CLOB          DEFAULT '{}',
                        created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                        updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
                    )
                    """);
            handle.execute("CREATE INDEX IF NOT EXISTS idx_ai_threads_user_event ON ai_chat_threads(user_id, event_id, pinned DESC, updated_at DESC)");
        });
    }
}
