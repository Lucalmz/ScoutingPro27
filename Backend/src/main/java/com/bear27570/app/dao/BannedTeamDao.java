package com.bear27570.app.dao;

import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

public interface BannedTeamDao {

    @SqlUpdate("MERGE INTO banned_teams (event_id, team_number) KEY(event_id, team_number) VALUES (:eventId, :teamNumber)")
    void banTeam(@Bind("eventId") String eventId, @Bind("teamNumber") int teamNumber);

    @SqlQuery("SELECT team_number FROM banned_teams WHERE event_id = :eventId")
    List<Integer> getBannedTeams(@Bind("eventId") String eventId);
}
