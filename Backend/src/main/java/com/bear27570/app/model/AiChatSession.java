package com.bear27570.app.model;

import java.sql.Timestamp;

public class AiChatSession {
    private String userId;
    private String eventId;
    private String chatHistoryJson;
    private Timestamp updatedAt;

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public String getChatHistoryJson() { return chatHistoryJson; }
    public void setChatHistoryJson(String chatHistoryJson) { this.chatHistoryJson = chatHistoryJson; }

    public Timestamp getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Timestamp updatedAt) { this.updatedAt = updatedAt; }
}
