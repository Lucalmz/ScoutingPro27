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
}
