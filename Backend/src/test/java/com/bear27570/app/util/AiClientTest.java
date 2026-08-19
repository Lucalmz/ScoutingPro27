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
}
