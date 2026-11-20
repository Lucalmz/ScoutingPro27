package com.bear27570.app.model;

import java.util.List;

public class TurnServerConfig {
    private List<String> urls;
    private String username;
    private String credential;

    public TurnServerConfig() {}

    public TurnServerConfig(List<String> urls, String username, String credential) {
        this.urls = urls;
        this.username = username;
        this.credential = credential;
    }

    public List<String> getUrls() {
        return urls;
    }

    public void setUrls(List<String> urls) {
        this.urls = urls;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getCredential() {
        return credential;
    }

    public void setCredential(String credential) {
        this.credential = credential;
    }
}
