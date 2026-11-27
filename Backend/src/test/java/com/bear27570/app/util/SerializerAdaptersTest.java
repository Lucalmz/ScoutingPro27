package com.bear27570.app.util;

import com.bear27570.app.routes.ApiRoutes;
import com.google.gson.Gson;
import com.google.gson.annotations.JsonAdapter;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SerializerAdaptersTest {

    static class Holder {
        @JsonAdapter(StringListTypeAdapter.class)
        List<String> keys;
    }

    static class IntHolder {
        int primitiveInt;
        Integer boxedInt;
    }

    @Test
    void testStringListTypeAdapterAllInputAndOutputShapes() throws java.io.IOException {
        Gson gson = new Gson();

        // Array with null element skipped
        Holder fromArr = gson.fromJson("{\"keys\":[\"a\",null,\"b\"]}", Holder.class);
        assertThat(fromArr.keys).containsExactly("a", "b");

        // Stringified JSON array
        Holder fromJsonStr = gson.fromJson("{\"keys\":\"[\\\"p1\\\",\\\"p2\\\"]\"}", Holder.class);
        assertThat(fromJsonStr.keys).containsExactly("p1", "p2");

        // Comma-delimited string
        Holder fromCsv = gson.fromJson("{\"keys\":\" k1 , k2 , , k3 \"}", Holder.class);
        assertThat(fromCsv.keys).containsExactly("k1", "k2", "k3");

        // Blank / unexpected token type (number) through Gson
        assertThat(gson.fromJson("{\"keys\":\"   \"}", Holder.class).keys).isEmpty();
        assertThat(gson.fromJson("{\"keys\":12345}", Holder.class).keys).isEmpty();

        // Direct adapter invocation covers @JsonAdapter-bypassed null read & null write
        StringListTypeAdapter directAdapter = new StringListTypeAdapter();
        assertThat(directAdapter.fromJson("null")).isEmpty();
        assertThat(directAdapter.toJson(null)).isEqualTo("[]");

        Holder mixed = new Holder();
        mixed.keys = Arrays.asList("x", null, "y");
        assertThat(gson.toJson(mixed)).isEqualTo("{\"keys\":[\"x\",\"y\"]}");
    }

    @Test
    void testApiRoutesGsonIntDeserializersAndAsString() {
        Gson gson = ApiRoutes.createGson();

        IntHolder rounded = gson.fromJson("{\"primitiveInt\":12.6,\"boxedInt\":7.4}", IntHolder.class);
        assertThat(rounded.primitiveInt).isEqualTo(13);
        assertThat(rounded.boxedInt).isEqualTo(7);

        IntHolder bad = gson.fromJson("{\"primitiveInt\":\"abc\",\"boxedInt\":\"xyz\"}", IntHolder.class);
        assertThat(bad.primitiveInt).isZero();
        assertThat(bad.boxedInt).isNull();

        assertThat(ApiRoutes.asString(null)).isNull();
        assertThat(ApiRoutes.asString(42.0)).isEqualTo("42");
        assertThat(ApiRoutes.asString(42.5)).isEqualTo("42.5");
        assertThat(ApiRoutes.asString("hello")).isEqualTo("hello");
    }
}
