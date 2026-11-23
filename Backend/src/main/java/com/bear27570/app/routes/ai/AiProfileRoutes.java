package com.bear27570.app.routes.ai;

import com.bear27570.app.dao.AiProviderProfileDao;
import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.AiClient;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * HTTP routes for multi-profile AI provider management and legacy `/ai-settings` backwards compatibility.
 */
public final class AiProfileRoutes {
    private final Jdbi jdbi;
    private final Gson gson;

    public AiProfileRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        // Legacy user AI settings endpoints
        routes.get("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot access settings of another user");
            }

            List<AiSettings> settings = jdbi.withExtension(
                    AiSettingsDao.class,
                    dao -> dao.findByUserId(sessionUserId)
            );
            for (AiSettings s : settings) {
                s.setApiKeyEncrypted(AiUrlGuard.maskEncryptedKey(s.getApiKeyEncrypted()));
            }
            ctx.result(gson.toJson(settings)).contentType("application/json");
        });

        routes.post("/api/users/{userId}/ai-settings", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify settings of another user");
            }

            AiSettings newSettings;
            try {
                newSettings = gson.fromJson(ctx.body(), AiSettings.class);
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body: " + e.getMessage()))).contentType("application/json");
                return;
            }

            if (newSettings == null || newSettings.getProvider() == null || newSettings.getProvider().isBlank()) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body or missing provider"))).contentType("application/json");
                return;
            }
            newSettings.setUserId(sessionUserId);

            try {
                jdbi.useExtension(AiSettingsDao.class, dao -> {
                    AiSettings existing = dao.findByUserIdAndProvider(sessionUserId, newSettings.getProvider());

                    String submittedKey = newSettings.getApiKeyEncrypted();
                    if (AiUrlGuard.isBlankOrMasked(submittedKey)) {
                        if (existing != null && existing.getApiKeyEncrypted() != null && !existing.getApiKeyEncrypted().isBlank()) {
                            newSettings.setApiKeyEncrypted(existing.getApiKeyEncrypted());
                        } else {
                            throw new IllegalArgumentException("API Key is required for new provider configuration");
                        }
                    } else {
                        newSettings.setApiKeyEncrypted(AESUtil.encrypt(submittedKey.trim()));
                    }

                    dao.upsert(newSettings);
                });

                ctx.status(200).result(gson.toJson(Map.of("success", true))).contentType("application/json");
            } catch (IllegalArgumentException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage() != null ? e.getMessage() : "Invalid argument"))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save settings: " + (e.getMessage() != null ? e.getMessage() : e.toString())))).contentType("application/json");
            }
        });

        // Multi-profile AI configuration endpoints
        routes.get("/api/users/{userId}/ai-profiles", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot access AI profiles of another user");
            }

            List<AiProviderProfile> profiles = ensureProfilesMigrated(sessionUserId);
            for (AiProviderProfile profile : profiles) {
                prepareProfileForResponse(profile);
            }
            ctx.result(gson.toJson(profiles)).contentType("application/json");
        });

        routes.post("/api/users/{userId}/ai-profiles", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify AI profiles of another user");
            }

            JsonObject bodyObj;
            try {
                JsonElement el = JsonParser.parseString(ctx.body());
                if (!el.isJsonObject()) {
                    ctx.status(400).result(gson.toJson(Map.of("error", "Request body must be a JSON object"))).contentType("application/json");
                    return;
                }
                bodyObj = el.getAsJsonObject();
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid JSON body: " + e.getMessage()))).contentType("application/json");
                return;
            }

            AiProviderProfile incoming;
            try {
                incoming = gson.fromJson(bodyObj, AiProviderProfile.class);
            } catch (Exception e) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Invalid profile fields: " + e.getMessage()))).contentType("application/json");
                return;
            }
            if (incoming == null) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Missing profile payload"))).contentType("application/json");
                return;
            }

            String protocol = incoming.getProtocol() != null ? incoming.getProtocol().trim().toUpperCase(Locale.ROOT) : "";
            if (!"OPENAI".equals(protocol) && !"GEMINI".equals(protocol) && !"ANTHROPIC".equals(protocol)) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Unsupported AI protocol: " + protocol))).contentType("application/json");
                return;
            }
            incoming.setProtocol(protocol);
            incoming.setUserId(sessionUserId);

            if (incoming.getBaseUrl() != null && !incoming.getBaseUrl().isBlank() && !AiUrlGuard.isSafeUrl(incoming.getBaseUrl().trim())) {
                ctx.status(400).result(gson.toJson(Map.of("error", "Forbidden baseUrl: SSRF protection blocked access"))).contentType("application/json");
                return;
            }
            incoming.setBaseUrl(incoming.getBaseUrl() != null ? incoming.getBaseUrl().trim() : "");

            normalizeProfileDefaults(incoming, protocol, bodyObj);

            String submittedKey = bodyObj.has("apiKey") && !bodyObj.get("apiKey").isJsonNull()
                    ? bodyObj.get("apiKey").getAsString()
                    : incoming.getApiKeyEncrypted();

            try {
                AiProviderProfile saved = jdbi.inTransaction(handle -> {
                    AiProviderProfileDao dao = handle.attach(AiProviderProfileDao.class);
                    List<AiProviderProfile> existingAll = dao.findByUserId(sessionUserId);

                    AiProviderProfile existing = null;
                    if (incoming.getId() != null && !incoming.getId().isBlank()) {
                        existing = dao.findByIdAndUserId(incoming.getId().trim(), sessionUserId);
                    } else {
                        incoming.setId("prof-" + UUID.randomUUID());
                    }

                    boolean isLocalOpenAi = "OPENAI".equals(protocol) && AiClient.isLoopbackUrl(incoming.getBaseUrl());
                    if (AiUrlGuard.isBlankOrMasked(submittedKey)) {
                        if (existing != null && existing.getApiKeyEncrypted() != null && !existing.getApiKeyEncrypted().isBlank() && !"ERR_KEY_LOST".equals(submittedKey)) {
                            incoming.setApiKeyEncrypted(existing.getApiKeyEncrypted());
                        } else if (isLocalOpenAi && (submittedKey == null || submittedKey.isBlank())) {
                            incoming.setApiKeyEncrypted("");
                        } else if (existing != null && isLocalOpenAi && (existing.getApiKeyEncrypted() == null || existing.getApiKeyEncrypted().isBlank())) {
                            incoming.setApiKeyEncrypted("");
                        } else {
                            throw new IllegalArgumentException("API Key is required for non-local AI provider profile");
                        }
                    } else {
                        incoming.setApiKeyEncrypted(AESUtil.encrypt(submittedKey.trim()));
                    }

                    if (existing == null && "GEMINI".equals(protocol) && incoming.getCustomModels().isEmpty()) {
                        incoming.setCustomModels(List.of("gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest"));
                    }

                    boolean shouldActivate = incoming.getIsActive() || existingAll.isEmpty()
                            || (existing != null && existing.getIsActive() && !bodyObj.has("isActive"));
                    if (shouldActivate) {
                        dao.clearActiveForUser(sessionUserId);
                        incoming.setIsActive(true);
                    }

                    dao.upsert(incoming);
                    return dao.findByIdAndUserId(incoming.getId(), sessionUserId);
                });

                prepareProfileForResponse(saved);
                ctx.status(200).result(gson.toJson(saved)).contentType("application/json");
            } catch (IllegalArgumentException e) {
                ctx.status(400).result(gson.toJson(Map.of("error", e.getMessage()))).contentType("application/json");
            } catch (Exception e) {
                ctx.status(500).result(gson.toJson(Map.of("error", "Failed to save AI profile: " + (e.getMessage() != null ? e.getMessage() : e.toString())))).contentType("application/json");
            }
        });

        routes.post("/api/users/{userId}/ai-profiles/{profileId}/activate", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String profileId = ctx.pathParam("profileId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify AI profiles of another user");
            }

            boolean found = jdbi.inTransaction(handle -> {
                AiProviderProfileDao dao = handle.attach(AiProviderProfileDao.class);
                AiProviderProfile target = dao.findByIdAndUserId(profileId, sessionUserId);
                if (target == null) {
                    return false;
                }
                dao.clearActiveForUser(sessionUserId);
                dao.setActive(profileId, sessionUserId);
                return true;
            });

            if (!found) {
                ctx.status(404).result(gson.toJson(Map.of("error", "AI profile not found"))).contentType("application/json");
                return;
            }
            ctx.status(200).result(gson.toJson(Map.of("success", true, "activeProfileId", profileId))).contentType("application/json");
        });

        routes.delete("/api/users/{userId}/ai-profiles/{profileId}", ctx -> {
            String pathUserId = ctx.pathParam("userId");
            String profileId = ctx.pathParam("profileId");
            String sessionUserId = ctx.attribute("userId");
            if (!pathUserId.equals(sessionUserId)) {
                throw new io.javalin.http.ForbiddenResponse("Cannot modify AI profiles of another user");
            }

            Map<String, Object> result = jdbi.inTransaction(handle -> {
                AiProviderProfileDao dao = handle.attach(AiProviderProfileDao.class);
                AiProviderProfile target = dao.findByIdAndUserId(profileId, sessionUserId);
                if (target == null) {
                    return null;
                }
                dao.deleteByIdAndUserId(profileId, sessionUserId);
                String nextActiveId = null;
                if (target.getIsActive()) {
                    List<AiProviderProfile> remaining = dao.findByUserId(sessionUserId);
                    if (!remaining.isEmpty()) {
                        nextActiveId = remaining.get(0).getId();
                        dao.setActive(nextActiveId, sessionUserId);
                    }
                } else {
                    AiProviderProfile active = dao.findActiveByUserId(sessionUserId);
                    if (active != null) {
                        nextActiveId = active.getId();
                    }
                }
                Map<String, Object> map = new HashMap<>();
                map.put("success", true);
                map.put("nextActiveProfileId", nextActiveId);
                return map;
            });

            if (result == null) {
                ctx.status(404).result(gson.toJson(Map.of("error", "AI profile not found"))).contentType("application/json");
                return;
            }
            ctx.status(200).result(gson.toJson(result)).contentType("application/json");
        });
    }

    public static AiProviderProfile resolveProfileForChat(Jdbi jdbi, String sessionUserId, String profileId, String provider) {
        if (profileId != null && !profileId.isBlank()) {
            AiProviderProfile p = jdbi.withExtension(AiProviderProfileDao.class, dao -> dao.findByIdAndUserId(profileId.trim(), sessionUserId));
            if (p != null) {
                return p;
            }
        }
        if (provider != null && !provider.isBlank()) {
            String normalized = provider.trim().toUpperCase(Locale.ROOT);
            AiSettings legacy = jdbi.withExtension(AiSettingsDao.class, dao -> dao.findByUserIdAndProvider(sessionUserId, normalized));
            if (legacy != null) {
                return AiProviderProfile.fromLegacy(legacy);
            }
            List<AiProviderProfile> profiles = jdbi.withExtension(AiProviderProfileDao.class, dao -> dao.findByUserId(sessionUserId));
            for (AiProviderProfile p : profiles) {
                if (normalized.equalsIgnoreCase(p.getProtocol()) && p.getIsActive()) {
                    return p;
                }
            }
            for (AiProviderProfile p : profiles) {
                if (normalized.equalsIgnoreCase(p.getProtocol())) {
                    return p;
                }
            }
        }
        return null;
    }

    private List<AiProviderProfile> ensureProfilesMigrated(String userId) {
        return jdbi.inTransaction(handle -> {
            AiProviderProfileDao profileDao = handle.attach(AiProviderProfileDao.class);
            List<AiProviderProfile> existing = profileDao.findByUserId(userId);
            if (!existing.isEmpty()) {
                return existing;
            }

            AiSettingsDao legacyDao = handle.attach(AiSettingsDao.class);
            List<AiSettings> legacyList = legacyDao.findByUserId(userId);
            if (legacyList.isEmpty()) {
                return List.of();
            }

            boolean activatedOne = false;
            for (AiSettings s : legacyList) {
                AiProviderProfile p = AiProviderProfile.fromLegacy(s);
                p.setId("migrated-" + UUID.randomUUID());
                p.setName(defaultProfileName(p.getProtocol(), p.getBaseUrl()) + " (Migrated)");
                p.setPresetId(detectPresetId(p.getProtocol(), p.getBaseUrl()));
                boolean hasValidKey = p.getApiKeyEncrypted() != null && !p.getApiKeyEncrypted().isBlank();
                if (!activatedOne && (hasValidKey || legacyList.indexOf(s) == legacyList.size() - 1)) {
                    p.setIsActive(true);
                    activatedOne = true;
                }
                profileDao.upsert(p);
            }
            return profileDao.findByUserId(userId);
        });
    }

    private static void normalizeProfileDefaults(AiProviderProfile incoming, String protocol, JsonObject bodyObj) {
        if (incoming.getName() == null || incoming.getName().isBlank()) {
            incoming.setName(defaultProfileName(protocol, incoming.getBaseUrl()));
        } else {
            incoming.setName(incoming.getName().trim());
        }
        if (incoming.getPresetId() == null || incoming.getPresetId().isBlank()) {
            incoming.setPresetId("custom");
        }
        incoming.setModelName(incoming.getModelName() != null ? incoming.getModelName().trim() : "");
        if (incoming.getAnthropicVersion() == null || incoming.getAnthropicVersion().isBlank()) {
            incoming.setAnthropicVersion("2023-06-01");
        }
        if (incoming.getTemperature() == null) {
            incoming.setTemperature(0.4);
        }
        if (incoming.getMaxTokens() == null || incoming.getMaxTokens() <= 0) {
            incoming.setMaxTokens(4096);
        }
        if (incoming.getThinkingBudget() == null || incoming.getThinkingBudget() < 1024) {
            incoming.setThinkingBudget(4096);
        }
        if (incoming.getMaxContextMsgs() == null || incoming.getMaxContextMsgs() <= 0) {
            incoming.setMaxContextMsgs(16);
        }

        if (bodyObj.has("customModels") && bodyObj.get("customModels").isJsonArray()) {
            List<String> list = new ArrayList<>();
            for (JsonElement item : bodyObj.getAsJsonArray("customModels")) {
                if (item.isJsonPrimitive()) {
                    String val = item.getAsString().trim();
                    if (!val.isEmpty() && !list.contains(val)) {
                        list.add(val);
                    }
                }
            }
            incoming.setCustomModels(list);
        } else if (incoming.getCustomModelsJson() == null || incoming.getCustomModelsJson().isBlank()) {
            incoming.setCustomModels(List.of());
        } else {
            incoming.setCustomModelsJson(incoming.getCustomModelsJson());
        }
    }

    private static void prepareProfileForResponse(AiProviderProfile profile) {
        if (profile == null) return;
        String encrypted = profile.getApiKeyEncrypted();
        if (encrypted == null || encrypted.isBlank()) {
            profile.setApiKeyEncrypted("");
            profile.setHasApiKey(false);
        } else {
            String masked = AiUrlGuard.maskEncryptedKey(encrypted);
            profile.setApiKeyEncrypted(masked);
            profile.setHasApiKey(!"ERR_KEY_LOST".equals(masked) && !masked.isBlank());
        }
        profile.getCustomModels();
    }

    private static String defaultProfileName(String protocol, String baseUrl) {
        String lower = baseUrl != null ? baseUrl.toLowerCase(Locale.ROOT) : "";
        if ("GEMINI".equals(protocol)) {
            return lower.isEmpty() || lower.contains("googleapis.com") ? "Google Gemini" : "Gemini Proxy";
        }
        if ("ANTHROPIC".equals(protocol)) {
            if (lower.contains("deepseek.com")) return "DeepSeek (Anthropic)";
            if (lower.contains("moonshot.cn")) return "Moonshot Kimi (Anthropic)";
            if (lower.contains("bigmodel.cn") || lower.contains("api.z.ai")) return "Zhipu GLM (Anthropic)";
            if (lower.contains("minimaxi.com") || lower.contains("minimax.io")) return "MiniMax (Anthropic)";
            if (lower.contains("dashscope.aliyuncs.com")) return "DashScope Coding (Anthropic)";
            return "Anthropic Claude";
        }
        if (lower.contains("deepseek.com")) return "DeepSeek";
        if (lower.contains("siliconflow")) return "SiliconFlow";
        if (lower.contains("moonshot.cn")) return "Moonshot Kimi";
        if (lower.contains("bigmodel.cn")) return "Zhipu AI";
        if (lower.contains("dashscope.aliyuncs.com")) return "DashScope Qwen";
        if (lower.contains("volces.com")) return "Volcengine Ark";
        if (lower.contains("openrouter.ai")) return "OpenRouter";
        if (lower.contains("api.groq.com")) return "Groq";
        if (lower.contains("mistral.ai")) return "Mistral AI";
        if (AiClient.isLoopbackUrl(baseUrl)) return "Ollama Local";
        return "OpenAI Compatible";
    }

    private static String detectPresetId(String protocol, String baseUrl) {
        String lower = baseUrl != null ? baseUrl.toLowerCase(Locale.ROOT) : "";
        if ("GEMINI".equals(protocol)) {
            return (lower.isEmpty() || lower.contains("googleapis.com")) ? "gemini-official" : "gemini-custom";
        }
        if ("ANTHROPIC".equals(protocol)) {
            if (lower.contains("deepseek.com")) return "anthropic-deepseek";
            if (lower.contains("moonshot.cn")) return "anthropic-moonshot";
            if (lower.contains("bigmodel.cn")) return "anthropic-zhipu";
            if (lower.contains("minimaxi.com")) return "anthropic-minimax";
            if (lower.contains("dashscope.aliyuncs.com")) return "anthropic-dashscope";
            if (lower.isEmpty() || lower.contains("anthropic.com")) return "anthropic-official";
            return "anthropic-custom";
        }
        if (lower.contains("deepseek.com")) return "deepseek";
        if (lower.contains("siliconflow")) return "siliconflow";
        if (lower.contains("moonshot.cn")) return "moonshot";
        if (lower.contains("bigmodel.cn")) return "zhipu";
        if (lower.contains("dashscope.aliyuncs.com")) return "dashscope";
        if (lower.contains("volces.com")) return "ark";
        if (lower.contains("openrouter.ai")) return "openrouter";
        if (lower.contains("api.groq.com")) return "groq";
        if (lower.contains("mistral.ai")) return "mistral";
        if (AiClient.isLoopbackUrl(baseUrl)) return "ollama";
        if (lower.contains("api.openai.com")) return "openai";
        return "custom";
    }
}
