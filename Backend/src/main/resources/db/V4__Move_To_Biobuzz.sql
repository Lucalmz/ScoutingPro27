-- V4__Move_To_Biobuzz.sql — Expand ID columns, add performance indexes, and transition schema to 2026-2027 BIOBUZZ

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

-- 5. Add 2026-2027 BIOBUZZ Pit Scouting Columns
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS ball_compatibility VARCHAR(30) DEFAULT 'universal';
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS launcher_type VARCHAR(100) DEFAULT '';
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS flower_mechanism VARCHAR(100) DEFAULT '';
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS has_color_sensor BOOLEAN DEFAULT FALSE;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_auto_strategy TEXT;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_teleop_cycles INT DEFAULT 0;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_endgame_score INT DEFAULT 0;

-- 6. Drop Obsolete Legacy Non-BIOBUZZ Columns
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS sizing_passed;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS mechanism_type;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS hang_type;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS claimed_auto_pieces;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS claimed_auto_hang_level;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS claimed_teleop_cycle_sec;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS claimed_endgame_hang_level;
ALTER TABLE pit_scouting_records DROP COLUMN IF EXISTS claimed_endgame_time_sec;
