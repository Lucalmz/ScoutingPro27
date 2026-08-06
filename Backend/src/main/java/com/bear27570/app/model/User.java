package com.bear27570.app.model;

public class User {
    private String id;
    private String username;
    private String password;
    private String createdAt;

    public User() {}

    public User(String id, String username) {
        this.id = id;
        this.username = username;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }
}
