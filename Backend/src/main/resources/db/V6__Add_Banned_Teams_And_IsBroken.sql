CREATE TABLE IF NOT EXISTS banned_teams (
    event_id VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    team_number INT NOT NULL,
    PRIMARY KEY(event_id, team_number)
);

ALTER TABLE scouting_records ADD COLUMN is_broken BOOLEAN DEFAULT FALSE;
