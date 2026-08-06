package com.bear27570.app.model;

public class ScoutingEvent {
    private String id;
    private String name;
    private String inviteCode;
    private boolean isHost;
    private String createdAt;

    public ScoutingEvent() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getInviteCode() { return inviteCode; }
    public void setInviteCode(String inviteCode) { this.inviteCode = inviteCode; }
    public boolean getIsHost() { return isHost; }
    public void setIsHost(boolean host) { isHost = host; }
    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
}
