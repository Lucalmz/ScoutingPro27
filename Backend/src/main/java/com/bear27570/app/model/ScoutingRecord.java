package com.bear27570.app.model;

public class ScoutingRecord {
    private String id;
    private String eventId;
    private String scoutId;
    private String scoutName;
    private int matchNumber;
    private int teamNumber;
    private int autoScore;
    private int teleopScore;
    private int endgameScore;
    private int totalScore;
    private String notes;
    private String rawData;
    private String syncStatus;
    private String createdAt;
    private String updatedAt;
    private boolean isBroken;
    private boolean isDeleted;
    /** 记录级逻辑版本号，每次编辑 +1，用于 LWW 冲突解决 */
    private int version;
    /** Host 分配的全局序列号，用于 Client 增量同步请求 */
    private Integer hostSeq;

    public ScoutingRecord() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }
    public String getScoutId() { return scoutId; }
    public void setScoutId(String scoutId) { this.scoutId = scoutId; }
    public String getScoutName() { return scoutName; }
    public void setScoutName(String scoutName) { this.scoutName = scoutName; }
    public int getMatchNumber() { return matchNumber; }
    public void setMatchNumber(int matchNumber) { this.matchNumber = matchNumber; }
    public int getTeamNumber() { return teamNumber; }
    public void setTeamNumber(int teamNumber) { this.teamNumber = teamNumber; }
    public int getAutoScore() { return autoScore; }
    public void setAutoScore(int autoScore) { this.autoScore = autoScore; }
    public int getTeleopScore() { return teleopScore; }
    public void setTeleopScore(int teleopScore) { this.teleopScore = teleopScore; }
    public int getEndgameScore() { return endgameScore; }
    public void setEndgameScore(int endgameScore) { this.endgameScore = endgameScore; }
    public int getTotalScore() { return totalScore; }
    public void setTotalScore(int totalScore) { this.totalScore = totalScore; }
    public String getNotes() { return notes; }
    public void setNotes(String notes) { this.notes = notes; }
    public String getRawData() { return rawData; }
    public void setRawData(String rawData) { this.rawData = rawData; }
    public String getSyncStatus() { return syncStatus; }
    public void setSyncStatus(String syncStatus) { this.syncStatus = syncStatus; }
    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
    public boolean getIsBroken() { return isBroken; }
    public void setIsBroken(boolean isBroken) { this.isBroken = isBroken; }
    public boolean getIsDeleted() { return isDeleted; }
    public boolean isDeleted() { return isDeleted; }
    public void setIsDeleted(boolean isDeleted) { this.isDeleted = isDeleted; }
    public void setDeleted(boolean deleted) { this.isDeleted = deleted; }
    public int getVersion() { return version; }
    public void setVersion(int version) { this.version = version; }
    /** hostSeq 以 Host 最新分配为准，允许覆盖 */
    public Integer getHostSeq() { return hostSeq; }
    public void setHostSeq(Integer hostSeq) { this.hostSeq = hostSeq; }
}
