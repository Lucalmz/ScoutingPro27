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

    @SqlUpdate("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (:eventId, :userId)")
    void joinEvent(@Bind("eventId") String eventId, @Bind("userId") String userId);

    @SqlQuery("SELECT DISTINCT e.* FROM events e LEFT JOIN event_users eu ON e.id = eu.event_id WHERE e.host_id = :userId OR eu.user_id = :userId")
    List<ScoutingEvent> findForUser(@Bind("userId") String userId);

    @SqlQuery("SELECT * FROM events WHERE id = :id")
    ScoutingEvent findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM events WHERE invite_code = :code")
    ScoutingEvent findByInviteCode(@Bind("code") String code);

    @SqlQuery("SELECT COUNT(*) > 0 FROM events e LEFT JOIN event_users eu ON e.id = eu.event_id WHERE e.id = :eventId AND (e.host_id = :userId OR eu.user_id = :userId)")
    boolean isMember(@Bind("eventId") String eventId, @Bind("userId") String userId);

    @SqlQuery("SELECT COUNT(*) > 0 FROM events WHERE id = :eventId AND host_id = :userId")
    boolean isHost(@Bind("eventId") String eventId, @Bind("userId") String userId);

    @SqlUpdate("DELETE FROM events WHERE id = :id")
    void delete(@Bind("id") String id);

    @SqlQuery("""
        SELECT DISTINCT u.id, u.username, (CASE WHEN e.host_id = u.id THEN TRUE ELSE FALSE END) AS host
        FROM events e
        JOIN users u ON (e.host_id = u.id OR u.id IN (SELECT eu.user_id FROM event_users eu WHERE eu.event_id = e.id))
        WHERE e.id = :eventId
        ORDER BY host DESC, u.username ASC
    """)
    @RegisterBeanMapper(com.bear27570.app.model.EventMember.class)
    List<com.bear27570.app.model.EventMember> findMembersByEvent(@Bind("eventId") String eventId);
}

