package com.bear27570.app.model;

import java.sql.Timestamp;

public class AiChatThread {
    private String id;
    private String userId;
    private String eventId;
    private String title = "New Tactical Chat";
    private String personaId = "strategist";
    private boolean pinned = false;
    private String messagesJson = "[]";
    private String contextConfigJson = "{}";
    private Timestamp createdAt;
    private Timestamp updatedAt;

    public AiChatThread() {
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getPersonaId() { return personaId; }
    public void setPersonaId(String personaId) { this.personaId = personaId; }

    public boolean getPinned() { return pinned; }
    public void setPinned(boolean pinned) { this.pinned = pinned; }

    public String getMessagesJson() { return messagesJson; }
    public void setMessagesJson(String messagesJson) { this.messagesJson = messagesJson; }

    public String getContextConfigJson() { return contextConfigJson; }
    public void setContextConfigJson(String contextConfigJson) { this.contextConfigJson = contextConfigJson; }

    public Timestamp getCreatedAt() { return createdAt; }
    public void setCreatedAt(Timestamp createdAt) { this.createdAt = createdAt; }

    public Timestamp getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Timestamp updatedAt) { this.updatedAt = updatedAt; }
}
