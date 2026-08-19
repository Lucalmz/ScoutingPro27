CREATE TABLE ai_chat_sessions (
    user_id VARCHAR(36) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    chat_history_json TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, event_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
