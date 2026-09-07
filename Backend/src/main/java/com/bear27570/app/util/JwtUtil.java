package com.bear27570.app.util;

import com.auth0.jwt.JWT;
import com.auth0.jwt.JWTVerifier;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.exceptions.JWTVerificationException;
import com.auth0.jwt.interfaces.DecodedJWT;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import com.bear27570.app.db.AppConfig;
import java.util.Date;

public class JwtUtil {
    private static final String SECRET_FILE_PATH = resolveSecretPath();
    private static final long EXPIRATION_TIME_MS = 7L * 24 * 3600 * 1000; // 7 days
    public static final long HANDSHAKE_TICKET_EXPIRATION_MS = 3 * 60 * 1000; // 3 minutes
    private static Algorithm ALGORITHM;

    public static File getSecretFile() {
        return AppConfig.resolveJwtSecretFile();
    }

    private static String resolveSecretPath() {
        return getSecretFile().getAbsolutePath();
    }

    static {
        try {
            File secretFile = new File(SECRET_FILE_PATH);
            File parent = secretFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            String secret;
            if (secretFile.exists()) {
                secret = new String(Files.readAllBytes(Paths.get(SECRET_FILE_PATH)));
            } else {
                byte[] randomBytes = new byte[32];
                new SecureRandom().nextBytes(randomBytes);
                secret = Base64.getEncoder().encodeToString(randomBytes);
                Files.write(Paths.get(SECRET_FILE_PATH), secret.getBytes());
            }
            ALGORITHM = Algorithm.HMAC256(secret);
        } catch (IOException e) {
            System.err.println("Failed to initialize JWT secret: " + e.getMessage());
            throw new RuntimeException("Failed to initialize JWT secret", e);
        }
    }

    public static String generateToken(String userId, String username) {
        return JWT.create()
                .withIssuer("ScoutingPro27")
                .withClaim("scope", "api:full")
                .withClaim("userId", userId)
                .withClaim("username", username)
                .withExpiresAt(new Date(System.currentTimeMillis() + EXPIRATION_TIME_MS))
                .sign(ALGORITHM);
    }

    public static String verifyToken(String token) {
        try {
            JWTVerifier verifier = JWT.require(ALGORITHM)
                    .withIssuer("ScoutingPro27")
                    .build();
            DecodedJWT jwt = verifier.verify(token);
            String scope = jwt.getClaim("scope").asString();
            if ("webrtc:handshake".equals(scope)) {
                // Handshake ticket cannot be used for general API access!
                return null;
            }
            return jwt.getClaim("userId").asString();
        } catch (JWTVerificationException exception) {
            return null; // Invalid signature/claims
        }
    }

    public static String sha256Hex(String data) {
        if (data == null) return "";
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 algorithm not available", e);
        }
    }

    public static String generateWebRtcTicket(String userId, String username, String eventId, String ecdhPublicKey) {
        String pkHash = sha256Hex(ecdhPublicKey != null ? ecdhPublicKey.trim().toLowerCase() : "");
        return JWT.create()
                .withIssuer("ScoutingPro27")
                .withSubject("WEBRTC_HANDSHAKE")
                .withClaim("scope", "webrtc:handshake")
                .withClaim("userId", userId)
                .withClaim("username", username)
                .withClaim("eventId", eventId)
                .withClaim("pkHash", pkHash)
                .withExpiresAt(new Date(System.currentTimeMillis() + HANDSHAKE_TICKET_EXPIRATION_MS))
                .sign(ALGORITHM);
    }

    public static class WebRtcTicketValidation {
        private final boolean valid;
        private final String userId;
        private final String username;
        private final String eventId;
        private final String errorMessage;

        public WebRtcTicketValidation(boolean valid, String userId, String username, String eventId, String errorMessage) {
            this.valid = valid;
            this.userId = userId;
            this.username = username;
            this.eventId = eventId;
            this.errorMessage = errorMessage;
        }

        public boolean isValid() { return valid; }
        public String getUserId() { return userId; }
        public String getUsername() { return username; }
        public String getEventId() { return eventId; }
        public String getErrorMessage() { return errorMessage; }
    }

    public static WebRtcTicketValidation verifyWebRtcTicket(String ticket, String expectedEventId, String actualEcdhPublicKey) {
        try {
            JWTVerifier verifier = JWT.require(ALGORITHM)
                    .withIssuer("ScoutingPro27")
                    .withSubject("WEBRTC_HANDSHAKE")
                    .build();
            DecodedJWT jwt = verifier.verify(ticket);

            String scope = jwt.getClaim("scope").asString();
            if (!"webrtc:handshake".equals(scope)) {
                return new WebRtcTicketValidation(false, null, null, null, "Invalid ticket scope");
            }

            String ticketEventId = jwt.getClaim("eventId").asString();
            if (expectedEventId != null && !expectedEventId.isBlank() && !expectedEventId.equals(ticketEventId)) {
                return new WebRtcTicketValidation(false, null, null, null, "Event ID mismatch");
            }

            String expectedPkHash = jwt.getClaim("pkHash").asString();
            String actualPkHash = sha256Hex(actualEcdhPublicKey != null ? actualEcdhPublicKey.trim().toLowerCase() : "");
            if (expectedPkHash == null || expectedPkHash.isBlank() || !expectedPkHash.equalsIgnoreCase(actualPkHash)) {
                return new WebRtcTicketValidation(false, null, null, null, "Public key hash mismatch (possible replay or MITM attack)");
            }

            String userId = jwt.getClaim("userId").asString();
            String username = jwt.getClaim("username").asString();
            return new WebRtcTicketValidation(true, userId, username, ticketEventId, null);
        } catch (JWTVerificationException exception) {
            return new WebRtcTicketValidation(false, null, null, null, "Invalid or expired ticket: " + exception.getMessage());
        }
    }
}
