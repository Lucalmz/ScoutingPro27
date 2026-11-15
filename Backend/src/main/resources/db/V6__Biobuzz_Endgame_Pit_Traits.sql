-- V6__Biobuzz_Endgame_Pit_Traits.sql — Add 2026-2027 BIOBUZZ tactical traits and structured Endgame claims

ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS has_descore_mech BOOLEAN DEFAULT FALSE;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS has_apriltag_vision BOOLEAN DEFAULT FALSE;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_teleop_park BOOLEAN DEFAULT FALSE;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_flower_nectars INT DEFAULT 0;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_flower_bottom_bonus INT DEFAULT 0;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_flower_pollens INT DEFAULT 0;
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS claimed_garden_balls INT DEFAULT 0;
