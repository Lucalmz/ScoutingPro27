package com.bear27570.app.model;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;

public class AiProviderProfile {
    private static final Gson GSON = new Gson();
    private static final Type STRING_LIST_TYPE = new TypeToken<List<String>>() {}.getType();

    private String id;
    private String userId;
    private String name;
    private String presetId = "custom";
    private String protocol = "OPENAI";
    private String apiKeyEncrypted = "";
    private String baseUrl = "";
    private String modelName = "";
    private String customModelsJson = "[]";
    private String systemPrompt = "";
    private Double temperature = 0.4;
    private Integer maxTokens = 4096;
    private boolean enableThinking = false;
    private Integer thinkingBudget = 4096;
    private String anthropicVersion = "2023-06-01";
    private Integer maxContextMsgs = 16;
    private String proxyHost = "";
    private Integer proxyPort;
    private boolean isActive = false;
    private Timestamp createdAt;
    private Timestamp updatedAt;

    // Virtual / API response fields (not persisted directly as SQL columns)
    private boolean hasApiKey;
    private List<String> customModels;

    public AiProviderProfile() {
    }

    public static AiProviderProfile fromLegacy(AiSettings settings) {
        AiProviderProfile profile = new AiProviderProfile();
        if (settings == null) {
            return profile;
        }
        String provider = settings.getProvider() != null ? settings.getProvider().trim().toUpperCase() : "OPENAI";
        profile.setId("legacy-" + provider.toLowerCase());
        profile.setUserId(settings.getUserId());
        profile.setProtocol(provider);
        profile.setName("GEMINI".equals(provider) ? "Google Gemini" : "OpenAI Compatible");
        profile.setPresetId("GEMINI".equals(provider) ? "gemini-official" : "custom");
        profile.setApiKeyEncrypted(settings.getApiKeyEncrypted() != null ? settings.getApiKeyEncrypted() : "");
        profile.setBaseUrl(settings.getBaseUrl() != null ? settings.getBaseUrl() : "");
        profile.setModelName(settings.getModelName() != null ? settings.getModelName() : "");
        profile.setSystemPrompt(settings.getSystemPrompt() != null ? settings.getSystemPrompt() : "");
        profile.setProxyHost(settings.getProxyHost() != null ? settings.getProxyHost() : "");
        profile.setProxyPort(settings.getProxyPort());
        if ("GEMINI".equals(provider)) {
            profile.setCustomModels(List.of("gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest"));
        } else {
            profile.setCustomModels(new ArrayList<>());
        }
        return profile;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getPresetId() { return presetId; }
    public void setPresetId(String presetId) { this.presetId = presetId; }

    public String getProtocol() { return protocol; }
    public void setProtocol(String protocol) { this.protocol = protocol; }

    public String getApiKeyEncrypted() { return apiKeyEncrypted; }
    public void setApiKeyEncrypted(String apiKeyEncrypted) { this.apiKeyEncrypted = apiKeyEncrypted; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public String getModelName() { return modelName; }
    public void setModelName(String modelName) { this.modelName = modelName; }

    public String getCustomModelsJson() { return customModelsJson; }
    public void setCustomModelsJson(String customModelsJson) {
        this.customModelsJson = customModelsJson != null ? customModelsJson : "[]";
        this.customModels = parseCustomModels(this.customModelsJson);
    }

    public String getSystemPrompt() { return systemPrompt; }
    public void setSystemPrompt(String systemPrompt) { this.systemPrompt = systemPrompt; }

    public Double getTemperature() { return temperature; }
    public void setTemperature(Double temperature) { this.temperature = temperature; }

    public Integer getMaxTokens() { return maxTokens; }
    public void setMaxTokens(Integer maxTokens) { this.maxTokens = maxTokens; }

    public boolean getEnableThinking() { return enableThinking; }
    public void setEnableThinking(boolean enableThinking) { this.enableThinking = enableThinking; }

    public Integer getThinkingBudget() { return thinkingBudget; }
    public void setThinkingBudget(Integer thinkingBudget) { this.thinkingBudget = thinkingBudget; }

    public String getAnthropicVersion() { return anthropicVersion; }
    public void setAnthropicVersion(String anthropicVersion) { this.anthropicVersion = anthropicVersion; }

    public Integer getMaxContextMsgs() { return maxContextMsgs; }
    public void setMaxContextMsgs(Integer maxContextMsgs) { this.maxContextMsgs = maxContextMsgs; }

    public String getProxyHost() { return proxyHost; }
    public void setProxyHost(String proxyHost) { this.proxyHost = proxyHost; }

    public Integer getProxyPort() { return proxyPort; }
    public void setProxyPort(Integer proxyPort) { this.proxyPort = proxyPort; }

    public boolean getIsActive() { return isActive; }
    public void setIsActive(boolean isActive) { this.isActive = isActive; }

    public Timestamp getCreatedAt() { return createdAt; }
    public void setCreatedAt(Timestamp createdAt) { this.createdAt = createdAt; }

    public Timestamp getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Timestamp updatedAt) { this.updatedAt = updatedAt; }

    public boolean isHasApiKey() { return hasApiKey; }
    public boolean getHasApiKey() { return hasApiKey; }
    public void setHasApiKey(boolean hasApiKey) { this.hasApiKey = hasApiKey; }

    public List<String> getCustomModels() {
        if (customModels == null) {
            customModels = parseCustomModels(customModelsJson);
        }
        return customModels;
    }

    public void setCustomModels(List<String> customModels) {
        this.customModels = customModels != null ? new ArrayList<>(customModels) : new ArrayList<>();
        this.customModelsJson = GSON.toJson(this.customModels);
    }

    private static List<String> parseCustomModels(String json) {
        if (json == null || json.isBlank()) {
            return new ArrayList<>();
        }
        try {
            List<String> parsed = GSON.fromJson(json, STRING_LIST_TYPE);
            return parsed != null ? parsed : new ArrayList<>();
        } catch (Exception ignored) {
            return new ArrayList<>();
        }
    }
}
