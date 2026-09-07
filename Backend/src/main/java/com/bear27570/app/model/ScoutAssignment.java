package com.bear27570.app.model;

public class ScoutAssignment {
    private String id;
    private String eventId;
    private int matchNumber;
    private String tournamentLevel;
    private String station; // 'red1', 'red2', 'blue1', 'blue2'
    private int teamNumber;
    private String scoutId;   // nullable (supports unassigned/blank)
    private String scoutName; // nullable (supports unassigned/blank)
    private String updatedAt;

    public ScoutAssignment() {}

    public ScoutAssignment(String id, String eventId, int matchNumber, String tournamentLevel, String station, int teamNumber, String scoutId, String scoutName) {
        this.id = id;
        this.eventId = eventId;
        this.matchNumber = matchNumber;
        this.tournamentLevel = tournamentLevel != null && !tournamentLevel.isBlank() ? tournamentLevel : "QUALIFICATION";
        this.station = station;
        this.teamNumber = teamNumber;
        this.scoutId = scoutId;
        this.scoutName = scoutName;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public int getMatchNumber() { return matchNumber; }
    public void setMatchNumber(int matchNumber) { this.matchNumber = matchNumber; }

    public String getTournamentLevel() { return tournamentLevel; }
    public void setTournamentLevel(String tournamentLevel) { this.tournamentLevel = tournamentLevel; }

    public String getStation() { return station; }
    public void setStation(String station) { this.station = station; }

    public int getTeamNumber() { return teamNumber; }
    public void setTeamNumber(int teamNumber) { this.teamNumber = teamNumber; }

    public String getScoutId() { return scoutId; }
    public void setScoutId(String scoutId) { this.scoutId = scoutId; }

    public String getScoutName() { return scoutName; }
    public void setScoutName(String scoutName) { this.scoutName = scoutName; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
