package com.bear27570.app.util;

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
}
