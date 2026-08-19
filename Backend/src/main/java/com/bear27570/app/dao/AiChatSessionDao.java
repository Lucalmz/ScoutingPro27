package com.bear27570.app.dao;

import com.bear27570.app.model.AiChatSession;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

public interface AiChatSessionDao {
    
    @SqlQuery("SELECT * FROM ai_chat_sessions WHERE user_id = :userId AND event_id = :eventId")
    @RegisterBeanMapper(AiChatSession.class)
    AiChatSession findSession(@Bind("userId") String userId, @Bind("eventId") String eventId);

    @SqlUpdate("MERGE INTO ai_chat_sessions (user_id, event_id, chat_history_json, updated_at) " +
               "KEY (user_id, event_id) " +
               "VALUES (:userId, :eventId, :chatHistoryJson, CURRENT_TIMESTAMP)")
    void saveSession(@BindBean AiChatSession session);
}
