package com.bear27570.app.dao;

import com.bear27570.app.model.CustomFieldDefinition;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterBeanMapper(CustomFieldDefinition.class)
public interface CustomFieldDao {

    @SqlQuery("SELECT * FROM event_custom_fields WHERE event_id = :eventId ORDER BY order_seq ASC, created_at ASC")
    List<CustomFieldDefinition> findByEvent(@Bind("eventId") String eventId);

    @SqlQuery("SELECT * FROM event_custom_fields WHERE event_id = :eventId AND target = :target AND is_active = TRUE ORDER BY order_seq ASC, created_at ASC")
    List<CustomFieldDefinition> findActiveByEventAndTarget(@Bind("eventId") String eventId, @Bind("target") String target);

    @SqlQuery("SELECT * FROM event_custom_fields WHERE id = :id")
    CustomFieldDefinition findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM event_custom_fields WHERE event_id = :eventId AND target = :target AND field_key = :fieldKey")
    CustomFieldDefinition findByKey(@Bind("eventId") String eventId, @Bind("target") String target, @Bind("fieldKey") String fieldKey);

    @SqlQuery("SELECT COALESCE(MAX(order_seq), 0) FROM event_custom_fields WHERE event_id = :eventId AND target = :target")
    int getMaxOrderSeq(@Bind("eventId") String eventId, @Bind("target") String target);

    @SqlUpdate("""
        INSERT INTO event_custom_fields (
            id, event_id, target, phase, name, field_key, field_type,
            required, default_val, options_json, min_val, max_val, step_val,
            unit, order_seq, is_active, created_at, updated_at
        ) VALUES (
            :id, :eventId, :target, :phase, :name, :fieldKey, :fieldType,
            :required, :defaultVal, :optionsJson, :minVal, :maxVal, :stepVal,
            :unit, :orderSeq, :isActive,
            COALESCE(NULLIF(TRIM(:createdAt), ''), CURRENT_TIMESTAMP),
            COALESCE(NULLIF(TRIM(:updatedAt), ''), CURRENT_TIMESTAMP)
        )
    """)
    void insert(@BindBean CustomFieldDefinition def);

    @SqlUpdate("""
        UPDATE event_custom_fields SET
            phase        = :phase,
            name         = :name,
            field_type   = :fieldType,
            required     = :required,
            default_val  = :defaultVal,
            options_json = :optionsJson,
            min_val      = :minVal,
            max_val      = :maxVal,
            step_val     = :stepVal,
            unit         = :unit,
            order_seq    = :orderSeq,
            is_active    = :isActive,
            updated_at   = CURRENT_TIMESTAMP
        WHERE id = :id
    """)
    int update(@BindBean CustomFieldDefinition def);

    @SqlUpdate("DELETE FROM event_custom_fields WHERE id = :id")
    int delete(@Bind("id") String id);

    @SqlUpdate("UPDATE event_custom_fields SET order_seq = :orderSeq, updated_at = CURRENT_TIMESTAMP WHERE id = :id")
    int updateOrder(@Bind("id") String id, @Bind("orderSeq") int orderSeq);

    @SqlUpdate("UPDATE event_custom_fields SET is_active = :isActive, updated_at = CURRENT_TIMESTAMP WHERE id = :id")
    int toggleActive(@Bind("id") String id, @Bind("isActive") boolean isActive);
}
