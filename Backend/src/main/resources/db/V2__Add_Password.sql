-- V2__Add_Password.sql — Add password column to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT '';
