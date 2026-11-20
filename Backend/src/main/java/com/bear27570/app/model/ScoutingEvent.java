package com.bear27570.app.model;

public class ScoutingEvent {
    private String id;
    private String name;
    private String inviteCode;
    private String hostId;
    private String createdAt;

    private Integer ftcYear;
    private String ftcEventCode;
    private String turnConfigEncrypted;
    private TurnServerConfig customTurnConfig;
    private Boolean hasCustomTurn;

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
    public String getTurnConfigEncrypted() { return turnConfigEncrypted; }
    public void setTurnConfigEncrypted(String turnConfigEncrypted) { this.turnConfigEncrypted = turnConfigEncrypted; }
    public TurnServerConfig getCustomTurnConfig() { return customTurnConfig; }
    public void setCustomTurnConfig(TurnServerConfig customTurnConfig) { this.customTurnConfig = customTurnConfig; }
    public Boolean getHasCustomTurn() { return hasCustomTurn; }
    public void setHasCustomTurn(Boolean hasCustomTurn) { this.hasCustomTurn = hasCustomTurn; }
}
