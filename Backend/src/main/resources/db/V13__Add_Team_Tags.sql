-- V13__Add_Team_Tags.sql
-- 赛事级队伍战术标签系统 (Event-Scoped Custom Team Tags)

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
