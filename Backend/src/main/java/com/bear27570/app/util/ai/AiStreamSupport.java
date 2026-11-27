package com.bear27570.app.util.ai;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.InputStream;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Shared HTTP cancellation, JSON extraction, and context-window helpers across AI protocol adapters.
 */
public final class AiStreamSupport {
    public static final Gson GSON = new Gson();
    public static final String DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

    private AiStreamSupport() {}

    public static List<Map<String, String>> trimContextMessages(List<Map<String, String>> messages, Integer maxContextMsgs) {
        if (messages == null || messages.isEmpty()) {
            return Collections.emptyList();
        }
        if (maxContextMsgs != null && maxContextMsgs > 0 && messages.size() > maxContextMsgs) {
            return new ArrayList<>(messages.subList(messages.size() - maxContextMsgs, messages.size()));
        }
        return messages;
    }

    public static String getNonEmptyString(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(field);
        if (!el.isJsonPrimitive()) {
            return null;
        }
        String val = el.getAsString();
        return val.isEmpty() ? null : val;
    }

    public static int getIntOrDefault(JsonObject obj, String field, int defaultVal) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return defaultVal;
        }
        try {
            return obj.get(field).getAsInt();
        } catch (Exception e) {
            return defaultVal;
        }
    }

    public static HttpResponse<InputStream> awaitResponseWithCancellation(
            CompletableFuture<HttpResponse<InputStream>> future,
            AtomicBoolean isCancelled
    ) throws Exception {
        try {
            while (!future.isDone()) {
                if (isCancelled != null && isCancelled.get()) {
                    future.cancel(true);
                    return null;
                }
                try {
                    return future.get(500, TimeUnit.MILLISECONDS);
                } catch (TimeoutException te) {
                    // poll cancellation flag periodically
                }
            }
            return future.get();
        } catch (Exception e) {
            if (isCancelled != null && isCancelled.get()) {
                future.cancel(true);
                return null;
            }
            throw e;
        }
    }
}
