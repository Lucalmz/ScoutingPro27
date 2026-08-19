-- V7__Add_AI_Settings.sql
-- Add AI settings table for storing multi-provider configuration tied to a user.
-- Use composite primary key (user_id, provider) so users can save keys for multiple providers simultaneously.

CREATE TABLE IF NOT EXISTS ai_settings (
    user_id           VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          VARCHAR(20)  NOT NULL, -- e.g., 'OPENAI', 'GEMINI'
    api_key_encrypted TEXT         NOT NULL, -- AES encrypted API key
    system_prompt     TEXT,                  -- User defined system prompt
    proxy_host        VARCHAR(255) DEFAULT '127.0.0.1',
    proxy_port        INT          DEFAULT null, -- nullable, null means no proxy
    created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, provider)
);
