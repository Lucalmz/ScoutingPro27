-- V3__Add_Username_Unique.sql — Add UNIQUE constraint to username

ALTER TABLE users ADD CONSTRAINT IF NOT EXISTS uk_username UNIQUE (username);
