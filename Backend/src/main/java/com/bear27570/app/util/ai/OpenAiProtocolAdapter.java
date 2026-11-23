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
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Protocol adapter for OpenAI / GPT-compatible chat completions and model discovery endpoints.
 */
public final class OpenAiProtocolAdapter {
    private static final Logger logger = LoggerFactory.getLogger(OpenAiProtocolAdapter.class);
    private static final Pattern REASONING_NO_TEMP_PATTERN = Pattern.compile(
            "^(o[134](-|$)|deepseek-reasoner|deepseek-r1|qwq|.*-thinking)",
            Pattern.CASE_INSENSITIVE
    );

    private OpenAiProtocolAdapter() {}

    public static boolean isReasoningOnlyTemperatureModel(String modelName) {
        if (modelName == null || modelName.isBlank()) {
            return false;
        }
        return REASONING_NO_TEMP_PATTERN.matcher(modelName.trim()).find();
    }

    private static boolean isOpenAiOSeries(String model) {
        if (model == null) return false;
        String lower = model.trim().toLowerCase(Locale.ROOT);
        return lower.matches("^o[134](-.*|$)");
    }

    public static String resolveChatEndpoint(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://api.openai.com/v1/chat/completions";
        }
        String bUrl = baseUrl.trim();
        while (bUrl.endsWith("/")) {
            bUrl = bUrl.substring(0, bUrl.length() - 1);
        }
        if (bUrl.endsWith("/chat/completions")) {
            return bUrl;
        }
        if (bUrl.matches(".*/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/chat/completions";
        }
        return bUrl + "/v1/chat/completions";
    }

    public static String resolveModelsEndpoint(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://api.openai.com/v1/models";
        }
        String bUrl = baseUrl.trim();
        while (bUrl.endsWith("/")) {
            bUrl = bUrl.substring(0, bUrl.length() - 1);
        }
        if (bUrl.endsWith("/models")) {
            return bUrl;
        }
        if (bUrl.endsWith("/chat/completions")) {
            bUrl = bUrl.substring(0, bUrl.lastIndexOf("/chat/completions"));
        }
        if (bUrl.matches(".*/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/models";
        }
        return bUrl + "/v1/models";
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
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gpt-4o";
        String endpoint = resolveChatEndpoint(profile.getBaseUrl());
        HttpClient client = AiProxyResolver.buildHttpClient(profile.getProxyHost(), profile.getProxyPort(), endpoint);

        JsonArray msgsArray = new JsonArray();
        if (systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            JsonObject sysMsg = new JsonObject();
            sysMsg.addProperty("role", "system");
            sysMsg.addProperty("content", systemPrompt.trim());
            msgsArray.add(sysMsg);
        }
        for (Map<String, String> msg : messages) {
            if (msg.get("content") == null || msg.get("content").isBlank()) {
                continue;
            }
            JsonObject m = new JsonObject();
            m.addProperty("role", msg.get("role") != null ? msg.get("role") : "user");
            m.addProperty("content", msg.get("content"));
            msgsArray.add(m);
        }

        boolean includeStreamOptions = true;
        boolean includeMaxTokens = profile.getMaxTokens() != null && profile.getMaxTokens() > 0 && !isOpenAiOSeries(model);

        HttpResponse<InputStream> response = null;
        CompletableFuture<HttpResponse<InputStream>> activeFuture = null;

        for (int attempt = 0; attempt < 2; attempt++) {
            JsonObject payload = buildStreamPayload(model, msgsArray, temperature, profile.getMaxTokens(), includeMaxTokens, includeStreamOptions);
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(AiStreamSupport.GSON.toJson(payload)))
                    .timeout(Duration.ofSeconds(120));
            if (!apiKey.isEmpty()) {
                reqBuilder.header("Authorization", "Bearer " + apiKey);
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

            String lower = errorBody.toLowerCase(Locale.ROOT);
            boolean canRetryStreamOptions = attempt == 0 && (statusCode == 400 || statusCode == 422)
                    && includeStreamOptions
                    && (lower.contains("stream_options") || lower.contains("unrecognized") || lower.contains("extra inputs") || lower.contains("unknown field"));
            boolean canRetryMaxTokens = attempt == 0 && (statusCode == 400 || statusCode == 422)
                    && includeMaxTokens
                    && lower.contains("max_tokens");

            if (canRetryStreamOptions || canRetryMaxTokens) {
                if (canRetryStreamOptions) includeStreamOptions = false;
                if (canRetryMaxTokens) includeMaxTokens = false;
                logger.info("[AiClient] OpenAI-compatible gateway rejected optional parameter (HTTP {}), retrying without it.", statusCode);
                continue;
            }

            throw new RuntimeException("OpenAI API Error (" + statusCode + "): " + errorBody);
        }

        if (response == null) return;

        try (InputStream is = response.body();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (isCancelled != null && isCancelled.get()) {
                    if (activeFuture != null) activeFuture.cancel(true);
                    is.close();
                    break;
                }
                List<StreamChunk> chunks = parseSseChunk(line);
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

    private static JsonObject buildStreamPayload(
            String model,
            JsonArray msgsArray,
            Double temperature,
            Integer maxTokens,
            boolean includeMaxTokens,
            boolean includeStreamOptions
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("model", model);
        payload.addProperty("stream", true);
        if (includeStreamOptions) {
            JsonObject streamOptions = new JsonObject();
            streamOptions.addProperty("include_usage", true);
            payload.add("stream_options", streamOptions);
        }
        if (temperature != null && !isReasoningOnlyTemperatureModel(model)) {
            payload.addProperty("temperature", temperature);
        }
        if (includeMaxTokens && maxTokens != null && maxTokens > 0) {
            payload.addProperty("max_tokens", maxTokens);
        }
        payload.add("messages", msgsArray);
        return payload;
    }

    public static List<StreamChunk> parseSseChunk(String line) {
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
            JsonObject json = JsonParser.parseString(data).getAsJsonObject();
            if (json.has("error") && !json.get("error").isJsonNull()) {
                JsonElement errEl = json.get("error");
                String msg = errEl.isJsonObject() && errEl.getAsJsonObject().has("message")
                        ? errEl.getAsJsonObject().get("message").getAsString()
                        : errEl.toString();
                throw new RuntimeException("OpenAI Stream Error: " + msg);
            }
            if (json.has("choices") && json.get("choices").isJsonArray()) {
                JsonArray choices = json.getAsJsonArray("choices");
                if (!choices.isEmpty() && choices.get(0).isJsonObject()) {
                    JsonObject choice0 = choices.get(0).getAsJsonObject();
                    if (choice0.has("delta") && choice0.get("delta").isJsonObject()) {
                        JsonObject delta = choice0.getAsJsonObject("delta");
                        String reasoning = AiStreamSupport.getNonEmptyString(delta, "reasoning_content");
                        if (reasoning == null) {
                            reasoning = AiStreamSupport.getNonEmptyString(delta, "reasoning");
                        }
                        if (reasoning != null) {
                            results.add(new StreamChunk("reasoning", reasoning, null));
                        }
                        String content = AiStreamSupport.getNonEmptyString(delta, "content");
                        if (content != null) {
                            results.add(new StreamChunk("text", content, null));
                        }
                    }
                }
            }
            if (json.has("usage") && json.get("usage").isJsonObject()) {
                JsonObject rawUsage = json.getAsJsonObject("usage");
                results.add(new StreamChunk("usage", null, normalizeOpenAiUsage(rawUsage)));
            }
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception ignored) {
        }
        return results;
    }

    private static JsonObject normalizeOpenAiUsage(JsonObject rawUsage) {
        JsonObject normalized = new JsonObject();
        int prompt = AiStreamSupport.getIntOrDefault(rawUsage, "prompt_tokens", AiStreamSupport.getIntOrDefault(rawUsage, "promptTokens", 0));
        int completion = AiStreamSupport.getIntOrDefault(rawUsage, "completion_tokens", AiStreamSupport.getIntOrDefault(rawUsage, "completionTokens", 0));
        int total = AiStreamSupport.getIntOrDefault(rawUsage, "total_tokens", AiStreamSupport.getIntOrDefault(rawUsage, "totalTokens", prompt + completion));
        normalized.addProperty("promptTokens", prompt);
        normalized.addProperty("completionTokens", completion);
        normalized.addProperty("totalTokens", total);
        return normalized;
    }

    public static String parseLegacySseLine(String line) {
        if (line == null) return null;
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith(":")) {
            return null;
        }
        if (trimmed.startsWith("data:")) {
            String data = trimmed.substring(5).trim();
            if ("[DONE]".equals(data)) {
                return "[DONE]";
            }
            try {
                JsonObject json = JsonParser.parseString(data).getAsJsonObject();
                if (json.has("choices") && json.get("choices").isJsonArray()) {
                    JsonArray choices = json.getAsJsonArray("choices");
                    if (choices.size() > 0 && choices.get(0).isJsonObject()) {
                        JsonObject choice0 = choices.get(0).getAsJsonObject();
                        if (choice0.has("delta") && choice0.get("delta").isJsonObject()) {
                            JsonObject delta = choice0.getAsJsonObject("delta");
                            if (delta.has("content") && !delta.get("content").isJsonNull()) {
                                String c = delta.get("content").getAsString();
                                if (!c.isEmpty()) {
                                    return c;
                                }
                            }
                            if (delta.has("reasoning_content") && !delta.get("reasoning_content").isJsonNull()) {
                                String r = delta.get("reasoning_content").getAsString();
                                if (!r.isEmpty()) {
                                    return r;
                                }
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        return null;
    }
}
