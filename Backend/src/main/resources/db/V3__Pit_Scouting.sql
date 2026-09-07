-- V3__Pit_Scouting.sql — Official Teams & Quantified Pit Scouting Records

CREATE TABLE IF NOT EXISTS event_official_teams (
    event_id        VARCHAR(36)  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    team_number     INT          NOT NULL,
    name_full       VARCHAR(200),
    robot_name      VARCHAR(100),
    city            VARCHAR(100),
    country         VARCHAR(100),
    updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, team_number)
);

CREATE TABLE IF NOT EXISTS pit_scouting_records (
    id                          VARCHAR(36)  PRIMARY KEY,
    event_id                    VARCHAR(36)  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    team_number                 INT          NOT NULL,
    scout_id                    VARCHAR(36)  NOT NULL,
    scout_name                  VARCHAR(50)  NOT NULL,
    robot_name                  VARCHAR(100),
    
    -- 核心硬件构型 (Hardware Essentials)
    drivetrain_type             VARCHAR(30)  NOT NULL DEFAULT 'mecanum',
    weight_lbs                  DOUBLE       DEFAULT 0.0,
    sizing_passed               BOOLEAN      DEFAULT TRUE,
    mechanism_type              VARCHAR(30)  DEFAULT 'slide_claw',
    hang_type                   VARCHAR(30)  DEFAULT 'winch',
    odometry_type               VARCHAR(30)  DEFAULT 'none',
    
    -- 核心量化自述指标 (Claimed Quantitative Performance)
    claimed_auto_score          INT          DEFAULT 0,
    claimed_auto_pieces         INT          DEFAULT 0,
    claimed_auto_hang_level     INT          DEFAULT 0,
    claimed_teleop_score        INT          DEFAULT 0,
    claimed_teleop_cycle_sec    DOUBLE       DEFAULT 0.0,
    claimed_endgame_hang_level  INT          DEFAULT 0,
    claimed_endgame_time_sec    DOUBLE       DEFAULT 0.0,
    claimed_total_score         INT          DEFAULT 0,
    
    -- 图片键索引与分布式版本控制
    photo_keys                  TEXT,
    version                     INT          DEFAULT 1 NOT NULL,
    host_seq                    INT,
    is_deleted                  BOOLEAN      DEFAULT FALSE NOT NULL,
    created_at                  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_pit_event_team UNIQUE(event_id, team_number)
);

CREATE INDEX IF NOT EXISTS idx_pit_records_event ON pit_scouting_records(event_id);
CREATE INDEX IF NOT EXISTS idx_pit_records_team  ON pit_scouting_records(event_id, team_number);
