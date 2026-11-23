package com.bear27570.app.dao;

import com.bear27570.app.model.AiChatThread;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(AiChatThread.class)
public interface AiChatThreadDao {

    @SqlQuery("SELECT * FROM ai_chat_threads WHERE user_id = :userId AND event_id = :eventId ORDER BY pinned DESC, updated_at DESC")
    List<AiChatThread> findByUserAndEvent(@Bind("userId") String userId, @Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM ai_chat_threads WHERE id = :id AND user_id = :userId")
    AiChatThread findByIdAndUser(@Bind("id") String id, @Bind("userId") String userId);

    @SqlQuery("SELECT * FROM ai_chat_threads WHERE id = :id AND user_id = :userId AND event_id = :eventId")
    AiChatThread findByIdUserAndEvent(@Bind("id") String id, @Bind("userId") String userId, @Bind("eventId") String eventId);

    @SqlUpdate("MERGE INTO ai_chat_threads " +
               "(id, user_id, event_id, title, persona_id, pinned, messages_json, context_config_json, created_at, updated_at) " +
               "KEY(id) " +
               "VALUES (:id, :userId, :eventId, :title, :personaId, :pinned, :messagesJson, :contextConfigJson, " +
               "COALESCE((SELECT created_at FROM ai_chat_threads WHERE id = :id), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)")
    void upsert(@BindBean AiChatThread thread);

    @SqlUpdate("DELETE FROM ai_chat_threads WHERE id = :id AND user_id = :userId")
    int deleteByIdAndUser(@Bind("id") String id, @Bind("userId") String userId);
}
