package com.bear27570.app.model;

public class PitScoutingRecord {
    private String id;
    private String eventId;
    private int teamNumber;
    private String scoutId;
    private String scoutName;
    private String robotName;

    // 核心硬件构型 (Hardware Essentials - 2026-2027 BIOBUZZ)
    private String drivetrainType = "mecanum";
    private double weightLbs = 0.0;
    private String odometryType = "none";
    private String ballCompatibility = "universal";
    private String launcherType = "";
    private String flowerMechanism = "";
    private boolean hasColorSensor = false;

    // 核心量化自述指标 (Claimed Quantitative Performance - 2026-2027 BIOBUZZ)
    private String claimedAutoStrategy = "";
    private int claimedAutoScore = 0;
    private int claimedTeleopCycles = 0;
    private int claimedTeleopScore = 0;
    private int claimedEndgameScore = 0;
    private int claimedTotalScore = 0;

    // 图片与版本
    @com.google.gson.annotations.JsonAdapter(com.bear27570.app.util.StringListTypeAdapter.class)
    private java.util.List<String> photoKeys = new java.util.ArrayList<>();
    private int version = 1;
    private Integer hostSeq;
    private boolean isDeleted = false;
    private String rawData;
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

    public String getOdometryType() { return odometryType; }
    public void setOdometryType(String odometryType) { this.odometryType = odometryType; }

    public String getBallCompatibility() { return ballCompatibility; }
    public void setBallCompatibility(String ballCompatibility) { this.ballCompatibility = ballCompatibility; }

    public String getLauncherType() { return launcherType; }
    public void setLauncherType(String launcherType) { this.launcherType = launcherType; }

    public String getFlowerMechanism() { return flowerMechanism; }
    public void setFlowerMechanism(String flowerMechanism) { this.flowerMechanism = flowerMechanism; }

    public boolean isHasColorSensor() { return hasColorSensor; }
    public boolean getHasColorSensor() { return hasColorSensor; }
    public void setHasColorSensor(boolean hasColorSensor) { this.hasColorSensor = hasColorSensor; }

    public String getClaimedAutoStrategy() { return claimedAutoStrategy; }
    public void setClaimedAutoStrategy(String claimedAutoStrategy) { this.claimedAutoStrategy = claimedAutoStrategy; }

    public int getClaimedAutoScore() { return claimedAutoScore; }
    public void setClaimedAutoScore(int claimedAutoScore) { this.claimedAutoScore = claimedAutoScore; }

    public int getClaimedTeleopCycles() { return claimedTeleopCycles; }
    public void setClaimedTeleopCycles(int claimedTeleopCycles) { this.claimedTeleopCycles = claimedTeleopCycles; }

    public int getClaimedTeleopScore() { return claimedTeleopScore; }
    public void setClaimedTeleopScore(int claimedTeleopScore) { this.claimedTeleopScore = claimedTeleopScore; }

    public int getClaimedEndgameScore() { return claimedEndgameScore; }
    public void setClaimedEndgameScore(int claimedEndgameScore) { this.claimedEndgameScore = claimedEndgameScore; }

    public int getClaimedTotalScore() { return claimedTotalScore; }
    public void setClaimedTotalScore(int claimedTotalScore) { this.claimedTotalScore = claimedTotalScore; }

    public java.util.List<String> getPhotoKeys() {
        return photoKeys != null ? photoKeys : new java.util.ArrayList<>();
    }
    public void setPhotoKeys(java.util.List<String> photoKeys) {
        this.photoKeys = photoKeys != null ? photoKeys : new java.util.ArrayList<>();
    }

    public int getVersion() { return version; }
    public void setVersion(int version) { this.version = version; }

    public Integer getHostSeq() { return hostSeq; }
    public void setHostSeq(Integer hostSeq) { this.hostSeq = hostSeq; }

    public boolean getIsDeleted() { return isDeleted; }
    public boolean isDeleted() { return isDeleted; }
    public void setIsDeleted(boolean isDeleted) { this.isDeleted = isDeleted; }
    public void setDeleted(boolean deleted) { this.isDeleted = deleted; }

    public String getRawData() { return rawData; }
    public void setRawData(String rawData) { this.rawData = rawData; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}