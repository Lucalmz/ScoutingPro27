package com.bear27570.app.model;

public class TeamTag {
    private String id;
    private String eventId;
    private int teamNumber;
    private String tag;
    private String color;
    private boolean isPreset;
    private String createdBy;
    private String createdAt;
    private String updatedAt;

    public TeamTag() {}

    public TeamTag(String id, String eventId, int teamNumber, String tag, String color, boolean isPreset, String createdBy) {
        this.id = id;
        this.eventId = eventId;
        this.teamNumber = teamNumber;
        this.tag = tag;
        this.color = color;
        this.isPreset = isPreset;
        this.createdBy = createdBy;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public int getTeamNumber() { return teamNumber; }
    public void setTeamNumber(int teamNumber) { this.teamNumber = teamNumber; }

    public String getTag() { return tag; }
    public void setTag(String tag) { this.tag = tag; }

    public String getColor() { return color; }
    public void setColor(String color) { this.color = color; }

    public boolean isPreset() { return isPreset; }
    public void setPreset(boolean preset) { isPreset = preset; }
    public boolean getIsPreset() { return isPreset; }
    public void setIsPreset(boolean preset) { isPreset = preset; }

    public String getCreatedBy() { return createdBy; }
    public void setCreatedBy(String createdBy) { this.createdBy = createdBy; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
