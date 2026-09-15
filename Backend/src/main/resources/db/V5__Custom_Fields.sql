-- V5__Custom_Fields.sql — Custom field definitions & Pit raw_data alignment

-- 1. 赛事级自定义字段元数据表（存储用户定义的字段规则）
CREATE TABLE IF NOT EXISTS event_custom_fields (
    id           VARCHAR(2048) PRIMARY KEY,
    event_id     VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    target       VARCHAR(30)   NOT NULL, -- 'MATCH' (比赛) 或 'PIT' (展位)
    phase        VARCHAR(30)   NOT NULL DEFAULT 'overall', -- 挂载阶段: 'auto', 'teleop', 'endgame', 'overall', 'hardware', 'strategy'
    name         VARCHAR(100)  NOT NULL, -- 用户自定的字段名称，如 "飞手受压"、"卡球次数"
    field_key    VARCHAR(100)  NOT NULL, -- 数据存储 key（英文/拼音）
    field_type   VARCHAR(30)   NOT NULL, -- 'boolean', 'number', 'level', 'select', 'multi_select', 'text'
    required     BOOLEAN       DEFAULT FALSE NOT NULL,
    default_val  TEXT,
    options_json TEXT,                   -- 用户自定义选项列表 JSON: [{"label":"外圈","value":"outer","color":"blue"}]
    min_val      DOUBLE,
    max_val      DOUBLE,
    step_val     DOUBLE,
    unit         VARCHAR(30),            -- 用户自定单位，如 "次", "秒"
    order_seq    INT           DEFAULT 0 NOT NULL,
    is_active    BOOLEAN       DEFAULT TRUE NOT NULL,
    created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_target_field_key UNIQUE (event_id, target, field_key)
);

CREATE INDEX IF NOT EXISTS idx_custom_fields_event ON event_custom_fields(event_id, target, is_active);

-- 2. 彻底为 Pit Scouting 补齐 raw_data，实现两大核心表架构大一统
ALTER TABLE pit_scouting_records ADD COLUMN IF NOT EXISTS raw_data TEXT;
