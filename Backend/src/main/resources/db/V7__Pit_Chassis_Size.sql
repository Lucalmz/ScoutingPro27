-- V7__Pit_Chassis_Size.sql — Restore non-compliance chassis size trait on pit scouting records

ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS chassis_size VARCHAR(64) DEFAULT '';
