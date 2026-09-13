package com.bear27570.app.dao;

import com.bear27570.app.model.OfficialTeam;
import com.bear27570.app.model.PitScoutingRecord;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

import org.jdbi.v3.sqlobject.config.RegisterArgumentFactory;
import org.jdbi.v3.sqlobject.config.RegisterColumnMapper;
import com.bear27570.app.db.StringListColumnMapper;
import com.bear27570.app.db.StringListArgumentFactory;

@RegisterBeanMapper(PitScoutingRecord.class)
@RegisterBeanMapper(OfficialTeam.class)
@RegisterColumnMapper(StringListColumnMapper.class)
@RegisterArgumentFactory(StringListArgumentFactory.class)
public interface PitScoutDao {

    // --- Pit Scouting Records ---

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId AND is_deleted = FALSE ORDER BY team_number ASC")
    List<PitScoutingRecord> findActivePitRecordsByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId ORDER BY team_number ASC")
    List<PitScoutingRecord> findAllPitRecordsByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId AND team_number = :teamNumber")
    PitScoutingRecord findPitRecordByTeam(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlUpdate("""
        MERGE INTO pit_scouting_records AS target
        USING (VALUES (
            :id, :eventId, :teamNumber, :scoutId, :scoutName, :robotName,
            :drivetrainType, :weightLbs, :odometryType,
            :ballCompatibility, :launcherType, :flowerMechanism, :hasColorSensor,
            :claimedAutoStrategy, :claimedAutoScore, :claimedTeleopCycles, :claimedTeleopScore,
            :claimedEndgameScore, :claimedTotalScore,
            :photoKeys, :version, :hostSeq, :isDeleted,
            COALESCE(NULLIF(TRIM(:createdAt), ''), CURRENT_TIMESTAMP),
            CASE 
                WHEN NULLIF(TRIM(:updatedAt), '') IS NOT NULL AND NULLIF(TRIM(:updatedAt), '') > DATEADD('SECOND', 5, CURRENT_TIMESTAMP) THEN CURRENT_TIMESTAMP
                ELSE COALESCE(NULLIF(TRIM(:updatedAt), ''), CURRENT_TIMESTAMP)
            END
        )) AS src (
            id, event_id, team_number, scout_id, scout_name, robot_name,
            drivetrain_type, weight_lbs, odometry_type,
            ball_compatibility, launcher_type, flower_mechanism, has_color_sensor,
            claimed_auto_strategy, claimed_auto_score, claimed_teleop_cycles, claimed_teleop_score,
            claimed_endgame_score, claimed_total_score,
            photo_keys, version, host_seq, is_deleted,
            created_at, updated_at
        )
        ON target.event_id = src.event_id AND target.team_number = src.team_number
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
            id                          = src.id,
            scout_id                    = src.scout_id,
            scout_name                  = src.scout_name,
            robot_name                  = src.robot_name,
            drivetrain_type             = src.drivetrain_type,
            weight_lbs                  = src.weight_lbs,
            odometry_type               = src.odometry_type,
            ball_compatibility          = src.ball_compatibility,
            launcher_type               = src.launcher_type,
            flower_mechanism            = src.flower_mechanism,
            has_color_sensor            = src.has_color_sensor,
            claimed_auto_strategy       = src.claimed_auto_strategy,
            claimed_auto_score          = src.claimed_auto_score,
            claimed_teleop_cycles       = src.claimed_teleop_cycles,
            claimed_teleop_score        = src.claimed_teleop_score,
            claimed_endgame_score       = src.claimed_endgame_score,
            claimed_total_score         = src.claimed_total_score,
            photo_keys                  = src.photo_keys,
            version                     = src.version,
            host_seq                    = CASE
                WHEN src.host_seq IS NULL THEN target.host_seq
                ELSE GREATEST(COALESCE(target.host_seq, 0), src.host_seq)
            END,
            is_deleted                  = src.is_deleted,
            updated_at                  = src.updated_at
        WHEN NOT MATCHED THEN
          INSERT (
            id, event_id, team_number, scout_id, scout_name, robot_name,
            drivetrain_type, weight_lbs, odometry_type,
            ball_compatibility, launcher_type, flower_mechanism, has_color_sensor,
            claimed_auto_strategy, claimed_auto_score, claimed_teleop_cycles, claimed_teleop_score,
            claimed_endgame_score, claimed_total_score,
            photo_keys, version, host_seq, is_deleted,
            created_at, updated_at
          ) VALUES (
            src.id, src.event_id, src.team_number, src.scout_id, src.scout_name, src.robot_name,
            src.drivetrain_type, src.weight_lbs, src.odometry_type,
            src.ball_compatibility, src.launcher_type, src.flower_mechanism, src.has_color_sensor,
            src.claimed_auto_strategy, src.claimed_auto_score, src.claimed_teleop_cycles, src.claimed_teleop_score,
            src.claimed_endgame_score, src.claimed_total_score,
            src.photo_keys, src.version, src.host_seq, src.is_deleted,
            src.created_at, src.updated_at
          )
    """)
    void upsertPitRecord(@BindBean PitScoutingRecord record);

    @SqlUpdate("UPDATE pit_scouting_records SET is_deleted = TRUE, version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP WHERE event_id = :eventId AND team_number = :teamNumber")
    int softDeletePitRecord(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlUpdate("DELETE FROM pit_scouting_records WHERE event_id = :eventId")
    int clearPitRecordsByEvent(@Bind("eventId") String eventId);

    // --- Official Teams Cache ---

    @SqlQuery("SELECT * FROM event_official_teams WHERE event_id = :eventId ORDER BY team_number ASC")
    List<OfficialTeam> findOfficialTeamsByEvent(@Bind("eventId") String eventId);

    @SqlUpdate("MERGE INTO event_official_teams (" +
            "event_id, team_number, name_full, robot_name, city, country, updated_at" +
            ") KEY(event_id, team_number) VALUES (" +
            ":eventId, :teamNumber, :nameFull, :robotName, :city, :country, CURRENT_TIMESTAMP)")
    void upsertOfficialTeam(@BindBean OfficialTeam team);

    @SqlUpdate("DELETE FROM event_official_teams WHERE event_id = :eventId")
    int clearOfficialTeamsByEvent(@Bind("eventId") String eventId);
}
