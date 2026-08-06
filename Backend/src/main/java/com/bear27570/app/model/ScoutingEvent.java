package com.bear27570.app.model;

public class ScoutingEvent {
    private String id;
    private String name;
    private String inviteCode;
    private String hostId;
    private String createdAt;

    private Integer ftcYear;
    private String ftcEventCode;

    public ScoutingEvent() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getInviteCode() { return inviteCode; }
    public void setInviteCode(String inviteCode) { this.inviteCode = inviteCode; }
    public String getHostId() { return hostId; }
    public void setHostId(String hostId) { this.hostId = hostId; }
    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
    public Integer getFtcYear() { return ftcYear; }
    public void setFtcYear(Integer ftcYear) { this.ftcYear = ftcYear; }
    public String getFtcEventCode() { return ftcEventCode; }
    public void setFtcEventCode(String ftcEventCode) { this.ftcEventCode = ftcEventCode; }
}
