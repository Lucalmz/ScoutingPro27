package com.bear27570.app.routes;

import com.bear27570.app.dao.EventDao;
import com.bear27570.app.dao.TeamTagDao;
import com.bear27570.app.model.ScoutingEvent;
import com.bear27570.app.model.TeamTag;
import com.google.gson.Gson;
import io.javalin.config.RoutesConfig;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static com.bear27570.app.routes.ApiRoutes.asString;

public class TeamTagRoutes {

    private static final Logger logger = LoggerFactory.getLogger(TeamTagRoutes.class);
    private final Jdbi jdbi;
    private final Gson gson;

    public TeamTagRoutes(Jdbi jdbi, Gson gson) {
        this.jdbi = jdbi;
        this.gson = gson;
    }

    public void register(RoutesConfig routes) {
        routes.get("/api/events/{id}/tags", ctx -> {
            String eventId = ctx.pathParam("id");
            List<TeamTag> tags = jdbi.withExtension(TeamTagDao.class, dao -> dao.findByEvent(eventId));
            ctx.result(gson.toJson(tags)).contentType("application/json");
        });

        routes.post("/api/events/{id}/teams/{teamNumber}/tags", ctx -> {
            String eventId = ctx.pathParam("id");
            int teamNumber;
            try {
                teamNumber = Integer.parseInt(ctx.pathParam("teamNumber"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid teamNumber format");
                return;
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> body = gson.fromJson(ctx.body(), Map.class);
            if (body == null || body.get("tag") == null) {
                ctx.status(400).result("tag required");
                return;
            }

            String rawTag = asString(body.get("tag")).trim();
            if (rawTag.isEmpty() || rawTag.length() > 30) {
                ctx.status(400).result("Tag must be between 1 and 30 characters");
                return;
            }

            // Normalization (V26)
            String normalizedTag = rawTag;
            if (normalizedTag.matches("^[A-Za-z0-9 _#-]+$")) {
                normalizedTag = normalizedTag.toLowerCase();
            }

            // Characters whitelist (V15)
            if (normalizedTag.contains(".")) {
                ctx.status(400).result("Tags cannot contain '.'");
                return;
            }
            if (!normalizedTag.matches("^[\\p{L}\\p{N} _#-]+$")) {
                ctx.status(400).result("Tag contains invalid characters");
                return;
            }

            String rawColor = body.get("color") != null ? String.valueOf(body.get("color")).toLowerCase().trim() : "blue";
            Set<String> allowedColors = Set.of("red", "orange", "green", "blue", "purple", "gray", "yellow");
            String color = allowedColors.contains(rawColor) ? rawColor : "blue";

            String userId = ctx.attribute("userId");

            final String finalTag = normalizedTag;
            final String finalColor = color;
            final boolean finalIsPreset = false;

            TeamTag savedTag = jdbi.inTransaction(handle -> {
                EventDao eventDao = handle.attach(EventDao.class);
                ScoutingEvent event = eventDao.findById(eventId);
                if (event == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }

                TeamTagDao tagDao = handle.attach(TeamTagDao.class);

                // Limit check: <= 15 tags per team (V14)
                int currentCount = tagDao.countByEventAndTeam(eventId, teamNumber);
                TeamTag existing = tagDao.findSpecific(eventId, teamNumber, finalTag);
                if (existing == null && currentCount >= 15) {
                    throw new io.javalin.http.BadRequestResponse("Maximum 15 tags per team allowed");
                }

                String tagId = existing != null ? existing.getId() : UUID.randomUUID().toString();
                TeamTag t = new TeamTag(tagId, eventId, teamNumber, finalTag, finalColor, finalIsPreset, userId);
                tagDao.upsert(t);
                return tagDao.findSpecific(eventId, teamNumber, finalTag);
            });

            ctx.status(200).result(gson.toJson(savedTag)).contentType("application/json");
        });

        routes.delete("/api/events/{id}/teams/{teamNumber}/tags/{tag}", ctx -> {
            String eventId = ctx.pathParam("id");
            int teamNumber;
            try {
                teamNumber = Integer.parseInt(ctx.pathParam("teamNumber"));
            } catch (NumberFormatException e) {
                ctx.status(400).result("Invalid teamNumber format");
                return;
            }
            String tagValue = URLDecoder.decode(ctx.pathParam("tag"), StandardCharsets.UTF_8).trim();
            String userId = ctx.attribute("userId");

            jdbi.useTransaction(handle -> {
                EventDao eventDao = handle.attach(EventDao.class);
                ScoutingEvent event = eventDao.findById(eventId);
                if (event == null) {
                    throw new io.javalin.http.NotFoundResponse("Event not found");
                }

                TeamTagDao tagDao = handle.attach(TeamTagDao.class);
                TeamTag existing = tagDao.findSpecific(eventId, teamNumber, tagValue);

                if (existing != null) {
                    // Permission check: only tag creator or event host can delete (V30)
                    boolean isCreator = userId != null && userId.equals(existing.getCreatedBy());
                    boolean isHost = userId != null && userId.equals(event.getHostId());
                    if (!isCreator && !isHost) {
                        throw new io.javalin.http.ForbiddenResponse("Only the tag creator or event host can delete this tag");
                    }
                    logger.info("[AUDIT] Tag deleted: eventId={}, teamNumber={}, tag={}, deletedBy={}", eventId, teamNumber, tagValue, userId);
                    tagDao.delete(eventId, teamNumber, tagValue);
                }
                // If tag not found, idempotent success (V23)
            });

            ctx.status(200).result("OK");
        });
    }
}
