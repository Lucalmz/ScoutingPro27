package com.bear27570.app.model;

public class PitScoutingRecord {
    private String id;
    private String eventId;
    private int teamNumber;
    private String scoutId;
    private String scoutName;
    private String robotName;

    // 核心硬件构型 (Hardware Essentials)
    private String drivetrainType = "mecanum";
    private double weightLbs = 0.0;
    private boolean sizingPassed = true;
    private String mechanismType = "slide_claw";
    private String hangType = "winch";
    private String odometryType = "none";

    // 核心量化自述指标 (Claimed Quantitative Performance)
    private int claimedAutoScore = 0;
    private int claimedAutoPieces = 0;
    private int claimedAutoHangLevel = 0;
    private int claimedTeleopScore = 0;
    private double claimedTeleopCycleSec = 0.0;
    private int claimedEndgameHangLevel = 0;
    private double claimedEndgameTimeSec = 0.0;
    private int claimedTotalScore = 0;

    // 图片与版本
    private String photoKeys;
    private int version = 1;
    private Integer hostSeq;
    private boolean isDeleted = false;
    private String createdAt;
    private String updatedAt;

    public PitScoutingRecord() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public int getTeamNumber() { return teamNumber; }
    public void setTeamNumber(int teamNumber) { this.teamNumber = teamNumber; }

    public String getScoutId() { return scoutId; }
    public void setScoutId(String scoutId) { this.scoutId = scoutId; }

    public String getScoutName() { return scoutName; }
    public void setScoutName(String scoutName) { this.scoutName = scoutName; }

    public String getRobotName() { return robotName; }
    public void setRobotName(String robotName) { this.robotName = robotName; }

    public String getDrivetrainType() { return drivetrainType; }
    public void setDrivetrainType(String drivetrainType) { this.drivetrainType = drivetrainType; }

    public double getWeightLbs() { return weightLbs; }
    public void setWeightLbs(double weightLbs) { this.weightLbs = weightLbs; }

    public boolean isSizingPassed() { return sizingPassed; }
    public void setSizingPassed(boolean sizingPassed) { this.sizingPassed = sizingPassed; }

    public String getMechanismType() { return mechanismType; }
    public void setMechanismType(String mechanismType) { this.mechanismType = mechanismType; }

    public String getHangType() { return hangType; }
    public void setHangType(String hangType) { this.hangType = hangType; }

    public String getOdometryType() { return odometryType; }
    public void setOdometryType(String odometryType) { this.odometryType = odometryType; }

    public int getClaimedAutoScore() { return claimedAutoScore; }
    public void setClaimedAutoScore(int claimedAutoScore) { this.claimedAutoScore = claimedAutoScore; }

    public int getClaimedAutoPieces() { return claimedAutoPieces; }
    public void setClaimedAutoPieces(int claimedAutoPieces) { this.claimedAutoPieces = claimedAutoPieces; }

    public int getClaimedAutoHangLevel() { return claimedAutoHangLevel; }
    public void setClaimedAutoHangLevel(int claimedAutoHangLevel) { this.claimedAutoHangLevel = claimedAutoHangLevel; }

    public int getClaimedTeleopScore() { return claimedTeleopScore; }
    public void setClaimedTeleopScore(int claimedTeleopScore) { this.claimedTeleopScore = claimedTeleopScore; }

    public double getClaimedTeleopCycleSec() { return claimedTeleopCycleSec; }
    public void setClaimedTeleopCycleSec(double claimedTeleopCycleSec) { this.claimedTeleopCycleSec = claimedTeleopCycleSec; }

    public int getClaimedEndgameHangLevel() { return claimedEndgameHangLevel; }
    public void setClaimedEndgameHangLevel(int claimedEndgameHangLevel) { this.claimedEndgameHangLevel = claimedEndgameHangLevel; }

    public double getClaimedEndgameTimeSec() { return claimedEndgameTimeSec; }
    public void setClaimedEndgameTimeSec(double claimedEndgameTimeSec) { this.claimedEndgameTimeSec = claimedEndgameTimeSec; }

    public int getClaimedTotalScore() { return claimedTotalScore; }
    public void setClaimedTotalScore(int claimedTotalScore) { this.claimedTotalScore = claimedTotalScore; }

    public String getPhotoKeys() { return photoKeys; }
    public void setPhotoKeys(String photoKeys) { this.photoKeys = photoKeys; }

    public int getVersion() { return version; }
    public void setVersion(int version) { this.version = version; }

    public Integer getHostSeq() { return hostSeq; }
    public void setHostSeq(Integer hostSeq) { this.hostSeq = hostSeq; }

    public boolean getIsDeleted() { return isDeleted; }
    public boolean isDeleted() { return isDeleted; }
    public void setIsDeleted(boolean isDeleted) { this.isDeleted = isDeleted; }
    public void setDeleted(boolean deleted) { this.isDeleted = deleted; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
