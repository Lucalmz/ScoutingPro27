package com.bear27570.app.util.ai;

import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.util.AiClient.StreamChunk;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Protocol adapter for Anthropic / Claude Messages API (x-api-key, anthropic-version, extended thinking blocks).
 */
public final class AnthropicProtocolAdapter {
    private static final Logger logger = LoggerFactory.getLogger(AnthropicProtocolAdapter.class);

    private AnthropicProtocolAdapter() {}

    public static String resolveMessagesEndpoint(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://api.anthropic.com/v1/messages";
        }
        String bUrl = com.bear27570.app.routes.ai.AiUrlGuard.stripQueryAndFragment(baseUrl);
        if (bUrl.endsWith("/v1/messages") || bUrl.endsWith("/messages")) {
            return bUrl;
        }
        if (bUrl.matches(".*/v[0-9]+$")) {
            return bUrl + "/messages";
        }
        return bUrl + "/v1/messages";
    }

    public static String resolveModelsEndpoint(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://api.anthropic.com/v1/models";
        }
        String bUrl = com.bear27570.app.routes.ai.AiUrlGuard.stripQueryAndFragment(baseUrl);
        if (bUrl.endsWith("/models")) {
            return bUrl;
        }
        if (bUrl.endsWith("/v1/messages") || bUrl.endsWith("/messages")) {
            bUrl = bUrl.substring(0, bUrl.lastIndexOf("/messages"));
        }
        if (bUrl.matches(".*/v[0-9]+$")) {
            return bUrl + "/models";
        }
        return bUrl + "/v1/models";
    }

    public static List<Map<String, String>> normalizeMessages(List<Map<String, String>> messages) {
        List<Map<String, String>> result = new ArrayList<>();
        if (messages != null) {
            for (Map<String, String> msg : messages) {
                String rawContent = msg.get("content");
                if (rawContent == null || rawContent.trim().isEmpty()) {
                    continue;
                }
                String rawRole = msg.get("role");
                String role = ("assistant".equalsIgnoreCase(rawRole) || "model".equalsIgnoreCase(rawRole)) ? "assistant" : "user";

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
        }

        if (!result.isEmpty() && "assistant".equals(result.get(0).get("role"))) {
            Map<String, String> initialUser = new HashMap<>();
            initialUser.put("role", "user");
            initialUser.put("content", "Context init");
            result.add(0, initialUser);
        }

        while (!result.isEmpty() && "assistant".equals(result.get(result.size() - 1).get("role"))) {
            result.remove(result.size() - 1);
        }

        if (result.isEmpty()) {
            Map<String, String> defaultUser = new HashMap<>();
            defaultUser.put("role", "user");
            defaultUser.put("content", "Hello");
            result.add(defaultUser);
        }
        return result;
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
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "claude-sonnet-4-20250514";
        String endpoint = resolveMessagesEndpoint(profile.getBaseUrl());
        String anthropicVersion = (profile.getAnthropicVersion() != null && !profile.getAnthropicVersion().isBlank())
                ? profile.getAnthropicVersion().trim()
                : AiStreamSupport.DEFAULT_ANTHROPIC_VERSION;
        HttpClient client = AiProxyResolver.buildHttpClient(profile.getProxyHost(), profile.getProxyPort(), endpoint);

        boolean tryThinking = enableThinking;
        HttpResponse<InputStream> response = null;
        CompletableFuture<HttpResponse<InputStream>> activeFuture = null;

        for (int attempt = 0; attempt < 2; attempt++) {
            JsonObject payload = buildPayload(model, systemPrompt, messages, temperature, profile.getMaxTokens(), tryThinking, thinkingBudget);
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint))
                    .header("content-type", "application/json")
                    .header("anthropic-version", com.bear27570.app.routes.ai.AiUrlGuard.stripControlChars(anthropicVersion))
                    .POST(HttpRequest.BodyPublishers.ofString(AiStreamSupport.GSON.toJson(payload)))
                    .timeout(Duration.ofSeconds(120));
            String cleanApiKey = com.bear27570.app.routes.ai.AiUrlGuard.stripControlChars(apiKey);
            if (!cleanApiKey.isEmpty()) {
                reqBuilder.header("x-api-key", cleanApiKey);
            }

            activeFuture = client.sendAsync(reqBuilder.build(), HttpResponse.BodyHandlers.ofInputStream());
            response = AiStreamSupport.awaitResponseWithCancellation(activeFuture, isCancelled);
            if (response == null) {
                return;
            }

            int statusCode = response.statusCode();
            if (statusCode >= 200 && statusCode < 300) {
                break;
            }

            String errorBody;
            try (InputStream is = response.body()) {
                errorBody = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            }

            if (attempt == 0 && statusCode == 400 && tryThinking && errorBody.toLowerCase(Locale.ROOT).contains("thinking")) {
                tryThinking = false;
                logger.info("[AiClient] Anthropic endpoint rejected thinking block (HTTP 400), retrying without thinking.");
                continue;
            }

            throw new RuntimeException("Anthropic API Error (" + statusCode + "): " + errorBody);
        }

        if (response == null) return;

        AtomicInteger cachedInputTokens = new AtomicInteger(0);
        String currentEvent = null;
        try (InputStream is = response.body();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (isCancelled != null && isCancelled.get()) {
                    if (activeFuture != null) activeFuture.cancel(true);
                    is.close();
                    break;
                }
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    currentEvent = null;
                    continue;
                }
                if (trimmed.startsWith(":")) {
                    continue;
                }
                if (trimmed.startsWith("event:")) {
                    currentEvent = trimmed.substring(6).trim();
                    continue;
                }
                if (trimmed.startsWith("data:")) {
                    String data = trimmed.substring(5).trim();
                    List<StreamChunk> chunks = parseSseEvent(currentEvent, data, cachedInputTokens);
                    for (StreamChunk chunk : chunks) {
                        if ("done".equals(chunk.kind())) {
                            chunkConsumer.accept(chunk);
                            return;
                        }
                        chunkConsumer.accept(chunk);
                    }
                }
            }
        }
    }

    public static JsonObject buildPayload(
            String model,
            String systemPrompt,
            List<Map<String, String>> messages,
            Double temperature,
            Integer configuredMaxTokens,
            boolean enableThinking,
            Integer configuredThinkingBudget
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("model", model);
        payload.addProperty("stream", true);

        int maxTokens = (configuredMaxTokens != null && configuredMaxTokens > 0) ? configuredMaxTokens : 4096;
        if (enableThinking) {
            int budget = (configuredThinkingBudget != null && configuredThinkingBudget >= 1024) ? configuredThinkingBudget : 4096;
            if (maxTokens <= budget) {
                maxTokens = budget + 4096;
            }
            JsonObject thinking = new JsonObject();
            thinking.addProperty("type", "enabled");
            thinking.addProperty("budget_tokens", budget);
            payload.add("thinking", thinking);
        } else if (temperature != null) {
            payload.addProperty("temperature", temperature);
        }
        payload.addProperty("max_tokens", maxTokens);

        if (systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            payload.addProperty("system", systemPrompt.trim());
        }

        List<Map<String, String>> normalized = normalizeMessages(messages);
        JsonArray msgsArray = new JsonArray();
        for (Map<String, String> msg : normalized) {
            JsonObject m = new JsonObject();
            m.addProperty("role", msg.get("role"));
            m.addProperty("content", msg.get("content"));
            msgsArray.add(m);
        }
        payload.add("messages", msgsArray);
        return payload;
    }

    public static List<StreamChunk> parseSseEvent(String currentEvent, String dataStr, AtomicInteger cachedInputTokens) {
        if (dataStr == null || dataStr.isBlank()) {
            return Collections.emptyList();
        }
        if ("[DONE]".equals(dataStr.trim())) {
            return List.of(new StreamChunk("done", null, null));
        }

        List<StreamChunk> results = new ArrayList<>();
        try {
            JsonObject json = JsonParser.parseString(dataStr).getAsJsonObject();
            String eventType = (currentEvent != null && !currentEvent.isBlank())
                    ? currentEvent.trim()
                    : (json.has("type") && !json.get("type").isJsonNull() ? json.get("type").getAsString() : "");

            switch (eventType) {
                case "error" -> {
                    String errType = "error";
                    String errMsg = dataStr;
                    if (json.has("error") && json.get("error").isJsonObject()) {
                        JsonObject errObj = json.getAsJsonObject("error");
                        if (errObj.has("type") && !errObj.get("type").isJsonNull()) errType = errObj.get("type").getAsString();
                        if (errObj.has("message") && !errObj.get("message").isJsonNull()) errMsg = errObj.get("message").getAsString();
                    }
                    throw new RuntimeException("Anthropic API Error (" + errType + "): " + errMsg);
                }
                case "message_start" -> {
                    if (json.has("message") && json.get("message").isJsonObject()) {
                        JsonObject msgObj = json.getAsJsonObject("message");
                        if (msgObj.has("usage") && msgObj.get("usage").isJsonObject()) {
                            int inTokens = AiStreamSupport.getIntOrDefault(msgObj.getAsJsonObject("usage"), "input_tokens", 0);
                            if (cachedInputTokens != null) {
                                cachedInputTokens.set(inTokens);
                            }
                        }
                    }
                }
                case "content_block_delta" -> {
                    if (json.has("delta") && json.get("delta").isJsonObject()) {
                        JsonObject delta = json.getAsJsonObject("delta");
                        String deltaType = AiStreamSupport.getNonEmptyString(delta, "type");
                        if ("thinking_delta".equals(deltaType)) {
                            String thinking = AiStreamSupport.getNonEmptyString(delta, "thinking");
                            if (thinking != null) {
                                results.add(new StreamChunk("reasoning", thinking, null));
                            }
                        } else if ("text_delta".equals(deltaType) || delta.has("text")) {
                            String text = AiStreamSupport.getNonEmptyString(delta, "text");
                            if (text != null) {
                                results.add(new StreamChunk("text", text, null));
                            }
                        }
                    }
                }
                case "message_delta" -> {
                    if (json.has("usage") && json.get("usage").isJsonObject()) {
                        JsonObject u = json.getAsJsonObject("usage");
                        int inTokens = cachedInputTokens != null ? cachedInputTokens.get() : 0;
                        int outTokens = AiStreamSupport.getIntOrDefault(u, "output_tokens", 0);
                        JsonObject usageObj = new JsonObject();
                        usageObj.addProperty("promptTokens", inTokens);
                        usageObj.addProperty("completionTokens", outTokens);
                        usageObj.addProperty("totalTokens", inTokens + outTokens);
                        results.add(new StreamChunk("usage", null, usageObj));
                    }
                }
                case "message_stop" -> results.add(new StreamChunk("done", null, null));
                default -> {
                    // ping, content_block_start, content_block_stop safely ignored
                }
            }
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ignored) {
        }
        return results;
    }
}
