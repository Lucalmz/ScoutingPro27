package com.bear27570.app.dao;

import com.bear27570.app.model.ScoutingRecord;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(ScoutingRecord.class)
public interface RecordDao {

    @SqlUpdate("""
        MERGE INTO scouting_records (
            id, event_id, scout_id, scout_name,
            match_number, team_number,
            auto_score, teleop_score, endgame_score, total_score,
            notes, raw_data, sync_status, is_broken,
            created_at, updated_at
        ) KEY(id) VALUES (
            :id, :eventId, :scoutId, :scoutName,
            :matchNumber, :teamNumber,
            :autoScore, :teleopScore, :endgameScore, :totalScore,
            :notes, :rawData, :syncStatus, :isBroken,
            COALESCE((SELECT created_at FROM scouting_records WHERE id = :id), COALESCE(:createdAt, CURRENT_TIMESTAMP)), COALESCE(:updatedAt, CURRENT_TIMESTAMP)
        )
    """)
    void upsert(@BindBean ScoutingRecord record);

    @SqlQuery("SELECT * FROM scouting_records WHERE event_id = :eventId ORDER BY match_number")
    List<ScoutingRecord> findByEventId(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM scouting_records WHERE sync_status = 'PENDING' AND event_id = :eventId")
    List<ScoutingRecord> findPendingByEventId(@Bind("eventId") String eventId);

    @SqlUpdate("UPDATE scouting_records SET sync_status = 'SYNCED' WHERE id = :id AND scout_id = :userId")
    void markSynced(@Bind("id") String id, @Bind("userId") String userId);
}
