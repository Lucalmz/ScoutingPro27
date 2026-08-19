package com.bear27570.app.util;

import org.junit.jupiter.api.Test;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import static org.junit.jupiter.api.Assertions.*;

class AESUtilTest {

    @Test
    void testEncryptionAndDecryption() {
        String plainText = "sk-test-openai-key-123456789";
        
        // Encrypt
        String encrypted = AESUtil.encrypt(plainText);
        assertNotNull(encrypted);
        assertNotEquals(plainText, encrypted);
        
        // Decrypt
        String decrypted = AESUtil.decrypt(encrypted);
        assertNotNull(decrypted);
        assertEquals(plainText, decrypted);
    }

    @Test
    void testMasterKeyFileCreatedAndAccessibleOnWindows() throws Exception {
        String masterKeyPath = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "master.key";
        File file = new File(masterKeyPath);
        
        assertTrue(file.exists(), "Master key file should exist on the filesystem");
        assertTrue(file.length() > 0, "Master key file should contain key bytes");
        
        // Verify the file is readable and writable by the owner in current environment
        assertTrue(file.canRead(), "Owner must be able to read master.key");
        assertTrue(file.canWrite(), "Owner must be able to write master.key");
        
        byte[] readBytes = Files.readAllBytes(file.toPath());
        assertEquals(32, readBytes.length, "256-bit key should be exactly 32 bytes");
    }

    @Test
    void testEmptyAndNull() {
        assertEquals("", AESUtil.encrypt(""));
        assertNull(AESUtil.encrypt(null));
        
        assertEquals("", AESUtil.decrypt(""));
        assertNull(AESUtil.decrypt(null));
    }

    @Test
    void testInvalidCiphertextThrowsKeyDecryptionException() {
        assertThrows(KeyDecryptionException.class, () -> {
            AESUtil.decrypt("not_a_valid_base64_payload!!!");
        });

        assertThrows(KeyDecryptionException.class, () -> {
            AESUtil.decrypt(Base64.getEncoder().encodeToString("short".getBytes(StandardCharsets.UTF_8)));
        });
    }

    @Test
    void testLegacyCbcDecryptionCompatibility() throws Exception {
        String expectedPlainText = "AIzaSy-legacy-cbc-encrypted-key-55555";
        
        // 1. Manually construct legacy CBC payload using the actual master key file
        String masterKeyPath = System.getProperty("user.home") + File.separator + ".scoutingpro27" + File.separator + "master.key";
        byte[] keyBytes = Files.readAllBytes(Paths.get(masterKeyPath));
        SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "AES");
        
        byte[] cbcIv = new byte[16];
        new java.security.SecureRandom().nextBytes(cbcIv);
        
        Cipher cbcCipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cbcCipher.init(Cipher.ENCRYPT_MODE, keySpec, new IvParameterSpec(cbcIv));
        byte[] encryptedText = cbcCipher.doFinal(expectedPlainText.getBytes(StandardCharsets.UTF_8));
        
        // 2. Prepend 16-byte IV (legacy CBC format)
        byte[] legacyCipherWithIv = new byte[cbcIv.length + encryptedText.length];
        System.arraycopy(cbcIv, 0, legacyCipherWithIv, 0, cbcIv.length);
        System.arraycopy(encryptedText, 0, legacyCipherWithIv, cbcIv.length, encryptedText.length);
        String legacyBase64 = Base64.getEncoder().encodeToString(legacyCipherWithIv);
        
        // 3. Decrypt using the new AESUtil.decrypt (GCM with CBC fallback)
        String decrypted = AESUtil.decrypt(legacyBase64);
        
        // 4. Verify that legacy CBC payload is seamlessly decrypted
        assertNotNull(decrypted, "Decrypted legacy string should not be null");
        assertEquals(expectedPlainText, decrypted, "AESUtil.decrypt must transparently decrypt legacy CBC ciphertext");
    }
}
