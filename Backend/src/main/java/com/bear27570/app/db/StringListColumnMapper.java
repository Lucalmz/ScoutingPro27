package com.bear27570.app.db;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.jdbi.v3.core.mapper.ColumnMapper;
import org.jdbi.v3.core.statement.StatementContext;

import java.lang.reflect.Type;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

public class StringListColumnMapper implements ColumnMapper<List<String>> {

    private static final Gson GSON = new Gson();
    private static final Type LIST_STRING_TYPE = new TypeToken<List<String>>() {}.getType();

    @Override
    public List<String> map(ResultSet r, int columnNumber, StatementContext ctx) throws SQLException {
        String raw = r.getString(columnNumber);
        if (raw == null || raw.isBlank()) {
            return new ArrayList<>();
        }
        raw = raw.trim();
        if (raw.startsWith("[") && raw.endsWith("]")) {
            try {
                List<String> parsed = GSON.fromJson(raw, LIST_STRING_TYPE);
                if (parsed != null) return parsed;
            } catch (Exception ignored) {}
        }
        return Arrays.stream(raw.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toCollection(ArrayList::new));
    }
}
