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
        JsonElement el = obj.get(field);
        if (!el.isJsonPrimitive()) {
            throw new IllegalArgumentException("Field '" + field + "' must be a string");
        }
        return el.getAsString();
    }

    public static Boolean getOptionalBoolean(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(field);
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isBoolean()) {
            throw new IllegalArgumentException("Field '" + field + "' must be a boolean");
        }
        return el.getAsBoolean();
    }

    public static Double getOptionalDouble(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(field);
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Field '" + field + "' must be a number");
        }
        double val = el.getAsDouble();
        if (!Double.isFinite(val)) {
            throw new IllegalArgumentException("Field '" + field + "' must be a finite number");
        }
        return val;
    }

    public static Integer getOptionalInt(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(field);
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Field '" + field + "' must be an integer");
        }
        double val = el.getAsDouble();
        if (!Double.isFinite(val) || val != Math.rint(val) || val < Integer.MIN_VALUE || val > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Field '" + field + "' must be a valid integer");
        }
        return (int) val;
    }

    public static boolean hasControlChars(String value) {
        if (value == null) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\r' || c == '\n' || c == '\0') {
                return true;
            }
        }
        return false;
    }

    public static String stripControlChars(String value) {
        if (value == null) return "";
        return value.replace("\r", "").replace("\n", "").replace("\0", "");
    }

    public static String truncate(String value, int maxLen) {
        if (value == null) return "";
        return value.length() > maxLen ? value.substring(0, maxLen) : value;
    }

    public static String stripQueryAndFragment(String baseUrl) {
        if (baseUrl == null) return "";
        String trimmed = baseUrl.trim();
        int qIdx = trimmed.indexOf('?');
        int hIdx = trimmed.indexOf('#');
        int cut = -1;
        if (qIdx >= 0 && hIdx >= 0) {
            cut = Math.min(qIdx, hIdx);
        } else if (qIdx >= 0) {
            cut = qIdx;
        } else if (hIdx >= 0) {
            cut = hIdx;
        }
        if (cut >= 0) {
            trimmed = trimmed.substring(0, cut);
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
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
        if (body.has("messages") && !body.get("messages").isJsonNull()) {
            if (!body.get("messages").isJsonArray()) {
                throw new IllegalArgumentException("Field 'messages' must be an array");
            }
            JsonArray arr = body.getAsJsonArray("messages");
            for (JsonElement e : arr) {
                if (e.isJsonObject()) {
                    JsonObject msgObj = e.getAsJsonObject();
                    Map<String, String> m = new HashMap<>();
                    String role = getOptionalString(msgObj, "role");
                    String content = getOptionalString(msgObj, "content");
                    m.put("role", role != null ? role : "user");
                    m.put("content", content != null ? content : "");
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

    public static boolean isDecryptableEncryptedKey(String encrypted) {
        if (encrypted == null || encrypted.isBlank()) {
            return false;
        }
        try {
            String raw = AESUtil.decrypt(encrypted);
            return raw != null && !raw.isBlank();
        } catch (Exception e) {
            return false;
        }
    }

    public static String defaultBaseUrlForProtocol(String protocol) {
        if (protocol == null) return "";
        return switch (protocol.trim().toUpperCase(Locale.ROOT)) {
            case "OPENAI" -> "https://api.openai.com/v1";
            case "GEMINI" -> "https://generativelanguage.googleapis.com/v1beta";
            case "ANTHROPIC" -> "https://api.anthropic.com";
            default -> "";
        };
    }

    private static String normalizeBaseUrlForComparison(String url) {
        if (url == null) return "";
        String t = url.trim();
        while (t.endsWith("/")) {
            t = t.substring(0, t.length() - 1);
        }
        return t;
    }

    public static boolean isTrustedSavedUrl(String customBaseUrl, String savedBaseUrl) {
        return isTrustedSavedUrl(customBaseUrl, savedBaseUrl, null);
    }

    public static boolean isTrustedSavedUrl(String customBaseUrl, String savedBaseUrl, String protocol) {
        if (customBaseUrl == null || customBaseUrl.isBlank()) {
            return true;
        }
        String effectiveSaved = (savedBaseUrl != null && !savedBaseUrl.isBlank())
                ? savedBaseUrl
                : defaultBaseUrlForProtocol(protocol);
        if (effectiveSaved == null || effectiveSaved.isBlank()) {
            return false;
        }
        return normalizeBaseUrlForComparison(effectiveSaved)
                .equalsIgnoreCase(normalizeBaseUrlForComparison(customBaseUrl));
    }

    public static boolean isSafeUrl(String urlStr) {
        return isSafeUrlWithSchemes(urlStr, "http", "https");
    }

    public static boolean isSafeWebSocketUrl(String urlStr) {
        return isSafeUrlWithSchemes(urlStr, "ws", "wss");
    }

    private static boolean isSafeUrlWithSchemes(String urlStr, String schemeA, String schemeB) {
        if (urlStr == null || urlStr.isBlank() || hasControlChars(urlStr)) return false;
        try {
            URI uri = new URI(urlStr.trim());
            if (uri.getUserInfo() != null) return false;
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals(schemeA) && !scheme.equals(schemeB)) {
                return false;
            }
            return isSafeHost(uri);
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean isSafeProxyHost(String host) {
        if (host == null || host.isBlank()) {
            return true;
        }
        if (hasControlChars(host)) {
            return false;
        }
        return isSafeHostString(host);
    }

    private static boolean isSafeHost(URI uri) {
        return isSafeHostString(uri.getHost());
    }

    private static boolean isSafeHostString(String rawHost) {
        try {
            if (rawHost == null || rawHost.isBlank()) return false;
            String host = rawHost.trim().toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length() - 1);
            }
            if (host.isEmpty() || hasControlChars(host)) return false;

            if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("0:0:0:0:0:0:0:1")) {
                return true;
            }
            InetAddress[] addrs = InetAddress.getAllByName(host);
            if (addrs == null || addrs.length == 0) {
                return false;
            }
            for (InetAddress addr : addrs) {
                if (!isPublicAddress(addr)) {
                    return false;
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isPublicAddress(InetAddress addr) {
        if (addr == null) return false;
        if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress()
                || addr.isAnyLocalAddress() || addr.isMulticastAddress()) {
            return false;
        }
        byte[] bytes = addr.getAddress();
        if (bytes.length == 4) {
            return isPublicIpv4(bytes);
        }
        if (bytes.length == 16) {
            // IPv6 ::, ::1, and IPv4-compatible IPv6 ::/96 (all first 12 bytes zero)
            boolean isZeroPrefix96 = true;
            for (int i = 0; i < 12; i++) {
                if (bytes[i] != 0) {
                    isZeroPrefix96 = false;
                    break;
                }
            }
            if (isZeroPrefix96) {
                byte[] v4 = new byte[]{bytes[12], bytes[13], bytes[14], bytes[15]};
                return isPublicIpv4(v4);
            }
            // IPv4-mapped IPv6 ::ffff:0:0/96
            boolean isIpv4Mapped = true;
            for (int i = 0; i < 10; i++) {
                if (bytes[i] != 0) {
                    isIpv4Mapped = false;
                    break;
                }
            }
            if (isIpv4Mapped && bytes[10] == (byte) 0xff && bytes[11] == (byte) 0xff) {
                byte[] v4 = new byte[]{bytes[12], bytes[13], bytes[14], bytes[15]};
                return isPublicIpv4(v4);
            }
            int b0 = bytes[0] & 0xFF;
            int b1 = bytes[1] & 0xFF;
            // IPv6 ULA fc00::/7
            if ((b0 & 0xFE) == 0xFC) {
                return false;
            }
            // IPv6 Link-Local fe80::/10
            if (b0 == 0xFE && (b1 & 0xC0) == 0x80) {
                return false;
            }
            // IPv6 Site-Local fec0::/10
            if (b0 == 0xFE && (b1 & 0xC0) == 0xC0) {
                return false;
            }
            // IPv6 Multicast ff00::/8
            if (b0 == 0xFF) {
                return false;
            }
            return true;
        }
        return false;
    }

    private static boolean isPublicIpv4(byte[] bytes) {
        int b0 = bytes[0] & 0xFF;
        int b1 = bytes[1] & 0xFF;
        if (b0 == 0) return false;                           // 0.0.0.0/8 ("this" network)
        if (b0 == 10) return false;                          // 10.0.0.0/8 (private)
        if (b0 == 100 && (b1 & 0xC0) == 64) return false;    // 100.64.0.0/10 (CGNAT / cloud metadata)
        if (b0 == 127) return false;                         // 127.0.0.0/8 (loopback)
        if (b0 == 169 && b1 == 254) return false;            // 169.254.0.0/16 (link-local / metadata)
        if (b0 == 172 && b1 >= 16 && b1 <= 31) return false; // 172.16.0.0/12 (private)
        if (b0 == 192 && b1 == 168) return false;            // 192.168.0.0/16 (private)
        if (b0 >= 224) return false;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
        return true;
    }
}
