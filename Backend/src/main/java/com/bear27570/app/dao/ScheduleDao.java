package com.bear27570.app.dao;

import com.bear27570.app.model.MatchScheduleItem;
import com.bear27570.app.model.ScoutAssignment;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(MatchScheduleItem.class)
@RegisterBeanMapper(ScoutAssignment.class)
public interface ScheduleDao {

    // --- Match Schedules ---

    @SqlQuery("SELECT * FROM match_schedules WHERE event_id = :eventId ORDER BY CASE WHEN tournament_level = 'QUALIFICATION' THEN 1 WHEN tournament_level = 'PLAYOFF' THEN 2 ELSE 3 END ASC, match_number ASC")
    List<MatchScheduleItem> findSchedulesByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM match_schedules WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel")
    MatchScheduleItem findScheduleMatch(@Bind("eventId") String eventId, @Bind("matchNumber") int matchNumber, @Bind("tournamentLevel") String tournamentLevel);

    @SqlUpdate("MERGE INTO match_schedules (id, event_id, match_number, tournament_level, red1, red2, blue1, blue2, created_at) " +
               "KEY (event_id, match_number, tournament_level) " +
               "VALUES (:id, :eventId, :matchNumber, :tournamentLevel, :red1, :red2, :blue1, :blue2, CURRENT_TIMESTAMP)")
    void upsertSchedule(@BindBean MatchScheduleItem item);

    @SqlUpdate("DELETE FROM match_schedules WHERE event_id = :eventId")
    int clearSchedulesByEvent(@Bind("eventId") String eventId);

    @SqlUpdate("DELETE FROM match_schedules WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel")
    int deleteScheduleMatch(@Bind("eventId") String eventId, @Bind("matchNumber") int matchNumber, @Bind("tournamentLevel") String tournamentLevel);

    // --- Scout Assignments ---

    @SqlQuery("SELECT * FROM scout_assignments WHERE event_id = :eventId ORDER BY CASE WHEN tournament_level = 'QUALIFICATION' THEN 1 WHEN tournament_level = 'PLAYOFF' THEN 2 ELSE 3 END ASC, match_number ASC, station ASC")
    List<ScoutAssignment> findAssignmentsByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM scout_assignments WHERE event_id = :eventId AND scout_id = :scoutId ORDER BY CASE WHEN tournament_level = 'QUALIFICATION' THEN 1 WHEN tournament_level = 'PLAYOFF' THEN 2 ELSE 3 END ASC, match_number ASC")
    List<ScoutAssignment> findAssignmentsByScout(@Bind("eventId") String eventId, @Bind("scoutId") String scoutId);

    @SqlQuery("SELECT * FROM scout_assignments WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel AND station = :station")
    ScoutAssignment findAssignment(@Bind("eventId") String eventId, @Bind("matchNumber") int matchNumber, @Bind("tournamentLevel") String tournamentLevel, @Bind("station") String station);

    @SqlUpdate("MERGE INTO scout_assignments (id, event_id, match_number, tournament_level, station, team_number, scout_id, scout_name, updated_at) " +
               "KEY (event_id, match_number, tournament_level, station) " +
               "VALUES (:id, :eventId, :matchNumber, :tournamentLevel, :station, :teamNumber, :scoutId, :scoutName, CURRENT_TIMESTAMP)")
    void upsertAssignment(@BindBean ScoutAssignment assignment);

    @SqlUpdate("DELETE FROM scout_assignments WHERE event_id = :eventId")
    int clearAssignmentsByEvent(@Bind("eventId") String eventId);

    @SqlUpdate("DELETE FROM scout_assignments WHERE event_id = :eventId AND match_number = :matchNumber AND tournament_level = :tournamentLevel")
    int deleteAssignmentsByMatch(@Bind("eventId") String eventId, @Bind("matchNumber") int matchNumber, @Bind("tournamentLevel") String tournamentLevel);
}
