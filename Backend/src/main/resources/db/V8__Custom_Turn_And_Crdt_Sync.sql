-- V8__Custom_Turn_And_Crdt_Sync.sql — Custom TURN Config, CRDT State Snapshot, Revision Guard & Author/Host Signatures

ALTER TABLE events ADD COLUMN IF NOT EXISTS turn_config_encrypted TEXT;

CREATE TABLE IF NOT EXISTS event_crdt_state (
    event_id           VARCHAR(2048) PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    host_epoch         INT           NOT NULL DEFAULT 1,
    snapshot_revision  BIGINT        NOT NULL DEFAULT 0,
    crdt_snapshot_json CLOB          NOT NULL,
    updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_pub_key VARCHAR(256);
ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_sig     VARCHAR(256);
ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS host_sig       VARCHAR(256);
