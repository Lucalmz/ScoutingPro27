-- V1__Init.sql — ScoutingPro27 Unified Initial Schema

CREATE TABLE IF NOT EXISTS users (
    id          VARCHAR(36)  PRIMARY KEY,
    username    VARCHAR(50)  NOT NULL,
    password    VARCHAR(255) DEFAULT '',
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id              VARCHAR(36)  PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    invite_code     VARCHAR(10)  UNIQUE,
    host_id         VARCHAR(36)  NOT NULL REFERENCES users(id),
    ftc_year        INT,
    ftc_event_code  VARCHAR(50),
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_users (
    event_id VARCHAR(36) REFERENCES events(id) ON DELETE CASCADE,
    user_id  VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(event_id, user_id)
);

CREATE TABLE IF NOT EXISTS scouting_records (
    id              VARCHAR(36)   PRIMARY KEY,
    event_id        VARCHAR(36)   NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    scout_id        VARCHAR(36)   NOT NULL,
    scout_name      VARCHAR(50)   NOT NULL,
    match_number    INT           NOT NULL,
    team_number     INT           NOT NULL,
    auto_score      INT           DEFAULT 0,
    teleop_score    INT           DEFAULT 0,
    endgame_score   INT           DEFAULT 0,
    total_score     INT           DEFAULT 0,
    notes           TEXT,
    raw_data        TEXT,
    sync_status     VARCHAR(20)   DEFAULT 'PENDING',
    is_broken       BOOLEAN       DEFAULT FALSE,
    version         INT           DEFAULT 1 NOT NULL,
    host_seq        INT,
    is_deleted      BOOLEAN       DEFAULT FALSE NOT NULL,
    created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_records_event ON scouting_records(event_id);
CREATE INDEX IF NOT EXISTS idx_records_sync  ON scouting_records(sync_status);

CREATE TABLE IF NOT EXISTS banned_teams (
    event_id    VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    team_number INT         NOT NULL,
    PRIMARY KEY(event_id, team_number)
);

CREATE TABLE IF NOT EXISTS ai_settings (
    user_id           VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          VARCHAR(20)  NOT NULL, -- e.g., 'OPENAI', 'GEMINI'
    api_key_encrypted TEXT         NOT NULL, -- AES encrypted API key
    model_name        VARCHAR(100) DEFAULT '',
    system_prompt     TEXT,                  -- User defined system prompt
    proxy_host        VARCHAR(255) DEFAULT '127.0.0.1',
    proxy_port        INT          DEFAULT null, -- nullable, null means no proxy
    base_url          VARCHAR(500) DEFAULT '',
    created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    user_id           VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id          VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    chat_history_json TEXT,
    updated_at        TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, event_id)
);

CREATE TABLE IF NOT EXISTS team_tags (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    event_id    VARCHAR(36)  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    team_number INT          NOT NULL,
    tag         VARCHAR(30)  NOT NULL,
    color       VARCHAR(16)  NOT NULL DEFAULT 'blue',
    is_preset   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by  VARCHAR(36),
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_team_tag UNIQUE (event_id, team_number, tag)
);

CREATE INDEX IF NOT EXISTS idx_team_tags_event_team ON team_tags(event_id, team_number);
CREATE INDEX IF NOT EXISTS idx_team_tags_event      ON team_tags(event_id);
