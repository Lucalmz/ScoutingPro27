package com.bear27570.app.util;

import com.auth0.jwt.JWT;
import com.auth0.jwt.JWTVerifier;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.exceptions.JWTVerificationException;
import com.auth0.jwt.interfaces.DecodedJWT;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Date;

public class JwtUtil {
    private static final String SECRET_FILE_PATH = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "jwt.secret";
    private static final long EXPIRATION_TIME_MS = 7L * 24 * 3600 * 1000; // 7 days
    private static Algorithm ALGORITHM;

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
            return jwt.getClaim("userId").asString();
        } catch (JWTVerificationException exception) {
            return null; // Invalid signature/claims
        }
    }
}
