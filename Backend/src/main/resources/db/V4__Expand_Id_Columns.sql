-- V4__Expand_Id_Columns.sql — Expand ID columns and add performance indexes for super-event scale

-- 1. Expand Primary Key ID columns to VARCHAR(2048)
ALTER TABLE match_schedules ALTER COLUMN id VARCHAR(2048);
ALTER TABLE scout_assignments ALTER COLUMN id VARCHAR(2048);
ALTER TABLE pit_scouting_records ALTER COLUMN id VARCHAR(2048);
ALTER TABLE scouting_records ALTER COLUMN id VARCHAR(2048);
ALTER TABLE team_tags ALTER COLUMN id VARCHAR(2048);

-- 2. Expand referencing Foreign Key and Scout/User ID columns to VARCHAR(2048)
ALTER TABLE users ALTER COLUMN id VARCHAR(2048);
ALTER TABLE events ALTER COLUMN id VARCHAR(2048);
ALTER TABLE events ALTER COLUMN host_id VARCHAR(2048);
ALTER TABLE event_users ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE event_users ALTER COLUMN user_id VARCHAR(2048);
ALTER TABLE scouting_records ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE scouting_records ALTER COLUMN scout_id VARCHAR(2048);
ALTER TABLE pit_scouting_records ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE pit_scouting_records ALTER COLUMN scout_id VARCHAR(2048);
ALTER TABLE team_tags ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE team_tags ALTER COLUMN created_by VARCHAR(2048);
ALTER TABLE match_schedules ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE scout_assignments ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE scout_assignments ALTER COLUMN scout_id VARCHAR(2048);
ALTER TABLE banned_teams ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE event_official_teams ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE ai_chat_sessions ALTER COLUMN event_id VARCHAR(2048);
ALTER TABLE ai_chat_sessions ALTER COLUMN user_id VARCHAR(2048);
ALTER TABLE ai_settings ALTER COLUMN user_id VARCHAR(2048);

-- 3. Expand team official names to avoid truncation from official FTC API
ALTER TABLE event_official_teams ALTER COLUMN name_full VARCHAR(500);

-- 4. High-Performance Secondary Indexes
CREATE INDEX IF NOT EXISTS idx_events_host ON events(host_id);
CREATE INDEX IF NOT EXISTS idx_event_users_user ON event_users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_records_scout ON scouting_records(scout_id);
CREATE INDEX IF NOT EXISTS idx_records_event_team ON scouting_records(event_id, team_number);
CREATE INDEX IF NOT EXISTS idx_records_tombstone ON scouting_records(is_deleted, updated_at);
CREATE INDEX IF NOT EXISTS idx_pit_records_active ON pit_scouting_records(event_id, is_deleted, team_number);
