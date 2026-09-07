package com.bear27570.app.dao;

import com.bear27570.app.model.OfficialTeam;
import com.bear27570.app.model.PitScoutingRecord;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(PitScoutingRecord.class)
@RegisterBeanMapper(OfficialTeam.class)
public interface PitScoutDao {

    // --- Pit Scouting Records ---

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId AND is_deleted = FALSE ORDER BY team_number ASC")
    List<PitScoutingRecord> findActivePitRecordsByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId ORDER BY team_number ASC")
    List<PitScoutingRecord> findAllPitRecordsByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM pit_scouting_records WHERE event_id = :eventId AND team_number = :teamNumber")
    PitScoutingRecord findPitRecordByTeam(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlUpdate("MERGE INTO pit_scouting_records (" +
            "id, event_id, team_number, scout_id, scout_name, robot_name, " +
            "drivetrain_type, weight_lbs, sizing_passed, mechanism_type, hang_type, odometry_type, " +
            "claimed_auto_score, claimed_auto_pieces, claimed_auto_hang_level, " +
            "claimed_teleop_score, claimed_teleop_cycle_sec, " +
            "claimed_endgame_hang_level, claimed_endgame_time_sec, " +
            "claimed_total_score, photo_keys, version, host_seq, is_deleted, created_at, updated_at" +
            ") KEY(event_id, team_number) VALUES (" +
            ":id, :eventId, :teamNumber, :scoutId, :scoutName, :robotName, " +
            ":drivetrainType, :weightLbs, :sizingPassed, :mechanismType, :hangType, :odometryType, " +
            ":claimedAutoScore, :claimedAutoPieces, :claimedAutoHangLevel, " +
            ":claimedTeleopScore, :claimedTeleopCycleSec, " +
            ":claimedEndgameHangLevel, :claimedEndgameTimeSec, " +
            ":claimedTotalScore, :photoKeys, :version, :hostSeq, :isDeleted, " +
            "COALESCE((SELECT created_at FROM pit_scouting_records WHERE event_id = :eventId AND team_number = :teamNumber), CURRENT_TIMESTAMP), " +
            "CURRENT_TIMESTAMP)")
    void upsertPitRecord(@BindBean PitScoutingRecord record);

    @SqlUpdate("UPDATE pit_scouting_records SET is_deleted = TRUE, updated_at = CURRENT_TIMESTAMP WHERE event_id = :eventId AND team_number = :teamNumber")
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
