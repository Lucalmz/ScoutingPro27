package com.bear27570.app.model;

import java.sql.Timestamp;

public class AiSettings {
    private String userId;
    private String provider;
    private String apiKeyEncrypted;
    private String modelName;
    private String systemPrompt;
    private String proxyHost;
    private Integer proxyPort; // Integer so it can be null
    private String baseUrl;
    private Timestamp createdAt;
    private Timestamp updatedAt;

    public AiSettings() {
    }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public String getApiKeyEncrypted() { return apiKeyEncrypted; }
    public void setApiKeyEncrypted(String apiKeyEncrypted) { this.apiKeyEncrypted = apiKeyEncrypted; }

    public String getModelName() { return modelName; }
    public void setModelName(String modelName) { this.modelName = modelName; }

    public String getSystemPrompt() { return systemPrompt; }
    public void setSystemPrompt(String systemPrompt) { this.systemPrompt = systemPrompt; }

    public String getProxyHost() { return proxyHost; }
    public void setProxyHost(String proxyHost) { this.proxyHost = proxyHost; }

    public Integer getProxyPort() { return proxyPort; }
    public void setProxyPort(Integer proxyPort) { this.proxyPort = proxyPort; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public Timestamp getCreatedAt() { return createdAt; }
    public void setCreatedAt(Timestamp createdAt) { this.createdAt = createdAt; }

    public Timestamp getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Timestamp updatedAt) { this.updatedAt = updatedAt; }
}
