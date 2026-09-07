package com.bear27570.app.util;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

public class UserUtil {

    /**
     * Generates a deterministic UUID (RFC 4122 v3 MD5) based on normalized username and password.
     * Normalized: trimmed and converted to lowercase with Locale.ROOT.
     * Prefix: "user:<normalizedUsername>:<password>".
     */
    public static String generateDeterministicUserId(String username, String password) {
        if (username == null) {
            throw new IllegalArgumentException("username cannot be null");
        }
        String normalized = username.trim().toLowerCase(Locale.ROOT);
        String pwd = password != null ? password : "";
        String raw = "ScoutingPro27:v1:" + normalized + ":" + pwd;
        return UUID.nameUUIDFromBytes(raw.getBytes(StandardCharsets.UTF_8)).toString();
    }

    public static String generateDeterministicUserId(String username) {
        return generateDeterministicUserId(username, "");
    }
}
