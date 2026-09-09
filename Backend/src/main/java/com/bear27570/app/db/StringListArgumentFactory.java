package com.bear27570.app.db;

import com.google.gson.Gson;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;

import java.sql.Types;
import java.util.List;

public class StringListArgumentFactory extends AbstractArgumentFactory<List<String>> {

    private static final Gson GSON = new Gson();

    public StringListArgumentFactory() {
        super(Types.VARCHAR);
    }

    @Override
    protected Argument build(List<String> value, ConfigRegistry config) {
        return (position, statement, ctx) -> {
            if (value == null || value.isEmpty()) {
                statement.setString(position, "[]");
            } else {
                statement.setString(position, GSON.toJson(value));
            }
        };
    }
}
