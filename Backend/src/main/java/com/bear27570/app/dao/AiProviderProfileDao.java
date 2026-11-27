package com.bear27570.app.dao;

import com.bear27570.app.model.AiProviderProfile;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(AiProviderProfile.class)
public interface AiProviderProfileDao {

    @SqlQuery("SELECT * FROM ai_provider_profiles WHERE user_id = :userId ORDER BY is_active DESC, updated_at DESC, created_at ASC")
    List<AiProviderProfile> findByUserId(@Bind("userId") String userId);

    @SqlQuery("SELECT * FROM ai_provider_profiles WHERE id = :id")
    AiProviderProfile findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM ai_provider_profiles WHERE id = :id AND user_id = :userId")
    AiProviderProfile findByIdAndUserId(@Bind("id") String id, @Bind("userId") String userId);

    @SqlQuery("SELECT * FROM ai_provider_profiles WHERE user_id = :userId AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1")
    AiProviderProfile findActiveByUserId(@Bind("userId") String userId);

    @SqlUpdate("INSERT INTO ai_provider_profiles " +
               "(id, user_id, name, preset_id, protocol, api_key_encrypted, base_url, model_name, custom_models_json, " +
               "system_prompt, temperature, max_tokens, enable_thinking, thinking_budget, anthropic_version, max_context_msgs, " +
               "proxy_host, proxy_port, is_active, created_at, updated_at) " +
               "VALUES (:id, :userId, :name, :presetId, :protocol, :apiKeyEncrypted, :baseUrl, :modelName, :customModelsJson, " +
               ":systemPrompt, :temperature, :maxTokens, :enableThinking, :thinkingBudget, :anthropicVersion, :maxContextMsgs, " +
               ":proxyHost, :proxyPort, :isActive, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
    void insert(@BindBean AiProviderProfile profile);

    @SqlUpdate("UPDATE ai_provider_profiles SET " +
               "name = :name, preset_id = :presetId, protocol = :protocol, api_key_encrypted = :apiKeyEncrypted, " +
               "base_url = :baseUrl, model_name = :modelName, custom_models_json = :customModelsJson, " +
               "system_prompt = :systemPrompt, temperature = :temperature, max_tokens = :maxTokens, " +
               "enable_thinking = :enableThinking, thinking_budget = :thinkingBudget, " +
               "anthropic_version = :anthropicVersion, max_context_msgs = :maxContextMsgs, " +
               "proxy_host = :proxyHost, proxy_port = :proxyPort, is_active = :isActive, updated_at = CURRENT_TIMESTAMP " +
               "WHERE id = :id AND user_id = :userId")
    int updateScoped(@BindBean AiProviderProfile profile);

    @SqlUpdate("UPDATE ai_provider_profiles SET is_active = FALSE WHERE user_id = :userId AND is_active = TRUE")
    void clearActiveForUser(@Bind("userId") String userId);

    @SqlUpdate("UPDATE ai_provider_profiles SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND user_id = :userId")
    int setActive(@Bind("id") String id, @Bind("userId") String userId);

    @SqlUpdate("DELETE FROM ai_provider_profiles WHERE id = :id AND user_id = :userId")
    int deleteByIdAndUserId(@Bind("id") String id, @Bind("userId") String userId);
}
