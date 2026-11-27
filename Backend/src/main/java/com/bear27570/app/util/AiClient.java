package com.bear27570.app.util;

import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.util.ai.AiProxyResolver;
import com.bear27570.app.util.ai.AiStreamSupport;
import com.bear27570.app.util.ai.AnthropicProtocolAdapter;
import com.bear27570.app.util.ai.GeminiProtocolAdapter;
import com.bear27570.app.util.ai.OpenAiProtocolAdapter;
import com.google.gson.JsonObject;

import java.net.Proxy;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Facade delegating proxy resolution, multi-protocol streaming, and endpoint normalization
 * to cohesive protocol adapters in {@code com.bear27570.app.util.ai}.
 */
public class AiClient {

    public record StreamChunk(String kind, String text, JsonObject usage) {}

    public record ThinkingOptions(Boolean enableThinking, Integer thinkingBudget, String reasoningEffort) {}

    // ==================== Proxy Resolution & Bypass ====================

    public static boolean isLoopbackUrl(String targetUrl) {
        return AiProxyResolver.isLoopbackUrl(targetUrl);
    }

    public static Proxy resolveEffectiveProxy(String customHost, Integer customPort) {
        return AiProxyResolver.resolveEffectiveProxy(customHost, customPort, null);
    }

    public static Proxy resolveEffectiveProxy(String customHost, Integer customPort, String targetUrl) {
        return AiProxyResolver.resolveEffectiveProxy(customHost, customPort, targetUrl);
    }

    public static ProxySelector resolveEffectiveProxySelector(String customHost, Integer customPort, String targetUrl) {
        return AiProxyResolver.resolveEffectiveProxySelector(customHost, customPort, targetUrl);
    }

    public static HttpClient buildHttpClient(String proxyHost, Integer proxyPort, String targetUrl) {
        return AiProxyResolver.buildHttpClient(proxyHost, proxyPort, targetUrl);
    }

    // ==================== Legacy Entry Points ====================

    public static String chat(AiSettings settings, String systemPrompt, List<Map<String, String>> messages) throws Exception {
        AiProviderProfile profile = AiProviderProfile.fromLegacy(settings);
        profile.setEnableThinking(false);
        return chat(profile, systemPrompt, messages, null, null);
    }

    public static void chatStream(AiSettings settings, String systemPrompt, List<Map<String, String>> messages, Consumer<String> chunkConsumer, AtomicBoolean isCancelled) throws Exception {
        AiProviderProfile profile = AiProviderProfile.fromLegacy(settings);
        profile.setEnableThinking(false);
        chatStream(profile, systemPrompt, messages, null, null, chunk -> {
            if (("text".equals(chunk.kind()) || "reasoning".equals(chunk.kind())) && chunk.text() != null && !chunk.text().isEmpty()) {
                chunkConsumer.accept(chunk.text());
            }
        }, isCancelled);
    }

    // ==================== Unified Three-Protocol Entry Points ====================

    public static String chat(AiProviderProfile profile, String systemPrompt, List<Map<String, String>> messages) throws Exception {
        return chat(profile, systemPrompt, messages, null, null);
    }

    public static String chat(AiProviderProfile profile, String systemPrompt, List<Map<String, String>> messages, Double temperatureOverride, String modelOverride) throws Exception {
        return chat(profile, systemPrompt, messages, temperatureOverride, modelOverride, null);
    }

    public static String chat(
            AiProviderProfile profile,
            String systemPrompt,
            List<Map<String, String>> messages,
            Double temperatureOverride,
            String modelOverride,
            ThinkingOptions thinkingOverride
    ) throws Exception {
        StringBuilder answer = new StringBuilder();
        chatStream(profile, systemPrompt, messages, temperatureOverride, modelOverride, thinkingOverride, chunk -> {
            if ("text".equals(chunk.kind()) && chunk.text() != null) {
                answer.append(chunk.text());
            }
        }, null);
        return answer.length() > 0 ? answer.toString() : "[No Content Returned]";
    }

    public static void chatStream(
            AiProviderProfile profile,
            String systemPrompt,
            List<Map<String, String>> messages,
            Double temperatureOverride,
            String modelOverride,
            Consumer<StreamChunk> chunkConsumer,
            AtomicBoolean isCancelled
    ) throws Exception {
        chatStream(profile, systemPrompt, messages, temperatureOverride, modelOverride, null, chunkConsumer, isCancelled);
    }

    public static void chatStream(
            AiProviderProfile profile,
            String systemPrompt,
            List<Map<String, String>> messages,
            Double temperatureOverride,
            String modelOverride,
            ThinkingOptions thinkingOverride,
            Consumer<StreamChunk> chunkConsumer,
            AtomicBoolean isCancelled
    ) throws Exception {
        if (profile == null) {
            throw new IllegalArgumentException("AI profile cannot be null");
        }
        String protocol = profile.getProtocol() != null ? profile.getProtocol().trim().toUpperCase(Locale.ROOT) : "OPENAI";
        String rawKey = AESUtil.decrypt(profile.getApiKeyEncrypted());
        rawKey = rawKey == null ? "" : rawKey.trim();
        String effectiveModel = (modelOverride != null && !modelOverride.isBlank()) ? modelOverride.trim() : profile.getModelName();
        Double effectiveTemp = temperatureOverride != null ? temperatureOverride : profile.getTemperature();
        List<Map<String, String>> trimmedMessages = AiStreamSupport.trimContextMessages(messages, profile.getMaxContextMsgs());

        boolean effectiveEnableThinking = thinkingOverride != null && thinkingOverride.enableThinking() != null
                ? thinkingOverride.enableThinking()
                : profile.getEnableThinking();
        Integer effectiveThinkingBudget;
        if (thinkingOverride != null && thinkingOverride.thinkingBudget() != null) {
            effectiveThinkingBudget = Math.max(0, thinkingOverride.thinkingBudget());
        } else if (!effectiveEnableThinking) {
            effectiveThinkingBudget = 0;
        } else {
            effectiveThinkingBudget = profile.getThinkingBudget();
        }
        Boolean openAiThinkingOverride = thinkingOverride != null ? thinkingOverride.enableThinking() : null;
        String effectiveReasoningEffort = thinkingOverride != null ? thinkingOverride.reasoningEffort() : null;

        switch (protocol) {
            case "OPENAI" -> {
                String ep = OpenAiProtocolAdapter.resolveChatEndpoint(profile.getBaseUrl());
                if (!com.bear27570.app.routes.ai.AiUrlGuard.isSafeUrl(ep)) {
                    throw new IllegalArgumentException("Forbidden baseUrl: SSRF protection blocked access");
                }
                OpenAiProtocolAdapter.streamChat(
                        profile, rawKey, effectiveModel, effectiveTemp, systemPrompt, trimmedMessages,
                        openAiThinkingOverride, effectiveReasoningEffort, chunkConsumer, isCancelled);
            }
            case "GEMINI" -> {
                String ep = GeminiProtocolAdapter.resolveGenerateEndpoint(profile.getBaseUrl(), effectiveModel, true);
                if (!com.bear27570.app.routes.ai.AiUrlGuard.isSafeUrl(ep)) {
                    throw new IllegalArgumentException("Forbidden baseUrl: SSRF protection blocked access");
                }
                GeminiProtocolAdapter.streamChat(
                        profile, rawKey, effectiveModel, effectiveTemp, systemPrompt, trimmedMessages,
                        effectiveEnableThinking, effectiveThinkingBudget, chunkConsumer, isCancelled);
            }
            case "ANTHROPIC" -> {
                String ep = AnthropicProtocolAdapter.resolveMessagesEndpoint(profile.getBaseUrl());
                if (!com.bear27570.app.routes.ai.AiUrlGuard.isSafeUrl(ep)) {
                    throw new IllegalArgumentException("Forbidden baseUrl: SSRF protection blocked access");
                }
                AnthropicProtocolAdapter.streamChat(
                        profile, rawKey, effectiveModel, effectiveTemp, systemPrompt, trimmedMessages,
                        effectiveEnableThinking, effectiveThinkingBudget, chunkConsumer, isCancelled);
            }
            default -> throw new IllegalArgumentException("Unsupported AI protocol: " + protocol);
        }
    }

    // ==================== Protocol Resolvers & Parsers ====================

    public static boolean isReasoningOnlyTemperatureModel(String modelName) {
        return OpenAiProtocolAdapter.isReasoningOnlyTemperatureModel(modelName);
    }

    public static String resolveOpenAiChatEndpoint(String baseUrl) {
        return OpenAiProtocolAdapter.resolveChatEndpoint(baseUrl);
    }

    public static String resolveOpenAiModelsEndpoint(String baseUrl) {
        return OpenAiProtocolAdapter.resolveModelsEndpoint(baseUrl);
    }

    public static List<StreamChunk> parseOpenAiSseChunk(String line) {
        return OpenAiProtocolAdapter.parseSseChunk(line);
    }

    public static String resolveGeminiBaseUrl(String baseUrl) {
        return GeminiProtocolAdapter.resolveBaseUrl(baseUrl);
    }

    public static String resolveGeminiGenerateEndpoint(String baseUrl, String modelName, boolean stream) {
        return GeminiProtocolAdapter.resolveGenerateEndpoint(baseUrl, modelName, stream);
    }

    public static String resolveGeminiModelsEndpoint(String baseUrl) {
        return GeminiProtocolAdapter.resolveModelsEndpoint(baseUrl);
    }

    public static List<StreamChunk> parseGeminiSseChunk(String line, AtomicBoolean emittedAnyText) {
        return GeminiProtocolAdapter.parseSseChunk(line, emittedAnyText);
    }

    public static List<Map<String, String>> normalizeGeminiMessages(List<Map<String, String>> messages) {
        return GeminiProtocolAdapter.normalizeMessages(messages);
    }

    public static String resolveAnthropicMessagesEndpoint(String baseUrl) {
        return AnthropicProtocolAdapter.resolveMessagesEndpoint(baseUrl);
    }

    public static String resolveAnthropicModelsEndpoint(String baseUrl) {
        return AnthropicProtocolAdapter.resolveModelsEndpoint(baseUrl);
    }

    public static List<Map<String, String>> normalizeAnthropicMessages(List<Map<String, String>> messages) {
        return AnthropicProtocolAdapter.normalizeMessages(messages);
    }

    public static List<StreamChunk> parseAnthropicSseEvent(String currentEvent, String dataStr, AtomicInteger cachedInputTokens) {
        return AnthropicProtocolAdapter.parseSseEvent(currentEvent, dataStr, cachedInputTokens);
    }

    public static List<String> parseModelsResponse(String protocol, String responseBody) {
        return GeminiProtocolAdapter.parseModelsResponse(protocol, responseBody);
    }

    public static String parseOpenAiSseLine(String line) {
        return OpenAiProtocolAdapter.parseLegacySseLine(line);
    }

    public static String parseGeminiSseLine(String line) {
        return GeminiProtocolAdapter.parseLegacySseLine(line);
    }
}
