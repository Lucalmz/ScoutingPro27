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

        String endpoint = "https://api.openai.com/v1/chat/completions";
        if (settings.getBaseUrl() != null && !settings.getBaseUrl().isBlank()) {
            String bUrl = settings.getBaseUrl().trim();
            if (bUrl.endsWith("/")) {
                bUrl = bUrl.substring(0, bUrl.length() - 1);
            }
            if (bUrl.endsWith("/chat/completions")) {
                endpoint = bUrl;
            } else if (bUrl.endsWith("/v1")) {
                endpoint = bUrl + "/chat/completions";
            } else {
                endpoint = bUrl + "/v1/chat/completions";
            }
        }

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
}
