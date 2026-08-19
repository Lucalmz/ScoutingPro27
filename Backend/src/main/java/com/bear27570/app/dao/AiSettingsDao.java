package com.bear27570.app.dao;

import com.bear27570.app.model.AiSettings;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(AiSettings.class)
public interface AiSettingsDao {

    @SqlQuery("SELECT * FROM ai_settings WHERE user_id = :userId")
    List<AiSettings> findByUserId(@Bind("userId") String userId);

    @SqlQuery("SELECT * FROM ai_settings WHERE user_id = :userId AND provider = :provider")
    AiSettings findByUserIdAndProvider(@Bind("userId") String userId, @Bind("provider") String provider);

    @SqlUpdate("MERGE INTO ai_settings (user_id, provider, api_key_encrypted, model_name, system_prompt, proxy_host, proxy_port, base_url, updated_at) " +
               "KEY(user_id, provider) " +
               "VALUES (:userId, :provider, :apiKeyEncrypted, :modelName, :systemPrompt, :proxyHost, :proxyPort, :baseUrl, CURRENT_TIMESTAMP)")
    void upsert(@BindBean AiSettings settings);
    
    @SqlUpdate("DELETE FROM ai_settings WHERE user_id = :userId AND provider = :provider")
    void delete(@Bind("userId") String userId, @Bind("provider") String provider);
}
