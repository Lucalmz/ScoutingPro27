-- V10__Custom_Fields_And_Formulas.sql — Custom field UX config & safe formula engine metadata

ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS description       VARCHAR(300);
ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS config_json       TEXT;
ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS formula_expr      TEXT;
ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS aggregation_mode  VARCHAR(30) DEFAULT 'avg';
ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS display_format    VARCHAR(30) DEFAULT 'number';
ALTER TABLE event_custom_fields ADD COLUMN IF NOT EXISTS dependencies_json TEXT;
