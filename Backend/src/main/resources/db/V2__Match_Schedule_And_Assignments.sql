-- V2__Match_Schedule_And_Assignments.sql — Match Schedule & Scout Assignments Schema

CREATE TABLE IF NOT EXISTS match_schedules (
    id               VARCHAR(36) PRIMARY KEY,
    event_id         VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    match_number     INT NOT NULL,
    tournament_level VARCHAR(20) DEFAULT 'QUALIFICATION',
    red1             INT NOT NULL,
    red2             INT NOT NULL,
    blue1            INT NOT NULL,
    blue2            INT NOT NULL,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_match_level UNIQUE(event_id, match_number, tournament_level)
);

CREATE INDEX IF NOT EXISTS idx_schedules_event ON match_schedules(event_id);
CREATE INDEX IF NOT EXISTS idx_schedules_event_match ON match_schedules(event_id, match_number);

CREATE TABLE IF NOT EXISTS scout_assignments (
    id               VARCHAR(36) PRIMARY KEY,
    event_id         VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    match_number     INT NOT NULL,
    tournament_level VARCHAR(20) DEFAULT 'QUALIFICATION',
    station          VARCHAR(10) NOT NULL, -- 'red1', 'red2', 'blue1', 'blue2'
    team_number      INT NOT NULL,
    scout_id         VARCHAR(36),          -- 可为空，永远支持留空
    scout_name       VARCHAR(50),          -- 可为空，永远支持留空
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_match_station UNIQUE(event_id, match_number, tournament_level, station)
);

CREATE INDEX IF NOT EXISTS idx_assignments_event ON scout_assignments(event_id);
CREATE INDEX IF NOT EXISTS idx_assignments_scout ON scout_assignments(event_id, scout_id);
