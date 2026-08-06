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

    @SqlUpdate("INSERT INTO events (id, name, invite_code, is_host) VALUES (:id, :name, :inviteCode, :isHost)")
    void insert(@BindBean ScoutingEvent event);

    @SqlQuery("SELECT * FROM events")
    List<ScoutingEvent> findAll();

    @SqlQuery("SELECT * FROM events WHERE id = :id")
    ScoutingEvent findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM events WHERE invite_code = :code")
    ScoutingEvent findByInviteCode(@Bind("code") String code);
}
