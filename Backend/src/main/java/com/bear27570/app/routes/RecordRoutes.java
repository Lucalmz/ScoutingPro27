package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.RecordDao;
import com.bear27570.app.dao.UserDao;
import com.bear27570.app.db.UserDeterministicIdMigrator;
import com.bear27570.app.model.ScoutingRecord;
import com.bear27570.app.model.User;
import com.bear27570.app.util.DbUtil;
import com.bear27570.app.util.EcdsaRecordVerifier;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;

import java.lang.reflect.Type;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class RecordRoutes {

    private static final Object RECORD_WRITE_LOCK = DbUtil.RECORD_WRITE_LOCK;

    private final Jdbi jdbi;
    private final Gson gson;

    public RecordRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/records", ctx -> {
            String eventId = ctx.queryParam("eventId");
            if (eventId == null || eventId.isBlank()) {
                ctx.status(400).result("eventId required");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        routes.post("/api/records", ctx -> {
            try {
                ScoutingRecord record = gson.fromJson(ctx.body(), ScoutingRecord.class);
                if (record == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                if (record.getMatchNumber() <= 0 || record.getTeamNumber() <= 0) {
                    ctx.status(400).result("Invalid matchNumber or teamNumber");
                    return;
                }
                if (record.getEventId() == null || record.getEventId().isBlank()) {
                    ctx.status(400).result("Event ID cannot be blank");
                    return;
                }
                String userId = ctx.attribute("userId");
                
                synchronized (RECORD_WRITE_LOCK) {
                    DbUtil.withDeadlockRetry(() -> {
                        jdbi.useTransaction(handle -> {
                            EventDao eventDao = handle.attach(EventDao.class);
                            RecordDao recordDao = handle.attach(RecordDao.class);
                            UserDao userDao = handle.attach(UserDao.class);
                            
                            if (!eventDao.isMember(record.getEventId(), userId)) {
                                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
                            }
                            
                            boolean isHost = eventDao.isHost(record.getEventId(), userId);
                            ScoutingRecord existing = recordDao.findById(record.getId());
                            if (existing != null && !Objects.equals(existing.getEventId(), record.getEventId())) {
                                throw new io.javalin.http.ForbiddenResponse("Record belongs to another event");
                            }
                            if (existing == null) {
                                // New record: forcefully bind scoutId to authenticated user
                                if (!isHost || record.getScoutId() == null || record.getScoutId().isBlank()) {
                                    record.setScoutId(userId);
                                }
                                if (record.getScoutName() == null || record.getScoutName().isBlank()) {
                                    record.setScoutName(userId);
                                }
                            } else {
                                // Existing record: only original author or event host can update
                                if (!Objects.equals(existing.getScoutId(), userId) && !isHost) {
                                    throw new io.javalin.http.ForbiddenResponse("Cannot modify another scout's record");
                                }
                                if (!isHost) {
                                    // Non-host author cannot transfer record ownership to someone else
                                    record.setScoutId(userId);
                                } else if (record.getScoutId() == null || record.getScoutId().isBlank()) {
                                    record.setScoutId(existing.getScoutId());
                                }
                                if (record.getScoutName() == null || record.getScoutName().isBlank()) {
                                    record.setScoutName(existing.getScoutName() != null ? existing.getScoutName() : (record.getScoutId() != null ? record.getScoutId() : userId));
                                }
                            }
                            
                            if (record.getScoutId() != null && !record.getScoutId().isBlank()) {
                                userDao.ensureScoutUserPlaceholder(record.getScoutId(), record.getScoutName());
                                eventDao.joinEvent(record.getEventId(), record.getScoutId());
                            }
                            
                            recordDao.upsert(record);
                        });
                    });
                }
                ctx.status(200).result("OK");
            } catch (io.javalin.http.HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                ctx.status(400).result("Invalid data: " + e.getMessage());
            }
        });

        routes.post("/api/records/sync", ctx -> {
            try {
                Type t = new TypeToken<List<ScoutingRecord>>() {}.getType();
                List<ScoutingRecord> records = gson.fromJson(ctx.body(), t);
                if (records == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                String userId = ctx.attribute("userId");
                
                // Deterministically sort records by ID to enforce canonical lock ordering and eliminate deadlock
                records.sort(Comparator.comparing(r -> r.getId() != null ? r.getId() : ""));

                synchronized (RECORD_WRITE_LOCK) {
                    DbUtil.withDeadlockRetry(() -> {
                        // Wrap in a transaction to prevent partial failure corruption
                        jdbi.useTransaction(handle -> {
                            EventDao eventDao = handle.attach(EventDao.class);
                            RecordDao recordDao = handle.attach(RecordDao.class);
                            UserDao userDao = handle.attach(UserDao.class);
                            
                            for (ScoutingRecord r : records) {
                                if (r.getMatchNumber() <= 0 || r.getTeamNumber() <= 0 || r.getEventId() == null || r.getEventId().isBlank()) {
                                    throw new IllegalArgumentException("Invalid record detected in batch sync");
                                }
                                if (!eventDao.isMember(r.getEventId(), userId)) {
                                    throw new io.javalin.http.ForbiddenResponse("Not a member of event: " + r.getEventId());
                                }
                                
                                boolean isHost = eventDao.isHost(r.getEventId(), userId);
                                ScoutingRecord existing = recordDao.findById(r.getId());
                                if (existing != null && !Objects.equals(existing.getEventId(), r.getEventId())) {
                                    throw new io.javalin.http.ForbiddenResponse("Record belongs to another event");
                                }
                                
                                boolean isCryptographicallySignedPeerRecord = EcdsaRecordVerifier.verifyScoutingRecord(r);
                                if (!isHost && !isCryptographicallySignedPeerRecord) {
                                    // Ordinary scouts can only sync their own unsigned/local records
                                    if (r.getScoutId() == null || r.getScoutId().isBlank()) {
                                        r.setScoutId(userId);
                                    } else if (!Objects.equals(r.getScoutId(), userId)) {
                                        throw new io.javalin.http.ForbiddenResponse("Cannot sync records belonging to another scout");
                                    }
                                    
                                    if (existing != null && !Objects.equals(existing.getScoutId(), userId)) {
                                        throw new io.javalin.http.ForbiddenResponse("Cannot modify another scout's record");
                                    }
                                } else if (!isHost) {
                                    // Non-host ordinary scout relaying or updating a cryptographically signed record:
                                    // enforce author immutability and ECDSA public-key-to-scout binding
                                    com.bear27570.app.model.ScoutingEvent evt = eventDao.findById(r.getEventId());
                                    String eventHostId = evt != null ? evt.getHostId() : null;
                                    EcdsaRecordVerifier.AuthResult auth = EcdsaRecordVerifier.verifyNonHostPeerRecordAuthorization(
                                            handle, r.getEventId(), eventHostId, userId, r, existing);
                                    if (!auth.allowed()) {
                                        throw new io.javalin.http.ForbiddenResponse(auth.rejectReason());
                                    }
                                } else {
                                    // Host is authorized to alter author (e.g. account merge/migration)
                                    if (existing != null && (r.getScoutId() == null || r.getScoutId().isBlank())) {
                                        r.setScoutId(existing.getScoutId());
                                    }
                                }
                                
                                if (r.getScoutName() == null || r.getScoutName().isBlank()) {
                                    r.setScoutName(existing != null && existing.getScoutName() != null ? existing.getScoutName() : (r.getScoutId() != null ? r.getScoutId() : userId));
                                }
                                
                                // Foreign key safety: Ensure scout user placeholder exists in Host DB before upserting record
                                if (r.getScoutId() != null && !r.getScoutId().isBlank()) {
                                    userDao.ensureScoutUserPlaceholder(r.getScoutId(), r.getScoutName());
                                    eventDao.joinEvent(r.getEventId(), r.getScoutId());
                                }

                                r.setSyncStatus("SYNCED");
                                recordDao.upsert(r);
                            }
                        });
                    });
                }
                ctx.status(200).result("OK");
            } catch (io.javalin.http.HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                ctx.status(400).result("Sync failed: " + e.getMessage());
            }
        });

        routes.post("/api/records/migrate-scout", ctx -> {
            String callerId = ctx.attribute("userId");
            if (callerId == null || callerId.isBlank()) {
                throw new io.javalin.http.UnauthorizedResponse("Unauthorized");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null) {
                ctx.status(400).result("Invalid JSON body");
                return;
            }
            String eventId = asString(body.get("eventId"));
            String oldScoutId = asString(body.get("oldScoutId"));
            String newScoutId = asString(body.get("newScoutId"));
            String newScoutName = asString(body.get("newScoutName"));

            if (eventId == null || eventId.isBlank() || oldScoutId == null || oldScoutId.isBlank() ||
                newScoutId == null || newScoutId.isBlank() || newScoutName == null || newScoutName.isBlank()) {
                ctx.status(400).result("eventId, oldScoutId, newScoutId, and newScoutName required");
                return;
            }

            try {
                synchronized (RECORD_WRITE_LOCK) {
                    DbUtil.withDeadlockRetry(() -> {
                        jdbi.useTransaction(handle -> {
                            EventDao eventDao = handle.attach(EventDao.class);
                            UserDao userDao = handle.attach(UserDao.class);
                            if (eventDao.findById(eventId) == null) {
                                throw new io.javalin.http.NotFoundResponse("Event not found");
                            }
                            boolean isHost = eventDao.isHost(eventId, callerId);
                            boolean isSelfMigration = eventDao.isMember(eventId, callerId) && callerId.equals(oldScoutId);
                            if (!isHost && !isSelfMigration) {
                                throw new io.javalin.http.ForbiddenResponse("Only event host or the migrating scout can migrate records");
                            }

                            // Ensure new placeholder exists in Host DB
                            userDao.ensureScoutUserPlaceholder(newScoutId, newScoutName);

                            // Update all existing records for oldScoutId in this event
                            handle.execute("""
                                UPDATE scouting_records
                                SET scout_id = ?, scout_name = ?, version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP
                                WHERE event_id = ? AND scout_id = ?
                            """, newScoutId, newScoutName, eventId, oldScoutId);

                            handle.execute("""
                                UPDATE scout_assignments
                                SET scout_id = ?, scout_name = ?, updated_at = CURRENT_TIMESTAMP
                                WHERE event_id = ? AND scout_id = ?
                            """, newScoutId, newScoutName, eventId, oldScoutId);

                            handle.execute("""
                                UPDATE pit_scouting_records
                                SET scout_id = ?, scout_name = ?, version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP
                                WHERE event_id = ? AND scout_id = ?
                            """, newScoutId, newScoutName, eventId, oldScoutId);

                            // Update event memberships and tags if present
                            handle.execute("DELETE FROM event_users WHERE event_id = ? AND user_id = ?", eventId, oldScoutId);
                            handle.execute("MERGE INTO event_users (event_id, user_id) KEY(event_id, user_id) VALUES (?, ?)", eventId, newScoutId);
                            handle.execute("UPDATE team_tags SET created_by = ? WHERE event_id = ? AND created_by = ?", newScoutId, eventId, oldScoutId);

                            // Only cascade-merge placeholder accounts or caller-owned self-migrations; never delete another registered user's account
                            User oldUser = userDao.findById(oldScoutId);
                            boolean oldUserHasPassword = oldUser != null
                                    && oldUser.getPassword() != null
                                    && !oldUser.getPassword().isBlank();
                            if (oldUser != null && !oldScoutId.equals(newScoutId) && (!oldUserHasPassword || callerId.equals(oldScoutId))) {
                                UserDeterministicIdMigrator.mergeUserInto(handle, oldScoutId, newScoutId, newScoutName);
                            }
                        });
                    });
                }
                ctx.status(200).result("OK");
            } catch (io.javalin.http.HttpResponseException e) {
                throw e;
            } catch (Exception e) {
                System.err.println("Migrate scout error: " + e.getMessage());
                ctx.status(500).result("Migrate scout failed: " + e.getMessage());
            }
        });

        routes.get("/api/records/pending", ctx -> {
            String eventId = ctx.queryParam("eventId");
            if (eventId == null || eventId.isBlank()) {
                ctx.status(400).result("eventId required");
                return;
            }
            String userId = ctx.attribute("userId");
            boolean isMember = jdbi.withExtension(EventDao.class, dao -> dao.isMember(eventId, userId));
            if (!isMember) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this event");
            }
            List<ScoutingRecord> records = jdbi.withExtension(RecordDao.class,
                dao -> dao.findPendingByEventId(eventId));
            ctx.result(gson.toJson(records)).contentType("application/json");
        });

        routes.post("/api/records/mark-synced", ctx -> {
            try {
                Type t = new TypeToken<List<String>>() {}.getType();
                List<String> ids = gson.fromJson(ctx.body(), t);
                if (ids == null) {
                    ctx.status(400).result("Invalid JSON body");
                    return;
                }
                String userId = ctx.attribute("userId");
                jdbi.useExtension(RecordDao.class, dao -> {
                    for (String id : ids) {
                        dao.markSynced(id, userId);
                    }
                });
                ctx.status(200).result("OK");
            } catch (Exception e) {
                ctx.status(400).result("Invalid data");
            }
        });
    }
}
