package com.bear27570.app.util;

import com.google.gson.Gson;
import com.google.gson.TypeAdapter;
import com.google.gson.reflect.TypeToken;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;

import java.io.IOException;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Gson TypeAdapter for List<String>.
 * Read: Robustly parses JSON array, comma-delimited string, or null.
 * Write: Always serializes as a JSON array of strings.
 */
public class StringListTypeAdapter extends TypeAdapter<List<String>> {

    private static final Gson GSON = new Gson();
    private static final Type LIST_STRING_TYPE = new TypeToken<List<String>>() {}.getType();

    @Override
    public void write(JsonWriter out, List<String> value) throws IOException {
        if (value == null) {
            out.beginArray();
            out.endArray();
            return;
        }
        out.beginArray();
        for (String s : value) {
            if (s != null) {
                out.value(s);
            }
        }
        out.endArray();
    }

    @Override
    public List<String> read(JsonReader in) throws IOException {
        JsonToken token = in.peek();
        if (token == JsonToken.NULL) {
            in.nextNull();
            return new ArrayList<>();
        }

        if (token == JsonToken.BEGIN_ARRAY) {
            List<String> list = new ArrayList<>();
            in.beginArray();
            while (in.hasNext()) {
                if (in.peek() == JsonToken.NULL) {
                    in.nextNull();
                } else {
                    list.add(in.nextString());
                }
            }
            in.endArray();
            return list;
        }

        if (token == JsonToken.STRING) {
            String raw = in.nextString();
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

        in.skipValue();
        return new ArrayList<>();
    }
}
