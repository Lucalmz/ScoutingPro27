package com.bear27570.app.util;

import com.bear27570.app.model.AiSettings;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AiClient {
    private static final Gson gson = new Gson();

    public static String chat(AiSettings settings, String systemPrompt, List<Map<String, String>> messages) throws Exception {
        HttpClient.Builder clientBuilder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15));

        if (settings.getProxyPort() != null && settings.getProxyPort() > 0) {
            String host = (settings.getProxyHost() != null && !settings.getProxyHost().isEmpty()) ? settings.getProxyHost() : "127.0.0.1";
            clientBuilder.proxy(ProxySelector.of(new InetSocketAddress(host, settings.getProxyPort())));
        }

        HttpClient client = clientBuilder.build();
        String rawKey = AESUtil.decrypt(settings.getApiKeyEncrypted());

        if ("OPENAI".equalsIgnoreCase(settings.getProvider())) {
            return callOpenAi(client, settings, rawKey, systemPrompt, messages);
        } else if ("GEMINI".equalsIgnoreCase(settings.getProvider())) {
            return callGemini(client, settings.getModelName(), rawKey, systemPrompt, messages);
        } else {
            throw new IllegalArgumentException("Unsupported AI provider: " + settings.getProvider());
        }
    }

    public static void chatStream(AiSettings settings, String systemPrompt, List<Map<String, String>> messages, java.util.function.Consumer<String> chunkConsumer, java.util.concurrent.atomic.AtomicBoolean isCancelled) throws Exception {
        HttpClient.Builder clientBuilder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15));

        if (settings.getProxyPort() != null && settings.getProxyPort() > 0) {
            String host = (settings.getProxyHost() != null && !settings.getProxyHost().isEmpty()) ? settings.getProxyHost() : "127.0.0.1";
            clientBuilder.proxy(ProxySelector.of(new InetSocketAddress(host, settings.getProxyPort())));
        }

        HttpClient client = clientBuilder.build();
        String rawKey = AESUtil.decrypt(settings.getApiKeyEncrypted());

        if ("OPENAI".equalsIgnoreCase(settings.getProvider())) {
            callOpenAiStream(client, settings, rawKey, systemPrompt, messages, chunkConsumer, isCancelled);
        } else if ("GEMINI".equalsIgnoreCase(settings.getProvider())) {
            callGeminiStream(client, settings.getModelName(), rawKey, systemPrompt, messages, chunkConsumer, isCancelled);
        } else {
            throw new IllegalArgumentException("Unsupported AI provider: " + settings.getProvider());
        }
    }

    private static String callOpenAi(HttpClient client, AiSettings settings, String apiKey, String systemPrompt, List<Map<String, String>> messages) throws Exception {
        String modelName = settings.getModelName();
        JsonObject payload = new JsonObject();
        payload.addProperty("model", (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gpt-3.5-turbo");

        JsonArray msgsArray = new JsonArray();

        if (systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            JsonObject sysMsg = new JsonObject();
            sysMsg.addProperty("role", "system");
            sysMsg.addProperty("content", systemPrompt);
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

        payload.add("messages", msgsArray);

        String endpoint = resolveOpenAiChatEndpoint(settings.getBaseUrl());

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload)))
                .timeout(Duration.ofSeconds(60))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            JsonObject resObj = JsonParser.parseString(response.body()).getAsJsonObject();
            if (resObj.has("choices") && resObj.get("choices").isJsonArray()) {
                JsonArray choices = resObj.getAsJsonArray("choices");
                if (choices.size() > 0 && choices.get(0).isJsonObject()) {
                    JsonObject choice0 = choices.get(0).getAsJsonObject();
                    if (choice0.has("message") && choice0.get("message").isJsonObject()) {
                        JsonObject msgObj = choice0.getAsJsonObject("message");
                        if (msgObj.has("content") && !msgObj.get("content").isJsonNull()) {
                            return msgObj.get("content").getAsString();
                        }
                    }
                }
            }
            return "[No Content Returned]";
        } else {
            throw new RuntimeException("OpenAI API Error (" + response.statusCode() + "): " + response.body());
        }
    }

    private static String callGemini(HttpClient client, String modelName, String apiKey, String systemPrompt, List<Map<String, String>> messages) throws Exception {
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gemini-flash-latest";
        String url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

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

        List<Map<String, String>> normalized = normalizeGeminiMessages(messages);
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

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload)))
                .timeout(Duration.ofSeconds(60))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            JsonObject resObj = JsonParser.parseString(response.body()).getAsJsonObject();
            JsonArray candidates = resObj.getAsJsonArray("candidates");
            if (candidates != null && candidates.size() > 0) {
                JsonObject candidate = candidates.get(0).getAsJsonObject();
                if (candidate.has("finishReason") && "SAFETY".equalsIgnoreCase(candidate.get("finishReason").getAsString())) {
                    return "[Blocked by Safety Filter]";
                }
                if (candidate.has("content")) {
                    JsonObject content = candidate.getAsJsonObject("content");
                    if (content.has("parts")) {
                        JsonArray parts = content.getAsJsonArray("parts");
                        StringBuilder textBuilder = new StringBuilder();
                        for (JsonElement p : parts) {
                            if (p.isJsonObject() && p.getAsJsonObject().has("text")) {
                                textBuilder.append(p.getAsJsonObject().get("text").getAsString());
                            }
                        }
                        if (textBuilder.length() > 0) {
                            return textBuilder.toString();
                        }
                    }
                }
            }
            return "[No Content Returned]";
        } else {
            String body = response.body();
            int code = response.statusCode();
            if (code == 404) {
                throw new RuntimeException("Gemini API (404 Not Found): 当前模型 [" + model + "] 不可用，可能是您的 API Key 权限或额度不支持该模型，请尝试在设置中切换模型 (如 gemini-flash-latest)。原始响应: " + body);
            } else if (code == 403) {
                throw new RuntimeException("Gemini API (403 Forbidden): API Key 无效或未启用相关 API 权限。原始响应: " + body);
            } else if (code == 429) {
                throw new RuntimeException("Gemini API (429 Rate Limit/Quota Exceeded): 请求频率超限或配额耗尽。原始响应: " + body);
            } else {
                throw new RuntimeException("Gemini API Error (" + code + "): " + body);
            }
        }
    }

    private static void callOpenAiStream(HttpClient client, AiSettings settings, String apiKey, String systemPrompt, List<Map<String, String>> messages, java.util.function.Consumer<String> chunkConsumer, java.util.concurrent.atomic.AtomicBoolean isCancelled) throws Exception {
        String modelName = settings.getModelName();
        JsonObject payload = new JsonObject();
        payload.addProperty("model", (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gpt-3.5-turbo");
        payload.addProperty("stream", true);

        JsonArray msgsArray = new JsonArray();

        if (systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            JsonObject sysMsg = new JsonObject();
            sysMsg.addProperty("role", "system");
            sysMsg.addProperty("content", systemPrompt);
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

        payload.add("messages", msgsArray);

        String endpoint = resolveOpenAiChatEndpoint(settings.getBaseUrl());

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload)))
                .timeout(Duration.ofSeconds(120))
                .build();

        java.util.concurrent.CompletableFuture<HttpResponse<java.io.InputStream>> future = client.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());

        HttpResponse<java.io.InputStream> response;
        try {
            response = future.get();
        } catch (Exception e) {
            if (isCancelled != null && isCancelled.get()) {
                future.cancel(true);
                return;
            }
            throw e;
        }

        int statusCode = response.statusCode();
        if (statusCode < 200 || statusCode >= 300) {
            try (java.io.InputStream is = response.body()) {
                String errorBody = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                throw new RuntimeException("OpenAI API Error (" + statusCode + "): " + errorBody);
            }
        }

        try (java.io.InputStream is = response.body();
             java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is, java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (isCancelled != null && isCancelled.get()) {
                    future.cancel(true);
                    is.close(); // Forcibly close underlying HTTP connection stream immediately
                    break;
                }
                String delta = parseOpenAiSseLine(line);
                if ("[DONE]".equals(delta)) {
                    break;
                }
                if (delta != null && !delta.isEmpty()) {
                    chunkConsumer.accept(delta);
                }
            }
        }
    }

    private static void callGeminiStream(HttpClient client, String modelName, String apiKey, String systemPrompt, List<Map<String, String>> messages, java.util.function.Consumer<String> chunkConsumer, java.util.concurrent.atomic.AtomicBoolean isCancelled) throws Exception {
        String model = (modelName != null && !modelName.isBlank()) ? modelName.trim() : "gemini-flash-latest";
        String url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse";

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

        List<Map<String, String>> normalized = normalizeGeminiMessages(messages);
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

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload)))
                .timeout(Duration.ofSeconds(120))
                .build();

        java.util.concurrent.CompletableFuture<HttpResponse<java.io.InputStream>> future = client.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());

        HttpResponse<java.io.InputStream> response;
        try {
            response = future.get();
        } catch (Exception e) {
            if (isCancelled != null && isCancelled.get()) {
                future.cancel(true);
                return;
            }
            throw e;
        }

        int code = response.statusCode();
        if (code < 200 || code >= 300) {
            try (java.io.InputStream is = response.body()) {
                String body = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                if (code == 404) {
                    throw new RuntimeException("Gemini API (404 Not Found): 当前模型 [" + model + "] 不可用，可能是您的 API Key 权限或额度不支持该模型，请尝试在设置中切换模型 (如 gemini-flash-latest)。原始响应: " + body);
                } else if (code == 403) {
                    throw new RuntimeException("Gemini API (403 Forbidden): API Key 无效或未启用相关 API 权限。原始响应: " + body);
                } else if (code == 429) {
                    throw new RuntimeException("Gemini API (429 Rate Limit/Quota Exceeded): 请求频率超限或配额耗尽。原始响应: " + body);
                } else {
                    throw new RuntimeException("Gemini API Error (" + code + "): " + body);
                }
            }
        }

        try (java.io.InputStream is = response.body();
             java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is, java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (isCancelled != null && isCancelled.get()) {
                    future.cancel(true);
                    is.close(); // Forcibly close underlying HTTP connection stream immediately
                    break;
                }
                String delta = parseGeminiSseLine(line);
                if (delta != null && !delta.isEmpty()) {
                    chunkConsumer.accept(delta);
                }
            }
        }
    }

    /**
     * Parses a single SSE line for OpenAI format:
     * Returns the delta text content, or "[DONE]" if finished, or null if line is not a valid content delta.
     */
    public static String parseOpenAiSseLine(String line) {
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
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    /**
     * Parses a single SSE line for Gemini format:
     * Returns delta text content or safety message, or null if line is not a valid content delta.
     */
    public static String parseGeminiSseLine(String line) {
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
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    /**
     * Normalizes conversation history for Gemini API:
     * 1. Maps 'assistant' to 'model', defaults others to 'user'
     * 2. Removes empty messages
     * 3. Merges consecutive messages with the same role
     * 4. Ensures the conversation sequence starts with 'user'
     */
    public static List<Map<String, String>> normalizeGeminiMessages(List<Map<String, String>> messages) {
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
                // Merge with previous same-role message
                Map<String, String> last = result.get(result.size() - 1);
                last.put("content", last.get("content") + "\n\n" + rawContent.trim());
            } else {
                Map<String, String> item = new HashMap<>();
                item.put("role", role);
                item.put("content", rawContent.trim());
                result.add(item);
            }
        }

        // Ensure starts with user
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

    /**
     * Resolves the full chat completions endpoint URL for OpenAI-compatible providers.
     */
    public static String resolveOpenAiChatEndpoint(String baseUrl) {
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
        if (bUrl.matches(".*\\/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/chat/completions";
        }
        return bUrl + "/v1/chat/completions";
    }

    /**
     * Resolves the models listing endpoint URL for OpenAI-compatible providers (used for connection tests).
     */
    public static String resolveOpenAiModelsEndpoint(String baseUrl) {
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
        if (bUrl.matches(".*\\/v[0-9]+([a-zA-Z0-9_-]*)?$")) {
            return bUrl + "/models";
        }
        return bUrl + "/v1/models";
    }
}
