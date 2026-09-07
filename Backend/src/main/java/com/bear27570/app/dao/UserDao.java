package com.bear27570.app.dao;

import com.bear27570.app.model.User;
import org.jdbi.v3.sqlobject.config.RegisterBeanMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.customizer.BindBean;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

@RegisterBeanMapper(User.class)
public interface UserDao {

    @SqlUpdate("MERGE INTO users (id, username, password) KEY(id) VALUES (:id, :username, :password)")
    void upsert(@BindBean User user);

    @SqlQuery("SELECT * FROM users WHERE username = :username")
    User findByUsername(@Bind("username") String username);

    @SqlQuery("SELECT * FROM users WHERE id = :id")
    User findById(@Bind("id") String id);

    @SqlQuery("SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(:username)) AND password != '' AND password IS NOT NULL LIMIT 1")
    User findRegisteredByUsername(@Bind("username") String username);

    @SqlUpdate("""
        INSERT INTO users (id, username, password)
        SELECT :id, :username, ''
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = :id)
    """)
    void ensureScoutUserPlaceholder(@Bind("id") String id, @Bind("username") String username);
}
