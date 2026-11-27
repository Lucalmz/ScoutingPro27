package com.bear27570.app.util;

import com.bear27570.app.model.AiProviderProfile;
import com.bear27570.app.util.ai.AnthropicProtocolAdapter;
import com.bear27570.app.util.ai.GeminiProtocolAdapter;
import com.bear27570.app.util.ai.OpenAiProtocolAdapter;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AiClientTest {

    @Test
    void testNormalizeGeminiMessages_EmptyList() {
        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(new ArrayList<>());
        assertEquals(1, normalized.size());
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("Hello", normalized.get(0).get("content"));
    }

    @Test
    void testNormalizeGeminiMessages_ConsecutiveSameRolesMerged() {
        List<Map<String, String>> messages = new ArrayList<>();
        messages.add(Map.of("role", "user", "content", "First question"));
        messages.add(Map.of("role", "user", "content", "Second question without answer"));
        messages.add(Map.of("role", "assistant", "content", "First answer"));
        messages.add(Map.of("role", "assistant", "content", "Second answer"));
        messages.add(Map.of("role", "user", "content", "Third question"));

        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(messages);

        // Should result in: user -> model -> user (strict alternation)
        assertEquals(3, normalized.size());
        
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("First question\n\nSecond question without answer", normalized.get(0).get("content"));

        assertEquals("model", normalized.get(1).get("role"));
        assertEquals("First answer\n\nSecond answer", normalized.get(1).get("content"));

        assertEquals("user", normalized.get(2).get("role"));
        assertEquals("Third question", normalized.get(2).get("content"));
    }

    @Test
    void testNormalizeGeminiMessages_StartsWithAssistant() {
        List<Map<String, String>> messages = new ArrayList<>();
        messages.add(Map.of("role", "assistant", "content", "Welcome message"));
        messages.add(Map.of("role", "user", "content", "Hi"));

        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(messages);

        // Should prepend user context so sequence starts with user
        assertTrue(normalized.size() >= 2);
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("model", normalized.get(1).get("role"));
        assertEquals("Welcome message", normalized.get(1).get("content"));
        assertEquals("user", normalized.get(2).get("role"));
        assertEquals("Hi", normalized.get(2).get("content"));
    }

    @Test
    void testNormalizeGeminiMessages_FiltersEmptyMessages() {
        List<Map<String, String>> messages = new ArrayList<>();
        messages.add(Map.of("role", "user", "content", "   "));
        messages.add(Map.of("role", "user", "content", "Real message"));
        messages.add(Map.of("role", "assistant", "content", ""));

        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(messages);

        assertEquals(1, normalized.size());
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("Real message", normalized.get(0).get("content"));
    }

    @Test
    void testNormalizeGeminiMessages_SingleIsolatedModelMessageOnly() {
        List<Map<String, String>> messages = new ArrayList<>();
        messages.add(Map.of("role", "model", "content", "Isolated assistant response"));

        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(messages);

        // Must prepend user message so Gemini receives user -> model
        assertEquals(2, normalized.size());
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("Context init", normalized.get(0).get("content"));
        assertEquals("model", normalized.get(1).get("role"));
        assertEquals("Isolated assistant response", normalized.get(1).get("content"));
    }

    @Test
    void testNormalizeGeminiMessages_MultipleLeadingModelMessages() {
        List<Map<String, String>> messages = new ArrayList<>();
        messages.add(Map.of("role", "assistant", "content", "Intro 1"));
        messages.add(Map.of("role", "model", "content", "Intro 2"));
        messages.add(Map.of("role", "user", "content", "User query"));

        List<Map<String, String>> normalized = AiClient.normalizeGeminiMessages(messages);

        // Should merge Intro 1 & Intro 2, prepend user context, then user query
        assertEquals(3, normalized.size());
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("Context init", normalized.get(0).get("content"));
        assertEquals("model", normalized.get(1).get("role"));
        assertEquals("Intro 1\n\nIntro 2", normalized.get(1).get("content"));
        assertEquals("user", normalized.get(2).get("role"));
        assertEquals("User query", normalized.get(2).get("content"));
    }

    @Test
    void testResolveOpenAiChatEndpoint_VariousProviders() {
        // Default / null / empty
        assertEquals("https://api.openai.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint(null));
        assertEquals("https://api.openai.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("   "));

        // DeepSeek
        assertEquals("https://api.deepseek.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://api.deepseek.com/v1"));
        assertEquals("https://api.deepseek.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://api.deepseek.com"));
        assertEquals("https://api.deepseek.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://api.deepseek.com/"));

        // Zhipu GLM (v4 endpoint)
        assertEquals("https://open.bigmodel.cn/api/paas/v4/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://open.bigmodel.cn/api/paas/v4"));
        assertEquals("https://open.bigmodel.cn/api/paas/v4/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://open.bigmodel.cn/api/paas/v4/"));

        // DashScope / Qwen compatible mode
        assertEquals("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"));

        // SiliconFlow
        assertEquals("https://api.siliconflow.cn/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://api.siliconflow.cn/v1"));

        // Ollama Local
        assertEquals("http://localhost:11434/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("http://localhost:11434/v1"));
        assertEquals("http://localhost:11434/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("http://localhost:11434"));

        // Direct full chat/completions path
        assertEquals("https://my-custom-proxy.com/v1/chat/completions", AiClient.resolveOpenAiChatEndpoint("https://my-custom-proxy.com/v1/chat/completions"));
    }

    @Test
    void testResolveOpenAiModelsEndpoint_VariousProviders() {
        // Default / null / empty
        assertEquals("https://api.openai.com/v1/models", AiClient.resolveOpenAiModelsEndpoint(null));
        assertEquals("https://api.openai.com/v1/models", AiClient.resolveOpenAiModelsEndpoint(""));

        // DeepSeek
        assertEquals("https://api.deepseek.com/v1/models", AiClient.resolveOpenAiModelsEndpoint("https://api.deepseek.com/v1"));
        assertEquals("https://api.deepseek.com/v1/models", AiClient.resolveOpenAiModelsEndpoint("https://api.deepseek.com"));

        // Zhipu GLM
        assertEquals("https://open.bigmodel.cn/api/paas/v4/models", AiClient.resolveOpenAiModelsEndpoint("https://open.bigmodel.cn/api/paas/v4"));

        // Full endpoint with /chat/completions stripped
        assertEquals("https://api.deepseek.com/v1/models", AiClient.resolveOpenAiModelsEndpoint("https://api.deepseek.com/v1/chat/completions"));
    }

    @Test
    void testParseOpenAiSseLine_DeltaAndDone() {
        // Normal text delta
        String line1 = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}";
        assertEquals("Hello ", AiClient.parseOpenAiSseLine(line1));

        // Done line
        String doneLine = "data: [DONE]";
        assertEquals("[DONE]", AiClient.parseOpenAiSseLine(doneLine));

        // Empty delta
        String emptyDelta = "data: {\"choices\":[{\"delta\":{}}]}";
        assertNull(AiClient.parseOpenAiSseLine(emptyDelta));

        // Heartbeat comment or empty line
        assertNull(AiClient.parseOpenAiSseLine(": heartbeat"));
        assertNull(AiClient.parseOpenAiSseLine(""));
        assertNull(AiClient.parseOpenAiSseLine(null));

        // Malformed line
        assertNull(AiClient.parseOpenAiSseLine("data: not-json"));
    }

    @Test
    void testParseGeminiSseLine_DeltaAndSafety() {
        // Normal text candidate
        String line1 = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini reply\"}]}}]}";
        assertEquals("Gemini reply", AiClient.parseGeminiSseLine(line1));

        // Multiple parts
        String lineMulti = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Part1 \"},{\"text\":\"Part2\"}]}}]}";
        assertEquals("Part1 Part2", AiClient.parseGeminiSseLine(lineMulti));

        // Safety filter triggered
        String safetyLine = "data: {\"candidates\":[{\"finishReason\":\"SAFETY\"}]}";
        assertEquals("[Blocked by Safety Filter]", AiClient.parseGeminiSseLine(safetyLine));

        // Heartbeat comment or empty line
        assertNull(AiClient.parseGeminiSseLine(": heartbeat"));
        assertNull(AiClient.parseGeminiSseLine(""));
        assertNull(AiClient.parseGeminiSseLine(null));

        // Malformed line
        assertNull(AiClient.parseGeminiSseLine("data: invalid-json"));
    }

    @Test
    void testLoopbackUrlAndProxyBypass() {
        assertTrue(AiClient.isLoopbackUrl("http://localhost:11434/v1"));
        assertTrue(AiClient.isLoopbackUrl("http://127.0.0.1:8080/v1"));
        assertTrue(AiClient.isLoopbackUrl("http://[::1]:11434/v1"));
        assertFalse(AiClient.isLoopbackUrl("https://api.deepseek.com/v1"));

        assertEquals(java.net.Proxy.NO_PROXY, AiClient.resolveEffectiveProxy(null, null, "http://localhost:11434/v1"));
        assertEquals(java.net.Proxy.NO_PROXY, AiClient.resolveEffectiveProxy("127.0.0.1", null, "http://127.0.0.1:11434/v1"));

        java.net.Proxy explicit = AiClient.resolveEffectiveProxy("127.0.0.1", 7890, "http://localhost:11434/v1");
        assertEquals(java.net.Proxy.Type.HTTP, explicit.type());
        assertEquals(7890, ((java.net.InetSocketAddress) explicit.address()).getPort());
    }

    @Test
    void testGeminiAndAnthropicEndpointResolvers() {
        assertEquals("https://generativelanguage.googleapis.com/v1beta", AiClient.resolveGeminiBaseUrl(null));
        assertEquals("https://my-gemini-proxy.example.com/v1beta", AiClient.resolveGeminiBaseUrl("https://my-gemini-proxy.example.com/"));
        assertEquals("https://my-gemini-proxy.example.com/v1beta", AiClient.resolveGeminiBaseUrl("https://my-gemini-proxy.example.com/v1beta/"));
        assertEquals(
                "https://my-gemini-proxy.example.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse",
                AiClient.resolveGeminiGenerateEndpoint("https://my-gemini-proxy.example.com", "models/gemini-flash-latest", true)
        );
        assertEquals(
                "https://generativelanguage.googleapis.com/v1beta/models",
                AiClient.resolveGeminiModelsEndpoint(null)
        );

        assertEquals("https://api.anthropic.com/v1/messages", AiClient.resolveAnthropicMessagesEndpoint(null));
        assertEquals("https://api.deepseek.com/anthropic/v1/messages", AiClient.resolveAnthropicMessagesEndpoint("https://api.deepseek.com/anthropic"));
        assertEquals("https://api.moonshot.cn/anthropic/v1/messages", AiClient.resolveAnthropicMessagesEndpoint("https://api.moonshot.cn/anthropic/"));
        assertEquals("https://open.bigmodel.cn/api/anthropic/v1/messages", AiClient.resolveAnthropicMessagesEndpoint("https://open.bigmodel.cn/api/anthropic"));
        assertEquals("https://api.anthropic.com/v1/models", AiClient.resolveAnthropicModelsEndpoint("https://api.anthropic.com/v1/messages"));
        assertEquals("https://api.deepseek.com/anthropic/v1/models", AiClient.resolveAnthropicModelsEndpoint("https://api.deepseek.com/anthropic"));
    }

    @Test
    void testNormalizeAnthropicMessagesAndReasoningModelDetection() {
        List<Map<String, String>> raw = List.of(
                Map.of("role", "assistant", "content", "Leading model"),
                Map.of("role", "user", "content", "Q1"),
                Map.of("role", "user", "content", "Q2"),
                Map.of("role", "assistant", "content", "   "),
                Map.of("role", "assistant", "content", "Trailing assistant")
        );
        List<Map<String, String>> normalized = AiClient.normalizeAnthropicMessages(raw);
        assertEquals(3, normalized.size());
        assertEquals("user", normalized.get(0).get("role"));
        assertEquals("Context init", normalized.get(0).get("content"));
        assertEquals("assistant", normalized.get(1).get("role"));
        assertEquals("Leading model", normalized.get(1).get("content"));
        assertEquals("user", normalized.get(2).get("role"));
        assertEquals("Q1\n\nQ2", normalized.get(2).get("content"));

        assertTrue(AiClient.isReasoningOnlyTemperatureModel("o1"));
        assertTrue(AiClient.isReasoningOnlyTemperatureModel("o3-mini"));
        assertTrue(AiClient.isReasoningOnlyTemperatureModel("deepseek-reasoner"));
        assertTrue(AiClient.isReasoningOnlyTemperatureModel("deepseek-r1:8b"));
        assertTrue(AiClient.isReasoningOnlyTemperatureModel("qwq-plus"));
        assertFalse(AiClient.isReasoningOnlyTemperatureModel("gpt-4o"));
        assertFalse(AiClient.isReasoningOnlyTemperatureModel("deepseek-chat"));
    }

    @Test
    void testThreeProtocolStructuredSseAndModelsParsing() {
        List<AiClient.StreamChunk> openAiChunks = AiClient.parseOpenAiSseChunk(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\",\"content\":\"ans\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}"
        );
        assertEquals(3, openAiChunks.size());
        assertEquals("reasoning", openAiChunks.get(0).kind());
        assertEquals("think", openAiChunks.get(0).text());
        assertEquals("text", openAiChunks.get(1).kind());
        assertEquals("ans", openAiChunks.get(1).text());
        assertEquals("usage", openAiChunks.get(2).kind());
        assertEquals(15, openAiChunks.get(2).usage().get("totalTokens").getAsInt());

        var emittedAnyText = new java.util.concurrent.atomic.AtomicBoolean(false);
        List<AiClient.StreamChunk> geminiChunks = AiClient.parseGeminiSseChunk(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gthink\",\"thought\":true},{\"text\":\"gans\"}]}}],\"usageMetadata\":{\"promptTokenCount\":20,\"candidatesTokenCount\":8,\"thoughtsTokenCount\":12,\"totalTokenCount\":40}}",
                emittedAnyText
        );
        assertTrue(emittedAnyText.get());
        assertEquals(3, geminiChunks.size());
        assertEquals("reasoning", geminiChunks.get(0).kind());
        assertEquals("gthink", geminiChunks.get(0).text());
        assertEquals("text", geminiChunks.get(1).kind());
        assertEquals("gans", geminiChunks.get(1).text());
        assertEquals("usage", geminiChunks.get(2).kind());
        assertEquals(20, geminiChunks.get(2).usage().get("completionTokens").getAsInt());

        var cachedIn = new java.util.concurrent.atomic.AtomicInteger(0);
        AiClient.parseAnthropicSseEvent("message_start", "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":55}}}", cachedIn);
        assertEquals(55, cachedIn.get());
        List<AiClient.StreamChunk> anthThink = AiClient.parseAnthropicSseEvent("content_block_delta", "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"deep\"}}", cachedIn);
        assertEquals("reasoning", anthThink.get(0).kind());
        assertEquals("deep", anthThink.get(0).text());
        List<AiClient.StreamChunk> anthText = AiClient.parseAnthropicSseEvent("content_block_delta", "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"final\"}}", cachedIn);
        assertEquals("text", anthText.get(0).kind());
        assertEquals("final", anthText.get(0).text());
        List<AiClient.StreamChunk> anthUsage = AiClient.parseAnthropicSseEvent("message_delta", "{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":25}}", cachedIn);
        assertEquals("usage", anthUsage.get(0).kind());
        assertEquals(80, anthUsage.get(0).usage().get("totalTokens").getAsInt());
        List<AiClient.StreamChunk> anthStop = AiClient.parseAnthropicSseEvent("message_stop", "{\"type\":\"message_stop\"}", cachedIn);
        assertEquals("done", anthStop.get(0).kind());
        assertThrows(RuntimeException.class, () ->
                AiClient.parseAnthropicSseEvent("error", "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", cachedIn)
        );

        String geminiModelsJson = "{\"models\":[{\"name\":\"models/embedding-001\",\"supportedGenerationMethods\":[\"embedContent\"]},{\"name\":\"models/gemini-2.5-flash\",\"supportedGenerationMethods\":[\"generateContent\"]},{\"name\":\"models/gemini-flash-latest\",\"supportedGenerationMethods\":[\"generateContent\"]}]}";
        List<String> parsedGemini = AiClient.parseModelsResponse("GEMINI", geminiModelsJson);
        assertEquals(List.of("gemini-flash-latest", "gemini-2.5-flash"), parsedGemini);

        String anthropicModelsJson = "{\"data\":[{\"id\":\"claude-sonnet-4-20250514\"},{\"id\":\"claude-3-5-haiku-latest\"}]}";
        List<String> parsedAnthropic = AiClient.parseModelsResponse("ANTHROPIC", anthropicModelsJson);
        assertEquals(List.of("claude-3-5-haiku-latest", "claude-sonnet-4-20250514"), parsedAnthropic);
    }

    @Test
    void testVariableThinkingPayloadsAndDefaults() {
        AiProviderProfile defaultProfile = new AiProviderProfile();
        assertFalse(defaultProfile.getEnableThinking(), "New AI profiles should default enableThinking to false");

        List<Map<String, String>> msgs = List.of(Map.of("role", "user", "content", "Analyze #27570"));

        // Gemini off -> explicit thinkingBudget=0 & includeThoughts=false
        JsonObject gemOff = GeminiProtocolAdapter.buildPayload("sys", msgs, 0.4, 4096, false, 0, true);
        JsonObject gemOffCfg = gemOff.getAsJsonObject("generationConfig").getAsJsonObject("thinkingConfig");
        assertFalse(gemOffCfg.get("includeThoughts").getAsBoolean());
        assertEquals(0, gemOffCfg.get("thinkingBudget").getAsInt());

        // Gemini low -> thinkingBudget=1024 & includeThoughts=true
        JsonObject gemLow = GeminiProtocolAdapter.buildPayload("sys", msgs, 0.4, 4096, true, 1024, true);
        JsonObject gemLowCfg = gemLow.getAsJsonObject("generationConfig").getAsJsonObject("thinkingConfig");
        assertTrue(gemLowCfg.get("includeThoughts").getAsBoolean());
        assertEquals(1024, gemLowCfg.get("thinkingBudget").getAsInt());

        // Gemini without thinkingConfig
        JsonObject gemOmit = GeminiProtocolAdapter.buildPayload("sys", msgs, 0.4, 4096, false, 0, false);
        assertFalse(gemOmit.getAsJsonObject("generationConfig").has("thinkingConfig"));

        // Anthropic off vs high
        JsonObject antOff = AnthropicProtocolAdapter.buildPayload("claude-sonnet-4-20250514", "sys", msgs, 0.4, 4096, false, 0);
        assertFalse(antOff.has("thinking"));
        assertEquals(0.4, antOff.get("temperature").getAsDouble());

        JsonObject antHigh = AnthropicProtocolAdapter.buildPayload("claude-sonnet-4-20250514", "sys", msgs, 0.4, 4096, true, 8192);
        assertTrue(antHigh.has("thinking"));
        assertEquals("enabled", antHigh.getAsJsonObject("thinking").get("type").getAsString());
        assertEquals(8192, antHigh.getAsJsonObject("thinking").get("budget_tokens").getAsInt());
        assertTrue(antHigh.get("max_tokens").getAsInt() > 8192);
        assertFalse(antHigh.has("temperature"));

        // OpenAI reasoning_effort & DashScope enable_thinking
        JsonArray oaMsgs = new JsonArray();
        JsonObject m = new JsonObject();
        m.addProperty("role", "user");
        m.addProperty("content", "hi");
        oaMsgs.add(m);

        JsonObject gpt5Off = OpenAiProtocolAdapter.buildStreamPayload("gpt-5-mini", oaMsgs, 0.4, 4096, true, true, "https://api.openai.com/v1", false, "none");
        assertEquals("minimal", gpt5Off.get("reasoning_effort").getAsString());

        JsonObject o3High = OpenAiProtocolAdapter.buildStreamPayload("o3-mini", oaMsgs, 0.4, 4096, false, true, "https://api.openai.com/v1", true, "high");
        assertEquals("high", o3High.get("reasoning_effort").getAsString());

        JsonObject dashOff = OpenAiProtocolAdapter.buildStreamPayload("qwen-plus", oaMsgs, 0.4, 4096, true, true, "https://dashscope.aliyuncs.com/compatible-mode/v1", false, "none");
        assertFalse(dashOff.get("enable_thinking").getAsBoolean());

        JsonObject genericOpenAi = OpenAiProtocolAdapter.buildStreamPayload("deepseek-chat", oaMsgs, 0.4, 4096, true, true, "https://api.deepseek.com/v1", false, "none");
        assertFalse(genericOpenAi.has("reasoning_effort"));
        assertFalse(genericOpenAi.has("enable_thinking"));
    }

    @Test
    void testAiStreamSupportAndProtocolAdapterEdgeCasesWithMockServer() throws Exception {
        // AiStreamSupport unit tests
        assertTrue(com.bear27570.app.util.ai.AiStreamSupport.trimContextMessages(null, 5).isEmpty());
        List<Map<String, String>> fiveMsgs = List.of(
                Map.of("role", "user", "content", "1"),
                Map.of("role", "assistant", "content", "2"),
                Map.of("role", "user", "content", "3")
        );
        assertEquals(3, com.bear27570.app.util.ai.AiStreamSupport.trimContextMessages(fiveMsgs, 0).size());
        assertEquals(2, com.bear27570.app.util.ai.AiStreamSupport.trimContextMessages(fiveMsgs, 2).size());
        assertEquals("2", com.bear27570.app.util.ai.AiStreamSupport.trimContextMessages(fiveMsgs, 2).get(0).get("content"));

        JsonObject sampleObj = new JsonObject();
        sampleObj.addProperty("str", "abc");
        sampleObj.addProperty("empty", "");
        sampleObj.addProperty("badInt", "not-int");
        sampleObj.addProperty("okInt", 42);
        assertEquals("abc", com.bear27570.app.util.ai.AiStreamSupport.getNonEmptyString(sampleObj, "str"));
        assertNull(com.bear27570.app.util.ai.AiStreamSupport.getNonEmptyString(sampleObj, "empty"));
        assertNull(com.bear27570.app.util.ai.AiStreamSupport.getNonEmptyString(sampleObj, "missing"));
        assertEquals(42, com.bear27570.app.util.ai.AiStreamSupport.getIntOrDefault(sampleObj, "okInt", 7));
        assertEquals(7, com.bear27570.app.util.ai.AiStreamSupport.getIntOrDefault(sampleObj, "badInt", 7));
        assertEquals(7, com.bear27570.app.util.ai.AiStreamSupport.getIntOrDefault(null, "okInt", 7));

        // awaitResponseWithCancellation: cancelled before completion & non-cancelled exception propagation
        java.util.concurrent.CompletableFuture<java.net.http.HttpResponse<java.io.InputStream>> pending = new java.util.concurrent.CompletableFuture<>();
        var cancelledFlag = new java.util.concurrent.atomic.AtomicBoolean(true);
        assertNull(com.bear27570.app.util.ai.AiStreamSupport.awaitResponseWithCancellation(pending, cancelledFlag));
        assertTrue(pending.isCancelled());

        java.util.concurrent.CompletableFuture<java.net.http.HttpResponse<java.io.InputStream>> failedFuture = new java.util.concurrent.CompletableFuture<>();
        failedFuture.completeExceptionally(new IllegalStateException("boom"));
        assertThrows(Exception.class, () -> com.bear27570.app.util.ai.AiStreamSupport.awaitResponseWithCancellation(
                failedFuture, new java.util.concurrent.atomic.AtomicBoolean(false)));

        // OpenAI reasoning_effort / DeepSeek / OpenRouter / error chunk edge cases
        JsonArray msgs = new JsonArray();
        JsonObject u = new JsonObject();
        u.addProperty("role", "user");
        u.addProperty("content", "q");
        msgs.add(u);
        assertFalse(OpenAiProtocolAdapter.buildStreamPayload("o1", msgs, 0.7, 2048, false, true, "https://api.openai.com/v1", false, "none").has("max_tokens"));
        assertEquals("low", OpenAiProtocolAdapter.buildStreamPayload("o1", msgs, 0.7, 2048, false, true, "https://api.openai.com/v1", false, "none").get("reasoning_effort").getAsString());
        assertEquals("disabled", OpenAiProtocolAdapter.buildStreamPayload("deepseek-chat", msgs, 0.4, 2048, true, true, "https://api.deepseek.com/v1", false, null).getAsJsonObject("thinking").get("type").getAsString());
        assertTrue(OpenAiProtocolAdapter.buildStreamPayload("anthropic/claude", msgs, 0.4, 2048, true, true, "https://openrouter.ai/api/v1", false, "off").getAsJsonObject("reasoning").get("exclude").getAsBoolean());

        assertThrows(RuntimeException.class, () -> AiClient.parseOpenAiSseChunk("data: {\"error\":{\"message\":\"Rate limit\"}}"));
        assertThrows(RuntimeException.class, () -> AiClient.parseOpenAiSseChunk("data: {\"error\":\"bad\"}"));
        assertEquals("reasoning", AiClient.parseOpenAiSseChunk("data: {\"choices\":[{\"delta\":{\"reasoning\":\"step1\"}}]}").get(0).kind());
        // Regression #18.3b: non-primitive content/reasoning in SSE delta must not crash stream
        assertTrue(AiClient.parseOpenAiSseChunk("data: {\"choices\":[{\"delta\":{\"content\":{\"nested\":1},\"reasoning\":[]}}]}").isEmpty());

        // Gemini safety block (PROHIBITED_CONTENT & suppressed after text emitted), error chunk, baseUrl variants
        assertEquals("https://proxy.example.com/v1alpha", AiClient.resolveGeminiBaseUrl("https://proxy.example.com/v1alpha"));
        assertEquals("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
                AiClient.resolveGeminiGenerateEndpoint(null, "gemini-2.5-flash", false));

        var emittedFalse = new java.util.concurrent.atomic.AtomicBoolean(false);
        var blocked = AiClient.parseGeminiSseChunk("data: {\"candidates\":[{\"finishReason\":\"PROHIBITED_CONTENT\"}]}", emittedFalse);
        assertEquals(1, blocked.size());
        assertTrue(blocked.get(0).text().contains("PROHIBITED_CONTENT"));

        var emittedTrue = new java.util.concurrent.atomic.AtomicBoolean(true);
        assertTrue(AiClient.parseGeminiSseChunk("data: {\"candidates\":[{\"finishReason\":\"SAFETY\"}]}", emittedTrue).isEmpty());
        assertThrows(RuntimeException.class, () -> AiClient.parseGeminiSseChunk("data: {\"error\":{\"message\":\"Bad key\"}}", emittedFalse));
        assertTrue(AiClient.parseModelsResponse("GEMINI", "[]").isEmpty());
        assertTrue(AiClient.parseModelsResponse("OPENAI", "not-json").isEmpty());

        // Anthropic endpoints, empty normalizeMessages, maxTokens bump
        assertEquals("https://api.anthropic.com/v1/messages", AnthropicProtocolAdapter.resolveMessagesEndpoint("https://api.anthropic.com/v1/messages"));
        assertEquals("https://api.anthropic.com/v1/models", AnthropicProtocolAdapter.resolveModelsEndpoint("https://api.anthropic.com"));
        assertEquals("Hello", AnthropicProtocolAdapter.normalizeMessages(List.of()).get(0).get("content"));
        JsonObject antBumped = AnthropicProtocolAdapter.buildPayload("claude-sonnet-4-20250514", "sys", List.of(), 0.4, 1024, true, 512);
        assertEquals(4096, antBumped.getAsJsonObject("thinking").get("budget_tokens").getAsInt());
        assertEquals(8192, antBumped.get("max_tokens").getAsInt());
        assertEquals("text", AnthropicProtocolAdapter.parseSseEvent("content_block_delta", "{\"delta\":{\"text\":\"fallback\"}}", null).get(0).kind());

        // AiClient null / unsupported protocol errors
        assertThrows(IllegalArgumentException.class, () -> AiClient.chat((AiProviderProfile) null, "sys", List.of()));
        AiProviderProfile badProto = new AiProviderProfile();
        badProto.setProtocol("UNKNOWN");
        assertThrows(IllegalArgumentException.class, () -> AiClient.chat(badProto, "sys", List.of()));

        // HTTP retry & error paths against local HttpServer
        com.sun.net.httpserver.HttpServer mock = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        var oaTries = new java.util.concurrent.atomic.AtomicInteger(0);
        var antTries = new java.util.concurrent.atomic.AtomicInteger(0);
        mock.createContext("/oa/v1/chat/completions", ex -> {
            int n = oaTries.incrementAndGet();
            if (n == 1) {
                byte[] b = "{\"error\":\"Unsupported parameter: max_tokens and reasoning_effort\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                ex.sendResponseHeaders(400, b.length);
                try (var os = ex.getResponseBody()) { os.write(b); }
                return;
            }
            ex.getResponseHeaders().set("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);
            try (var os = ex.getResponseBody()) {
                os.write("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        });
        mock.createContext("/gem429/v1beta/models", ex -> {
            byte[] b = "{\"error\":{\"message\":\"quota\"}}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            ex.sendResponseHeaders(429, b.length);
            try (var os = ex.getResponseBody()) { os.write(b); }
        });
        var gemDefaultOffBody = new java.util.concurrent.atomic.AtomicReference<String>();
        mock.createContext("/gemok/v1beta/models", ex -> {
            gemDefaultOffBody.set(new String(ex.getRequestBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
            ex.getResponseHeaders().set("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);
            try (var os = ex.getResponseBody()) {
                os.write("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gem-ok\"}]}}]}\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        });
        mock.createContext("/ant/v1/messages", ex -> {
            int n = antTries.incrementAndGet();
            if (n == 1) {
                byte[] b = "{\"error\":{\"message\":\"thinking is not supported\"}}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                ex.sendResponseHeaders(400, b.length);
                try (var os = ex.getResponseBody()) { os.write(b); }
                return;
            }
            ex.getResponseHeaders().set("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);
            try (var os = ex.getResponseBody()) {
                os.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ant-ok\"}}\n\nevent: message_stop\ndata: {}\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        });
        mock.start();
        try {
            int p = mock.getAddress().getPort();
            AiProviderProfile oaProf = new AiProviderProfile();
            oaProf.setProtocol("OPENAI");
            oaProf.setBaseUrl("http://127.0.0.1:" + p + "/oa/v1");
            oaProf.setModelName("gpt-5-mini");
            oaProf.setMaxTokens(1000);
            String oaReply = AiClient.chat(oaProf, "sys", List.of(Map.of("role", "user", "content", "hi")),
                    null, null, new AiClient.ThinkingOptions(true, null, "low"));
            assertEquals("ok", oaReply);
            assertEquals(2, oaTries.get());

            AiProviderProfile gemProf = new AiProviderProfile();
            gemProf.setProtocol("GEMINI");
            gemProf.setBaseUrl("http://127.0.0.1:" + p + "/gem429/v1beta");
            assertThrows(RuntimeException.class, () -> AiClient.chat(gemProf, "sys", List.of(Map.of("role", "user", "content", "hi"))));

            // Regression #18.4: Gemini profile with default enableThinking=false & thinkingBudget=4096 must send thinkingBudget=0
            AiProviderProfile gemOffProf = new AiProviderProfile();
            gemOffProf.setProtocol("GEMINI");
            gemOffProf.setBaseUrl("http://127.0.0.1:" + p + "/gemok/v1beta");
            assertFalse(gemOffProf.getEnableThinking());
            assertEquals(4096, gemOffProf.getThinkingBudget());
            assertEquals("gem-ok", AiClient.chat(gemOffProf, "sys", List.of(Map.of("role", "user", "content", "hi"))));
            JsonObject sentGemCfg = com.google.gson.JsonParser.parseString(gemDefaultOffBody.get()).getAsJsonObject()
                    .getAsJsonObject("generationConfig").getAsJsonObject("thinkingConfig");
            assertFalse(sentGemCfg.get("includeThoughts").getAsBoolean());
            assertEquals(0, sentGemCfg.get("thinkingBudget").getAsInt());

            AiProviderProfile antProf = new AiProviderProfile();
            antProf.setProtocol("ANTHROPIC");
            antProf.setBaseUrl("http://127.0.0.1:" + p + "/ant");
            antProf.setEnableThinking(true);
            String antReply = AiClient.chat(antProf, "sys", List.of(Map.of("role", "user", "content", "hi")));
            assertEquals("ant-ok", antReply);
            assertEquals(2, antTries.get());

            // Legacy AiSettings chat & chatStream entry points
            com.bear27570.app.model.AiSettings legacy = new com.bear27570.app.model.AiSettings();
            legacy.setProvider("OPENAI");
            legacy.setBaseUrl("http://127.0.0.1:" + p + "/oa/v1");
            legacy.setModelName("gpt-4o");
            assertEquals("ok", AiClient.chat(legacy, "sys", List.of(Map.of("role", "user", "content", "hi"))));
            StringBuilder legacyStreamed = new StringBuilder();
            AiClient.chatStream(legacy, "sys", List.of(Map.of("role", "user", "content", "hi")),
                    legacyStreamed::append, new java.util.concurrent.atomic.AtomicBoolean(false));
            assertEquals("ok", legacyStreamed.toString());
        } finally {
            mock.stop(0);
        }
    }
}
