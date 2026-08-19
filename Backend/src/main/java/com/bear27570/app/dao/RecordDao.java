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
        MERGE INTO scouting_records AS target
        USING (VALUES (
            :id, :eventId, :scoutId, :scoutName,
            :matchNumber, :teamNumber,
            :autoScore, :teleopScore, :endgameScore, :totalScore,
            :notes, :rawData, :syncStatus, :isBroken, :isDeleted,
            COALESCE(:createdAt, CURRENT_TIMESTAMP),
            CASE 
                WHEN :updatedAt > DATEADD('SECOND', 5, CURRENT_TIMESTAMP) THEN CURRENT_TIMESTAMP
                ELSE COALESCE(:updatedAt, CURRENT_TIMESTAMP)
            END,
            :version, :hostSeq
        )) AS src (
            id, event_id, scout_id, scout_name,
            match_number, team_number,
            auto_score, teleop_score, endgame_score, total_score,
            notes, raw_data, sync_status, is_broken, is_deleted,
            created_at, updated_at,
            version, host_seq
        )
        ON target.id = src.id
        WHEN MATCHED AND (
            src.version > COALESCE(target.version, 0)
            OR (
                src.version = COALESCE(target.version, 0) 
                AND (
                    src.updated_at > COALESCE(target.updated_at, '1970-01-01 00:00:00')
                    OR (
                        src.updated_at = COALESCE(target.updated_at, '1970-01-01 00:00:00')
                        AND src.scout_id >= COALESCE(target.scout_id, '')
                    )
                )
            )
        ) THEN
          UPDATE SET
            event_id      = src.event_id,
            scout_id      = src.scout_id,
            scout_name    = src.scout_name,
            match_number  = src.match_number,
            team_number   = src.team_number,
            auto_score    = src.auto_score,
            teleop_score  = src.teleop_score,
            endgame_score = src.endgame_score,
            total_score   = src.total_score,
            notes         = src.notes,
            raw_data      = src.raw_data,
            sync_status   = src.sync_status,
            is_broken     = src.is_broken,
            is_deleted    = src.is_deleted,
            updated_at    = src.updated_at,
            version       = src.version,
            host_seq      = CASE
                WHEN src.host_seq IS NULL THEN target.host_seq
                ELSE GREATEST(COALESCE(target.host_seq, 0), src.host_seq)
            END
        WHEN NOT MATCHED THEN
          INSERT (
            id, event_id, scout_id, scout_name,
            match_number, team_number,
            auto_score, teleop_score, endgame_score, total_score,
            notes, raw_data, sync_status, is_broken, is_deleted,
            created_at, updated_at,
            version, host_seq
          ) VALUES (
            src.id, src.event_id, src.scout_id, src.scout_name,
            src.match_number, src.team_number,
            src.auto_score, src.teleop_score, src.endgame_score, src.total_score,
            src.notes, src.raw_data, src.sync_status, src.is_broken, src.is_deleted,
            src.created_at, src.updated_at,
            src.version, src.host_seq
          )
    """)
    void upsert(@BindBean ScoutingRecord record);

    @SqlQuery("SELECT * FROM scouting_records WHERE id = :id")
    ScoutingRecord findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM scouting_records WHERE event_id = :eventId ORDER BY match_number")
    List<ScoutingRecord> findByEventId(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM scouting_records WHERE sync_status = 'PENDING' AND event_id = :eventId")
    List<ScoutingRecord> findPendingByEventId(@Bind("eventId") String eventId);

    @SqlUpdate("UPDATE scouting_records SET sync_status = 'SYNCED' WHERE id = :id AND scout_id = :userId")
    void markSynced(@Bind("id") String id, @Bind("userId") String userId);

    @SqlUpdate("DELETE FROM scouting_records WHERE is_deleted = TRUE AND updated_at < DATEADD('DAY', -14, CURRENT_TIMESTAMP)")
    int purgeExpiredTombstones();
}
