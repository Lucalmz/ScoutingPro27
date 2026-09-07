package com.bear27570.app.model;

public class EventMember {
    private String id;
    private String username;
    private boolean host;

    public EventMember() {}

    public EventMember(String id, String username, boolean host) {
        this.id = id;
        this.username = username;
        this.host = host;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public boolean isHost() {
        return host;
    }

    public void setHost(boolean host) {
        this.host = host;
    }
}
