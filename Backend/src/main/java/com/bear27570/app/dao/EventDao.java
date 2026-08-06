package com.bear27570.app.dao;

import com.bear27570.app.model.ScoutingEvent;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(ScoutingEvent.class)
public interface EventDao {

    @SqlUpdate("INSERT INTO events (id, name, invite_code, host_id, ftc_year, ftc_event_code) VALUES (:id, :name, :inviteCode, :hostId, :ftcYear, :ftcEventCode)")
    void insert(@BindBean ScoutingEvent event);

    @SqlUpdate("UPDATE events SET ftc_year = :year, ftc_event_code = :code WHERE id = :id")
    void updateFtcConfig(@Bind("id") String id, @Bind("year") Integer year, @Bind("code") String code);

    @SqlUpdate("INSERT INTO event_users (event_id, user_id) VALUES (:eventId, :userId)")
    void joinEvent(@Bind("eventId") String eventId, @Bind("userId") String userId);

    @SqlQuery("SELECT DISTINCT e.* FROM events e LEFT JOIN event_users eu ON e.id = eu.event_id WHERE e.host_id = :userId OR eu.user_id = :userId")
    List<ScoutingEvent> findForUser(@Bind("userId") String userId);

    @SqlQuery("SELECT * FROM events WHERE id = :id")
    ScoutingEvent findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM events WHERE invite_code = :code")
    ScoutingEvent findByInviteCode(@Bind("code") String code);
}
