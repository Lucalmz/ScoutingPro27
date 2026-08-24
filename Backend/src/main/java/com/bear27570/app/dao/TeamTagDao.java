package com.bear27570.app.dao;

import com.bear27570.app.model.TeamTag;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(TeamTag.class)
public interface TeamTagDao {

    @SqlQuery("SELECT * FROM team_tags WHERE event_id = :eventId ORDER BY created_at ASC")
    List<TeamTag> findByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM team_tags WHERE event_id = :eventId AND team_number = :teamNumber ORDER BY created_at ASC")
    List<TeamTag> findByEventAndTeam(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlQuery("SELECT * FROM team_tags WHERE event_id = :eventId AND team_number = :teamNumber AND tag = :tag")
    TeamTag findSpecific(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber, @Bind("tag") String tag);

    @SqlQuery("SELECT COUNT(*) FROM team_tags WHERE event_id = :eventId AND team_number = :teamNumber")
    int countByEventAndTeam(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlUpdate("MERGE INTO team_tags (id, event_id, team_number, tag, color, is_preset, created_by, updated_at) " +
               "KEY (event_id, team_number, tag) " +
               "VALUES (:id, :eventId, :teamNumber, :tag, :color, :isPreset, :createdBy, CURRENT_TIMESTAMP)")
    void upsert(@BindBean TeamTag tag);

    @SqlUpdate("DELETE FROM team_tags WHERE event_id = :eventId AND team_number = :teamNumber AND tag = :tag")
    int delete(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber, @Bind("tag") String tag);
}
