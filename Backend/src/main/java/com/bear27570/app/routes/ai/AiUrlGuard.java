package com.bear27570.app.routes.ai;

import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.KeyDecryptionException;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.InetAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Shared SSRF validation, API key masking, and JSON coercion utilities for AI route handlers.
 */
public final class AiUrlGuard {
    private AiUrlGuard() {}

    public static String asString(Object val) {
        return val == null ? null : String.valueOf(val);
    }

    public static String getOptionalString(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        return obj.get(field).getAsString();
    }

    public static JsonObject parseOptionalJsonObject(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            JsonElement el = JsonParser.parseString(raw);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    public static List<Map<String, String>> parseMessagesArray(JsonObject body) {
        List<Map<String, String>> msgList = new ArrayList<>();
        if (body.has("messages") && body.get("messages").isJsonArray()) {
            JsonArray arr = body.getAsJsonArray("messages");
            for (JsonElement e : arr) {
                if (e.isJsonObject()) {
                    JsonObject msgObj = e.getAsJsonObject();
                    Map<String, String> m = new HashMap<>();
                    m.put("role", msgObj.has("role") && !msgObj.get("role").isJsonNull() ? msgObj.get("role").getAsString() : "user");
                    m.put("content", msgObj.has("content") && !msgObj.get("content").isJsonNull() ? msgObj.get("content").getAsString() : "");
                    msgList.add(m);
                }
            }
        }
        return msgList;
    }

    public static String maskEncryptedKey(String encrypted) {
        if (encrypted == null || encrypted.isEmpty()) {
            return "";
        }
        try {
            String raw = AESUtil.decrypt(encrypted);
            if (raw != null && raw.length() > 6) {
                return raw.substring(0, 2) + "****************" + raw.substring(raw.length() - 4);
            } else if (raw != null && !raw.isEmpty()) {
                return "****";
            }
            return "";
        } catch (KeyDecryptionException e) {
            return "ERR_KEY_LOST";
        }
    }

    public static boolean isBlankOrMasked(String key) {
        if (key == null || key.isBlank()) return true;
        String t = key.trim();
        return t.contains("***") || "****".equals(t) || "ERR_KEY_LOST".equals(t);
    }

    public static boolean isTrustedSavedUrl(String customBaseUrl, String savedBaseUrl) {
        if (customBaseUrl == null || customBaseUrl.isBlank()) {
            return true;
        }
        if (savedBaseUrl == null || savedBaseUrl.isBlank()) {
            return false;
        }
        return savedBaseUrl.trim().equalsIgnoreCase(customBaseUrl.trim());
    }

    public static boolean isSafeUrl(String urlStr) {
        if (urlStr == null || urlStr.isBlank()) return false;
        try {
            URI uri = new URI(urlStr.trim());
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                return false;
            }
            String host = uri.getHost();
            if (host == null || host.isBlank()) return false;
            host = host.toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length() - 1);
            }

            if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("0:0:0:0:0:0:0:1")) {
                return true;
            }
            InetAddress addr = InetAddress.getByName(host);
            if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress() || addr.isAnyLocalAddress()) {
                return false;
            }
            String ip = addr.getHostAddress();
            if (ip.startsWith("169.254.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
                return false;
            }
            if (ip.startsWith("172.")) {
                String[] parts = ip.split("\\.");
                if (parts.length >= 2) {
                    try {
                        int second = Integer.parseInt(parts[1]);
                        if (second >= 16 && second <= 31) return false;
                    } catch (NumberFormatException ignored) {}
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
