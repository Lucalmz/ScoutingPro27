CREATE TABLE scouting_records_new (
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
    created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO scouting_records_new SELECT * FROM scouting_records;

DROP TABLE scouting_records;

ALTER TABLE scouting_records_new RENAME TO scouting_records;

CREATE INDEX idx_records_event ON scouting_records(event_id);
CREATE INDEX idx_records_sync  ON scouting_records(sync_status);
