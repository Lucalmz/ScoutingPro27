package com.bear27570.app.util.ai;

import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.util.AiClient.StreamChunk;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Protocol adapter for Google Gemini v1beta API (header auth via `x-goog-api-key`, rolling -latest aliases, thinkingConfig).
 */
public final class GeminiProtocolAdapter {
    private static final Logger logger = LoggerFactory.getLogger(GeminiProtocolAdapter.class);
    private static final String DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
    private static final List<String> GEMINI_LATEST_ORDER = Arrays.asList(
            "gemini-flash-latest",
            "gemini-pro-latest",
            "gemini-flash-lite-latest"
    );

    private GeminiProtocolAdapter() {}

    public static String resolveBaseUrl(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return DEFAULT_GEMINI_BASE_URL;
        }
        String bUrl = com.bear27570.app.routes.ai.AiUrlGuard.stripQueryAndFragment(baseUrl);
        if (bUrl.matches(".*/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl;
        }
        return bUrl + "/v1beta";
    }

    public static String resolveGenerateEndpoint(String baseUrl, String modelName, boolean stream) {
        String base = resolveBaseUrl(baseUrl);
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gemini-flash-latest";
        if (model.startsWith("models/")) {
            model = model.substring(7);
        }
        String encodedModel = URLEncoder.encode(model, StandardCharsets.UTF_8).replace("+", "%20");
        return base + "/models/" + encodedModel + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
    }

    public static String resolveModelsEndpoint(String baseUrl) {
        return resolveBaseUrl(baseUrl) + "/models";
    }

    public static void streamChat(
            AiProviderProfile profile,
            String apiKey,
            String modelName,
            Double temperature,
            String systemPrompt,
            List<Map<String, String>> messages,
            Consumer<StreamChunk> chunkConsumer,
            AtomicBoolean isCancelled
    ) throws Exception {
        streamChat(
                profile, apiKey, modelName, temperature, systemPrompt, messages,
                profile.getEnableThinking(), profile.getThinkingBudget(), chunkConsumer, isCancelled
        );
    }

    public static void streamChat(
            AiProviderProfile profile,
            String apiKey,
            String modelName,
            Double temperature,
            String systemPrompt,
            List<Map<String, String>> messages,
            boolean enableThinking,
            Integer thinkingBudget,
            Consumer<StreamChunk> chunkConsumer,
            AtomicBoolean isCancelled
    ) throws Exception {
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gemini-flash-latest";
        String endpoint = resolveGenerateEndpoint(profile.getBaseUrl(), model, true);
        HttpClient client = AiProxyResolver.buildHttpClient(profile.getProxyHost(), profile.getProxyPort(), endpoint);

        boolean includeThinkingConfig = true;
        Integer currentBudget = enableThinking
                ? ((thinkingBudget != null && thinkingBudget > 0) ? thinkingBudget : 4096)
                : ((thinkingBudget != null && thinkingBudget > 0) ? thinkingBudget : 0);
        HttpResponse<InputStream> response = null;
        CompletableFuture<HttpResponse<InputStream>> activeFuture = null;

        for (int attempt = 0; attempt < 3; attempt++) {
            JsonObject payload = buildPayload(
                    systemPrompt, messages, temperature, profile.getMaxTokens(),
                    enableThinking, currentBudget, includeThinkingConfig
            );
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(AiStreamSupport.GSON.toJson(payload)))
                    .timeout(Duration.ofSeconds(120));
            String cleanApiKey = com.bear27570.app.routes.ai.AiUrlGuard.stripControlChars(apiKey);
            if (!cleanApiKey.isEmpty()) {
                reqBuilder.header("x-goog-api-key", cleanApiKey);
            }

            activeFuture = client.sendAsync(reqBuilder.build(), HttpResponse.BodyHandlers.ofInputStream());
            response = AiStreamSupport.awaitResponseWithCancellation(activeFuture, isCancelled);
            if (response == null) {
                return;
            }

            int code = response.statusCode();
            if (code >= 200 && code < 300) {
                break;
            }

            String body;
            try (InputStream is = response.body()) {
                body = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            }

            String lower = body.toLowerCase(Locale.ROOT);
            if (attempt < 2 && code == 400 && includeThinkingConfig) {
                if (!enableThinking && currentBudget == 0
                        && (lower.contains("budget") || lower.contains("minimum") || lower.contains("zero"))
                        && !lower.contains("not enabled")) {
                    currentBudget = 128;
                    logger.info("[AiClient] Gemini model rejected thinkingBudget=0 (HTTP 400), retrying with minimal thinkingBudget=128.");
                    continue;
                }
                if (lower.contains("thinking") || lower.contains("budget")) {
                    includeThinkingConfig = false;
                    logger.info("[AiClient] Gemini model/gateway rejected thinkingConfig (HTTP 400), retrying without thinkingConfig.");
                    continue;
                }
            }

            if (code == 404) {
                throw new RuntimeException("Gemini API (404 Not Found): model [" + model + "] is unavailable; check model ID or try gemini-flash-latest. Raw response: " + body);
            } else if (code == 403 || code == 401) {
                throw new RuntimeException("Gemini API (" + code + " Unauthorized): invalid API key or missing permission. Raw response: " + body);
            } else if (code == 429) {
                throw new RuntimeException("Gemini API (429 Rate Limit/Quota Exceeded): rate limit or quota exceeded. Raw response: " + body);
            } else {
                throw new RuntimeException("Gemini API Error (" + code + "): " + body);
            }
        }

        if (response == null) return;

        AtomicBoolean emittedAnyText = new AtomicBoolean(false);
        try (InputStream is = response.body();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (isCancelled != null && isCancelled.get()) {
                    if (activeFuture != null) activeFuture.cancel(true);
                    is.close();
                    break;
                }
                List<StreamChunk> chunks = parseSseChunk(line, emittedAnyText);
                for (StreamChunk chunk : chunks) {
                    chunkConsumer.accept(chunk);
                }
            }
        }
    }

    public static JsonObject buildPayload(
            String systemPrompt,
            List<Map<String, String>> messages,
            Double temperature,
            Integer maxTokens,
            boolean enableThinking,
            Integer thinkingBudget,
            boolean includeThinkingConfig
    ) {
        JsonObject payload = new JsonObject();
        if (systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            JsonObject sysInst = new JsonObject();
            JsonArray partsArray = new JsonArray();
            JsonObject part = new JsonObject();
            part.addProperty("text", systemPrompt.trim());
            partsArray.add(part);
            sysInst.add("parts", partsArray);
            payload.add("system_instruction", sysInst);
        }

        List<Map<String, String>> normalized = normalizeMessages(messages);
        JsonArray contentsArray = new JsonArray();
        for (Map<String, String> msg : normalized) {
            JsonObject contentObj = new JsonObject();
            contentObj.addProperty("role", msg.get("role"));
            JsonArray partsArray = new JsonArray();
            JsonObject part = new JsonObject();
            part.addProperty("text", msg.get("content"));
            partsArray.add(part);
            contentObj.add("parts", partsArray);
            contentsArray.add(contentObj);
        }
        payload.add("contents", contentsArray);

        JsonObject generationConfig = new JsonObject();
        if (temperature != null) {
            generationConfig.addProperty("temperature", temperature);
        }
        if (maxTokens != null && maxTokens > 0) {
            generationConfig.addProperty("maxOutputTokens", maxTokens);
        }
        if (includeThinkingConfig) {
            JsonObject thinkingConfig = new JsonObject();
            if (enableThinking) {
                int budget = (thinkingBudget != null && thinkingBudget > 0) ? thinkingBudget : 4096;
                thinkingConfig.addProperty("includeThoughts", true);
                thinkingConfig.addProperty("thinkingBudget", budget);
            } else {
                int budget = (thinkingBudget != null && thinkingBudget > 0) ? thinkingBudget : 0;
                thinkingConfig.addProperty("includeThoughts", false);
                thinkingConfig.addProperty("thinkingBudget", budget);
            }
            generationConfig.add("thinkingConfig", thinkingConfig);
        }
        if (generationConfig.size() > 0) {
            payload.add("generationConfig", generationConfig);
        }
        return payload;
    }

    public static List<StreamChunk> parseSseChunk(String line, AtomicBoolean emittedAnyText) {
        if (line == null) return Collections.emptyList();
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith(":")) {
            return Collections.emptyList();
        }
        if (!trimmed.startsWith("data:")) {
            return Collections.emptyList();
        }
        String data = trimmed.substring(5).trim();
        if ("[DONE]".equals(data)) {
            return List.of(new StreamChunk("done", null, null));
        }

        List<StreamChunk> results = new ArrayList<>();
        try {
            JsonObject resObj = JsonParser.parseString(data).getAsJsonObject();
            if (resObj.has("error") && resObj.get("error").isJsonObject()) {
                JsonObject err = resObj.getAsJsonObject("error");
                String msg = err.has("message") ? err.get("message").getAsString() : err.toString();
                throw new RuntimeException("Gemini Stream Error: " + msg);
            }
            if (resObj.has("candidates") && resObj.get("candidates").isJsonArray()) {
                JsonArray candidates = resObj.getAsJsonArray("candidates");
                if (!candidates.isEmpty() && candidates.get(0).isJsonObject()) {
                    JsonObject candidate = candidates.get(0).getAsJsonObject();
                    boolean emittedInChunk = false;
                    if (candidate.has("content") && candidate.get("content").isJsonObject()) {
                        JsonObject content = candidate.getAsJsonObject("content");
                        if (content.has("parts") && content.get("parts").isJsonArray()) {
                            JsonArray parts = content.getAsJsonArray("parts");
                            for (JsonElement pEl : parts) {
                                if (!pEl.isJsonObject()) continue;
                                JsonObject part = pEl.getAsJsonObject();
                                if (!part.has("text") || part.get("text").isJsonNull()) continue;
                                String text = part.get("text").getAsString();
                                if (text.isEmpty()) continue;
                                boolean isThought = part.has("thought") && !part.get("thought").isJsonNull() && part.get("thought").getAsBoolean();
                                if (isThought) {
                                    results.add(new StreamChunk("reasoning", text, null));
                                } else {
                                    emittedInChunk = true;
                                    if (emittedAnyText != null) emittedAnyText.set(true);
                                    results.add(new StreamChunk("text", text, null));
                                }
                            }
                        }
                    }

                    if (!emittedInChunk && (emittedAnyText == null || !emittedAnyText.get()) && candidate.has("finishReason") && !candidate.get("finishReason").isJsonNull()) {
                        String reason = candidate.get("finishReason").getAsString();
                        if ("SAFETY".equalsIgnoreCase(reason)
                                || "PROHIBITED_CONTENT".equalsIgnoreCase(reason)
                                || "RECITATION".equalsIgnoreCase(reason)) {
                            results.add(new StreamChunk("text", "[Blocked by Gemini Safety Filter: " + reason + "]", null));
                        }
                    }
                }
            }

            if (resObj.has("usageMetadata") && resObj.get("usageMetadata").isJsonObject()) {
                JsonObject meta = resObj.getAsJsonObject("usageMetadata");
                int prompt = AiStreamSupport.getIntOrDefault(meta, "promptTokenCount", 0);
                int candidates = AiStreamSupport.getIntOrDefault(meta, "candidatesTokenCount", 0);
                int thoughts = AiStreamSupport.getIntOrDefault(meta, "thoughtsTokenCount", 0);
                int completion = candidates + thoughts;
                int total = AiStreamSupport.getIntOrDefault(meta, "totalTokenCount", prompt + completion);
                JsonObject usageObj = new JsonObject();
                usageObj.addProperty("promptTokens", prompt);
                usageObj.addProperty("completionTokens", completion);
                usageObj.addProperty("totalTokens", total);
                if (thoughts > 0) {
                    usageObj.addProperty("thoughtsTokens", thoughts);
                }
                results.add(new StreamChunk("usage", null, usageObj));
            }
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ignored) {
        }
        return results;
    }

    public static String parseLegacySseLine(String line) {
        if (line == null) return null;
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith(":")) {
            return null;
        }
        if (trimmed.startsWith("data:")) {
            String data = trimmed.substring(5).trim();
            try {
                JsonObject resObj = JsonParser.parseString(data).getAsJsonObject();
                if (resObj.has("candidates") && resObj.get("candidates").isJsonArray()) {
                    JsonArray candidates = resObj.getAsJsonArray("candidates");
                    if (candidates.size() > 0 && candidates.get(0).isJsonObject()) {
                        JsonObject candidate = candidates.get(0).getAsJsonObject();
                        if (candidate.has("finishReason") && "SAFETY".equalsIgnoreCase(candidate.get("finishReason").getAsString())) {
                            return "[Blocked by Safety Filter]";
                        }
                        if (candidate.has("content") && candidate.get("content").isJsonObject()) {
                            JsonObject content = candidate.getAsJsonObject("content");
                            if (content.has("parts") && content.get("parts").isJsonArray()) {
                                JsonArray parts = content.getAsJsonArray("parts");
                                StringBuilder sb = new StringBuilder();
                                for (JsonElement p : parts) {
                                    if (p.isJsonObject() && p.getAsJsonObject().has("text")) {
                                        sb.append(p.getAsJsonObject().get("text").getAsString());
                                    }
                                }
                                if (sb.length() > 0) {
                                    return sb.toString();
                                }
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        return null;
    }

    public static List<Map<String, String>> normalizeMessages(List<Map<String, String>> messages) {
        List<Map<String, String>> result = new ArrayList<>();
        if (messages == null || messages.isEmpty()) {
            Map<String, String> defaultUser = new HashMap<>();
            defaultUser.put("role", "user");
            defaultUser.put("content", "Hello");
            result.add(defaultUser);
            return result;
        }

        for (Map<String, String> msg : messages) {
            String rawContent = msg.get("content");
            if (rawContent == null || rawContent.trim().isEmpty()) {
                continue;
            }
            String rawRole = msg.get("role");
            String role = ("model".equalsIgnoreCase(rawRole) || "assistant".equalsIgnoreCase(rawRole)) ? "model" : "user";

            if (!result.isEmpty() && result.get(result.size() - 1).get("role").equals(role)) {
                Map<String, String> last = result.get(result.size() - 1);
                last.put("content", last.get("content") + "\n\n" + rawContent.trim());
            } else {
                Map<String, String> item = new HashMap<>();
                item.put("role", role);
                item.put("content", rawContent.trim());
                result.add(item);
            }
        }

        if (!result.isEmpty() && "model".equals(result.get(0).get("role"))) {
            Map<String, String> initialUser = new HashMap<>();
            initialUser.put("role", "user");
            initialUser.put("content", "Context init");
            result.add(0, initialUser);
        }

        if (result.isEmpty()) {
            Map<String, String> defaultUser = new HashMap<>();
            defaultUser.put("role", "user");
            defaultUser.put("content", "Hello");
            result.add(defaultUser);
        }

        return result;
    }

    public static List<String> parseModelsResponse(String protocol, String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return Collections.emptyList();
        }
        String proto = protocol != null ? protocol.trim().toUpperCase(Locale.ROOT) : "OPENAI";
        try {
            JsonElement rootEl = JsonParser.parseString(responseBody);
            if (!rootEl.isJsonObject()) {
                return Collections.emptyList();
            }
            JsonObject root = rootEl.getAsJsonObject();

            if ("GEMINI".equals(proto)) {
                if (!root.has("models") || !root.get("models").isJsonArray()) {
                    return Collections.emptyList();
                }
                Set<String> sortedModels = new TreeSet<>();
                for (JsonElement el : root.getAsJsonArray("models")) {
                    if (!el.isJsonObject()) continue;
                    JsonObject obj = el.getAsJsonObject();
                    if (!obj.has("name") || obj.get("name").isJsonNull()) continue;

                    if (obj.has("supportedGenerationMethods") && obj.get("supportedGenerationMethods").isJsonArray()) {
                        boolean supportsGenerateContent = false;
                        for (JsonElement m : obj.getAsJsonArray("supportedGenerationMethods")) {
                            if (m.isJsonPrimitive() && "generateContent".equals(m.getAsString())) {
                                supportsGenerateContent = true;
                                break;
                            }
                        }
                        if (!supportsGenerateContent) {
                            continue;
                        }
                    }

                    String name = obj.get("name").getAsString().trim();
                    if (name.startsWith("models/")) {
                        name = name.substring(7);
                    }
                    if (!name.isEmpty()) {
                        sortedModels.add(name);
                    }
                }

                LinkedHashSet<String> ordered = new LinkedHashSet<>();
                for (String preferred : GEMINI_LATEST_ORDER) {
                    if (sortedModels.contains(preferred)) {
                        ordered.add(preferred);
                    }
                }
                ordered.addAll(sortedModels);
                return new ArrayList<>(ordered);
            }

            if (root.has("data") && root.get("data").isJsonArray()) {
                Set<String> ids = new TreeSet<>();
                for (JsonElement el : root.getAsJsonArray("data")) {
                    if (!el.isJsonObject()) continue;
                    JsonObject obj = el.getAsJsonObject();
                    if (obj.has("id") && !obj.get("id").isJsonNull()) {
                        String id = obj.get("id").getAsString().trim();
                        if (!id.isEmpty()) {
                            ids.add(id);
                        }
                    }
                }
                return new ArrayList<>(ids);
            }
        } catch (Exception e) {
            logger.warn("Failed to parse {} models response: {}", proto, e.getMessage());
        }
        return Collections.emptyList();
    }
}
