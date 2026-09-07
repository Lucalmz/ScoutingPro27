package com.bear27570.app.db;

import com.bear27570.app.util.UserUtil;
import org.jdbi.v3.core.Handle;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

public class UserDeterministicIdMigrator {

    private static final Logger logger = LoggerFactory.getLogger(UserDeterministicIdMigrator.class);

    public static void migrate(Jdbi jdbi) {
        jdbi.useTransaction(handle -> {
            // Disable referential integrity temporarily in H2 for safe batch ID transformation
            handle.execute("SET REFERENTIAL_INTEGRITY FALSE");
            try {
                List<com.bear27570.app.model.User> userRows = handle.createQuery(
                        "SELECT id, username, password, created_at FROM users ORDER BY created_at ASC"
                ).mapToBean(com.bear27570.app.model.User.class).list();

                if (userRows.isEmpty()) {
                    return;
                }

                // Group users by normalized username (trimmed, lowercase)
                Map<String, List<com.bear27570.app.model.User>> grouped = new LinkedHashMap<>();
                for (com.bear27570.app.model.User u : userRows) {
                    String username = u.getUsername();
                    if (username == null) continue;
                    String normalized = username.trim().toLowerCase(Locale.ROOT);
                    grouped.computeIfAbsent(normalized, k -> new ArrayList<>()).add(u);
                }

                for (Map.Entry<String, List<com.bear27570.app.model.User>> entry : grouped.entrySet()) {
                    List<com.bear27570.app.model.User> group = entry.getValue();
                    if (group.isEmpty()) continue;

                    // Primary user in this group
                    com.bear27570.app.model.User primaryUser = group.get(0);
                    String primaryOldId = primaryUser.getId();
                    String primaryUsername = primaryUser.getUsername();
                    String primaryPassword = primaryUser.getPassword();
                    String primaryTargetId = UserUtil.generateDeterministicUserId(primaryUsername);

                    // Update primary user ID if changed
                    if (!primaryOldId.equals(primaryTargetId)) {
                        handle.execute("UPDATE users SET id = ? WHERE id = ?", primaryTargetId, primaryOldId);
                        updateForeignKeys(handle, primaryOldId, primaryTargetId);
                        logger.info("Migrated user '{}' ID from {} to deterministic {}", primaryUsername, primaryOldId, primaryTargetId);
                    }

                    // Handle subsequent users in the same normalized group
                    int legacyAliasIndex = 1;
                    for (int i = 1; i < group.size(); i++) {
                        com.bear27570.app.model.User secondaryUser = group.get(i);
                        String secOldId = secondaryUser.getId();
                        String secUsername = secondaryUser.getUsername();
                        String secPassword = secondaryUser.getPassword();

                        // Check if it's the exact same password/account
                        boolean samePassword = Objects.equals(primaryPassword, secPassword) ||
                                (secPassword == null || secPassword.isBlank());

                        if (samePassword) {
                            // Merge into primary user
                            updateForeignKeys(handle, secOldId, primaryTargetId);
                            handle.execute("DELETE FROM users WHERE id = ?", secOldId);
                            logger.info("Merged duplicate user '{}' ({}) into primary user {}", secUsername, secOldId, primaryTargetId);
                        } else {
                            // Secondary account with different password -> create alias
                            String aliasUsername = primaryUsername + " (legacy-" + legacyAliasIndex + ")";
                            legacyAliasIndex++;
                            String aliasId = UserUtil.generateDeterministicUserId(aliasUsername);

                            handle.execute("UPDATE users SET id = ?, username = ? WHERE id = ?",
                                    aliasId, aliasUsername, secOldId);
                            updateForeignKeys(handle, secOldId, aliasId);
                            logger.info("Migrated conflicting user '{}' ({}) to alias '{}' ({})",
                                    secUsername, secOldId, aliasUsername, aliasId);
                        }
                    }
                }
            } finally {
                handle.execute("SET REFERENTIAL_INTEGRITY TRUE");
            }
        });
    }

    public static void cascadeMigrateUserId(Handle handle, String oldId, String newId) {
        if (oldId == null || newId == null || oldId.equals(newId)) return;

        // 1. Insert new user row copying username, password, created_at from old row
        handle.execute("""
            MERGE INTO users (id, username, password, created_at) KEY(id)
            SELECT ?, username, password, created_at FROM users WHERE id = ?
        """, newId, oldId);

        // 2. Cascade foreign keys to new ID
        updateForeignKeys(handle, oldId, newId);

        // 3. Delete old user row
        handle.execute("DELETE FROM users WHERE id = ?", oldId);
    }

    public static void updateForeignKeys(Handle handle, String oldId, String newId) {
        if (oldId == null || newId == null || oldId.equals(newId)) return;

        // 1. events (host_id)
        handle.execute("UPDATE events SET host_id = ? WHERE host_id = ?", newId, oldId);

        // 2. event_users (user_id) - handle composite key conflict
        handle.execute("DELETE FROM event_users WHERE user_id = ? AND event_id IN (SELECT event_id FROM event_users WHERE user_id = ?)", oldId, newId);
        handle.execute("UPDATE event_users SET user_id = ? WHERE user_id = ?", newId, oldId);

        // 3. scouting_records (scout_id)
        handle.execute("UPDATE scouting_records SET scout_id = ? WHERE scout_id = ?", newId, oldId);

        // 4. ai_settings (user_id) - handle composite key conflict
        handle.execute("DELETE FROM ai_settings WHERE user_id = ? AND provider IN (SELECT provider FROM ai_settings WHERE user_id = ?)", oldId, newId);
        handle.execute("UPDATE ai_settings SET user_id = ? WHERE user_id = ?", newId, oldId);

        // 5. ai_chat_sessions (user_id) - handle composite key conflict
        handle.execute("DELETE FROM ai_chat_sessions WHERE user_id = ? AND event_id IN (SELECT event_id FROM ai_chat_sessions WHERE user_id = ?)", oldId, newId);
        handle.execute("UPDATE ai_chat_sessions SET user_id = ? WHERE user_id = ?", newId, oldId);

        // 6. team_tags (created_by)
        handle.execute("UPDATE team_tags SET created_by = ? WHERE created_by = ?", newId, oldId);
    }
}
