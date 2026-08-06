-- V1__Init.sql — ScoutingPro27 初始 Schema（粗粒度）

CREATE TABLE IF NOT EXISTS users (
    id          VARCHAR(36)  PRIMARY KEY,
    username    VARCHAR(50)  NOT NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id           VARCHAR(36)  PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    invite_code  VARCHAR(10)  UNIQUE,
    host_id      VARCHAR(36)  NOT NULL REFERENCES users(id),
    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_users (
    event_id VARCHAR(36) REFERENCES events(id) ON DELETE CASCADE,
    user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(event_id, user_id)
);

CREATE TABLE IF NOT EXISTS scouting_records (
    id              VARCHAR(36)   PRIMARY KEY,
    event_id        VARCHAR(36)   NOT NULL REFERENCES events(id),
    scout_id        VARCHAR(36)   NOT NULL REFERENCES users(id),
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
    created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_records_event ON scouting_records(event_id);
CREATE INDEX IF NOT EXISTS idx_records_sync  ON scouting_records(sync_status);
