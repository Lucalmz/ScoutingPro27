package com.bear27570.app.model;

public class OfficialTeam {
    private String eventId;
    private int teamNumber;
    private String nameFull;
    private String robotName;
    private String city;
    private String country;
    private String updatedAt;

    public OfficialTeam() {}

    public OfficialTeam(String eventId, int teamNumber, String nameFull, String robotName, String city, String country) {
        this.eventId = eventId;
        this.teamNumber = teamNumber;
        this.nameFull = nameFull;
        this.robotName = robotName;
        this.city = city;
        this.country = country;
    }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public int getTeamNumber() { return teamNumber; }
    public void setTeamNumber(int teamNumber) { this.teamNumber = teamNumber; }

    public String getNameFull() { return nameFull; }
    public void setNameFull(String nameFull) { this.nameFull = nameFull; }

    public String getRobotName() { return robotName; }
    public void setRobotName(String robotName) { this.robotName = robotName; }

    public String getCity() { return city; }
    public void setCity(String city) { this.city = city; }

    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
