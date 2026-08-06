-- V5__Add_Event_Code_Year.sql
ALTER TABLE events ADD COLUMN ftc_year INT;
ALTER TABLE events ADD COLUMN ftc_event_code VARCHAR(50);
