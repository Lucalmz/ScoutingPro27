package com.bear27570.app.util;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

public class AESUtil {
    private static final String ALGORITHM = "AES";
    private static final String GCM_CIPHER_ALGORITHM = "AES/GCM/NoPadding";
    private static final String CBC_CIPHER_ALGORITHM = "AES/CBC/PKCS5Padding";
    private static final int KEY_SIZE = 256;
    private static final int GCM_IV_SIZE = 12;
    private static final int GCM_TAG_LENGTH_BIT = 128;
    private static final int CBC_IV_SIZE = 16;
    private static final String MASTER_KEY_FILE = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "master.key";

    private static SecretKey secretKey;

    static {
        try {
            initMasterKey();
        } catch (Exception e) {
            System.err.println("CRITICAL: Failed to initialize AES Master Key. AI features will fail.");
            e.printStackTrace();
        }
    }

    public static synchronized void initMasterKey() throws Exception {
        File keyFile = new File(MASTER_KEY_FILE);
        if (keyFile.exists() && keyFile.length() > 0) {
            byte[] keyBytes = Files.readAllBytes(keyFile.toPath());
            secretKey = new SecretKeySpec(keyBytes, ALGORITHM);
        } else {
            // Generate a new 256-bit AES key
            KeyGenerator keyGen = KeyGenerator.getInstance(ALGORITHM);
            keyGen.init(KEY_SIZE, new SecureRandom());
            secretKey = keyGen.generateKey();

            // Ensure parent directory exists
            File parentDir = keyFile.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }

            // Save the key
            Files.write(keyFile.toPath(), secretKey.getEncoded());

            // Restrict permissions cross-platform without locking out the owner
            restrictFilePermissions(keyFile.toPath());
        }
    }

    private static void restrictFilePermissions(Path path) {
        try {
            File file = path.toFile();
            // Ensure owner has read and write access
            file.setReadable(true, true);
            file.setWritable(true, true);
            file.setExecutable(false, false);
        } catch (Exception e) {
            System.err.println("Warning: Failed to set strict permissions on master.key: " + e.getMessage());
        }
    }

    public static String encrypt(String plainText) {
        if (plainText == null || plainText.isEmpty()) return plainText;
        if (secretKey == null) throw new IllegalStateException("AES Master Key not initialized");
        try {
            byte[] iv = new byte[GCM_IV_SIZE];
            new SecureRandom().nextBytes(iv);

            Cipher cipher = Cipher.getInstance(GCM_CIPHER_ALGORITHM);
            GCMParameterSpec gcmSpec = new GCMParameterSpec(GCM_TAG_LENGTH_BIT, iv);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, gcmSpec);

            byte[] encryptedText = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));

            // Prepend 12-byte IV to GCM ciphertext
            byte[] cipherWithIv = new byte[iv.length + encryptedText.length];
            System.arraycopy(iv, 0, cipherWithIv, 0, iv.length);
            System.arraycopy(encryptedText, 0, cipherWithIv, iv.length, encryptedText.length);

            return Base64.getEncoder().encodeToString(cipherWithIv);
        } catch (Exception e) {
            throw new RuntimeException("Encryption failed", e);
        }
    }

    public static String decrypt(String encryptedBase64) {
        if (encryptedBase64 == null || encryptedBase64.isEmpty()) return encryptedBase64;
        if (secretKey == null) throw new IllegalStateException("AES Master Key not initialized");

        byte[] cipherWithIv;
        try {
            cipherWithIv = Base64.getDecoder().decode(encryptedBase64);
        } catch (IllegalArgumentException e) {
            throw new KeyDecryptionException("Decryption failed: invalid Base64 payload", e);
        }

        if (cipherWithIv.length < GCM_IV_SIZE) {
            throw new KeyDecryptionException("Invalid encrypted payload (too short)", null);
        }

        // Try GCM decryption first
        try {
            byte[] iv = Arrays.copyOfRange(cipherWithIv, 0, GCM_IV_SIZE);
            byte[] encryptedText = Arrays.copyOfRange(cipherWithIv, GCM_IV_SIZE, cipherWithIv.length);

            Cipher cipher = Cipher.getInstance(GCM_CIPHER_ALGORITHM);
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BIT, iv));
            byte[] plainText = cipher.doFinal(encryptedText);

            return new String(plainText, StandardCharsets.UTF_8);
        } catch (Exception gcmEx) {
            // Fallback to legacy CBC decryption if GCM fails
            if (cipherWithIv.length >= CBC_IV_SIZE) {
                try {
                    byte[] iv = Arrays.copyOfRange(cipherWithIv, 0, CBC_IV_SIZE);
                    byte[] encryptedText = Arrays.copyOfRange(cipherWithIv, CBC_IV_SIZE, cipherWithIv.length);

                    Cipher cipher = Cipher.getInstance(CBC_CIPHER_ALGORITHM);
                    cipher.init(Cipher.DECRYPT_MODE, secretKey, new IvParameterSpec(iv));
                    byte[] plainText = cipher.doFinal(encryptedText);

                    return new String(plainText, StandardCharsets.UTF_8);
                } catch (Exception cbcEx) {
                    throw new KeyDecryptionException("Decryption failed. The master key may have been reset or the payload is corrupted.", gcmEx);
                }
            }
            throw new KeyDecryptionException("Decryption failed. The master key may have been reset or the payload is corrupted.", gcmEx);
        }
    }
}
