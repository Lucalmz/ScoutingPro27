package com.bear27570.app.model;

public class MatchScheduleItem {
    private String id;
    private String eventId;
    private int matchNumber;
    private String tournamentLevel;
    private int red1;
    private int red2;
    private int blue1;
    private int blue2;
    private String createdAt;

    public MatchScheduleItem() {}

    public MatchScheduleItem(String id, String eventId, int matchNumber, String tournamentLevel, int red1, int red2, int blue1, int blue2) {
        this.id = id;
        this.eventId = eventId;
        this.matchNumber = matchNumber;
        this.tournamentLevel = tournamentLevel != null && !tournamentLevel.isBlank() ? tournamentLevel : "QUALIFICATION";
        this.red1 = red1;
        this.red2 = red2;
        this.blue1 = blue1;
        this.blue2 = blue2;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public int getMatchNumber() { return matchNumber; }
    public void setMatchNumber(int matchNumber) { this.matchNumber = matchNumber; }

    public String getTournamentLevel() { return tournamentLevel; }
    public void setTournamentLevel(String tournamentLevel) { this.tournamentLevel = tournamentLevel; }

    public int getRed1() { return red1; }
    public void setRed1(int red1) { this.red1 = red1; }

    public int getRed2() { return red2; }
    public void setRed2(int red2) { this.red2 = red2; }

    public int getBlue1() { return blue1; }
    public void setBlue1(int blue1) { this.blue1 = blue1; }

    public int getBlue2() { return blue2; }
    public void setBlue2(int blue2) { this.blue2 = blue2; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
}
