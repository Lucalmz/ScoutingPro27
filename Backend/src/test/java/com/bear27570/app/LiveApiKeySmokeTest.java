package com.bear27570.app;

import com.bear27570.app.dao.AiSettingsDao;
import com.bear27570.app.model.AiSettings;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.AiClient;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;

import java.io.File;
import java.util.List;
import java.util.Map;

public class LiveApiKeySmokeTest {

    public static void main(String[] args) {
        System.out.println("================================================================================");
        System.out.println("[LIVE SMOKE TEST] Checking for stored API Keys in ./app_data database...");

        File dbFile = new File("./app_data.mv.db");
        if (!dbFile.exists()) {
            System.out.println("No local app_data.mv.db found at: " + dbFile.getAbsolutePath());
            System.out.println("================================================================================");
            return;
        }

        try {
            Jdbi jdbi = Jdbi.create("jdbc:h2:./app_data;AUTO_SERVER=TRUE", "sa", "");
            jdbi.installPlugin(new SqlObjectPlugin());

            List<AiSettings> allSettings = jdbi.withExtension(AiSettingsDao.class, dao -> {
                try {
                    return jdbi.withHandle(handle -> 
                        handle.createQuery("SELECT * FROM ai_settings")
                              .mapToBean(AiSettings.class)
                              .list()
                    );
                } catch (Exception e) {
                    System.out.println("Error querying ai_settings table: " + e.getMessage());
                    return List.of();
                }
            });

            if (allSettings.isEmpty()) {
                System.out.println("No configured AI settings found in database.");
                System.out.println("================================================================================");
                return;
            }

            System.out.println("Found " + allSettings.size() + " AI setting(s) in database.");
            for (AiSettings setting : allSettings) {
                System.out.println("\nTesting Provider: " + setting.getProvider() + ", Model: " + setting.getModelName());
                try {
                    String decryptedKey = AESUtil.decrypt(setting.getApiKeyEncrypted());
                    String maskedKey = decryptedKey.length() > 6 
                            ? decryptedKey.substring(0, 2) + "****************" + decryptedKey.substring(decryptedKey.length() - 4)
                            : "****";
                    System.out.println("Decrypted Key prefix/suffix: " + maskedKey);

                    long start = System.currentTimeMillis();
                    List<Map<String, String>> messages = List.of(Map.of("role", "user", "content", "hi"));
                    String reply = AiClient.chat(setting, "Respond with one short greeting.", messages);
                    long duration = System.currentTimeMillis() - start;

                    System.out.println("  -> Call Result: SUCCESS (" + duration + "ms)");
                    System.out.println("  -> AI Reply: " + reply.trim());
                } catch (Exception e) {
                    System.out.println("  -> Call Result: FAILED (" + e.getMessage() + ")");
                }
            }
            System.out.println("================================================================================");
        } catch (Exception e) {
            System.out.println("Smoke test execution error: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
