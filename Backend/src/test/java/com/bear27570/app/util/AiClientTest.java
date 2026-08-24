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
}
