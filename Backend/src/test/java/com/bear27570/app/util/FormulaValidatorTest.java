package com.bear27570.app.util;

import com.bear27570.app.model.CustomFieldDefinition;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class FormulaValidatorTest {

    private static JsonObject conformanceRoot;

    @BeforeAll
    static void loadConformanceCases() throws IOException {
        Path direct = Path.of("shared", "formula-conformance-cases.json");
        Path parent = Path.of("..", "shared", "formula-conformance-cases.json");
        Path resolved = Files.exists(direct) ? direct : parent;
        assertThat(Files.exists(resolved))
                .as("shared/formula-conformance-cases.json must exist at %s or %s", direct, parent)
                .isTrue();
        String json = Files.readString(resolved, StandardCharsets.UTF_8);
        conformanceRoot = JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    void testAllValidConformanceCases() {
        JsonArray validCases = conformanceRoot.getAsJsonArray("validCases");
        assertThat(validCases).isNotNull();
        assertThat(validCases.size()).isGreaterThan(0);

        for (JsonElement el : validCases) {
            JsonObject tc = el.getAsJsonObject();
            String name = tc.get("name").getAsString();
            String target = tc.get("target").getAsString();
            String expr = tc.get("expr").getAsString();

            FormulaValidator.ValidationResult result = FormulaValidator.validate(expr, target);
            assertThat(result.isValid())
                    .as("Valid case '%s' failed with %s: %s", name, result.getErrorCode(), result.getErrorMessage())
                    .isTrue();

            List<String> expectedDeps = new ArrayList<>();
            for (JsonElement depEl : tc.getAsJsonArray("expectedDeps")) {
                expectedDeps.add(depEl.getAsString());
            }
            assertThat(result.getDependencies())
                    .as("Dependencies mismatch for valid case '%s'", name)
                    .containsExactlyInAnyOrderElementsOf(expectedDeps);
        }
    }

    @Test
    void testAllInvalidConformanceCases() {
        JsonArray invalidCases = conformanceRoot.getAsJsonArray("invalidCases");
        assertThat(invalidCases).isNotNull();
        assertThat(invalidCases.size()).isGreaterThan(0);

        for (JsonElement el : invalidCases) {
            JsonObject tc = el.getAsJsonObject();
            String name = tc.get("name").getAsString();
            String target = tc.get("target").getAsString();
            String expectedErrorCode = tc.get("expectedErrorCode").getAsString();

            String expr;
            if (tc.has("expr")) {
                expr = tc.get("expr").getAsString();
            } else {
                expr = buildRepeatedExpr(tc.getAsJsonObject("exprRepeat"));
            }

            FormulaValidator.ValidationResult result = FormulaValidator.validate(expr, target);
            assertThat(result.isValid())
                    .as("Invalid case '%s' unexpectedly passed", name)
                    .isFalse();
            assertThat(result.getErrorCode())
                    .as("Error code mismatch for invalid case '%s'", name)
                    .isEqualTo(expectedErrorCode);
        }
    }

    @Test
    void testAllGraphConformanceCases() {
        JsonArray graphCases = conformanceRoot.getAsJsonArray("graphCases");
        assertThat(graphCases).isNotNull();
        assertThat(graphCases.size()).isGreaterThan(0);

        for (JsonElement el : graphCases) {
            JsonObject tc = el.getAsJsonObject();
            String name = tc.get("name").getAsString();
            boolean expectedValid = tc.get("expectedValid").getAsBoolean();

            List<CustomFieldDefinition> existingFields = new ArrayList<>();
            for (JsonElement efEl : tc.getAsJsonArray("existingFields")) {
                existingFields.add(toFieldDef(efEl.getAsJsonObject()));
            }
            CustomFieldDefinition candidate = toFieldDef(tc.getAsJsonObject("candidate"));

            FormulaValidator.ValidationResult result = FormulaValidator.validateWithGraph(candidate, existingFields);
            assertThat(result.isValid())
                    .as("Graph case '%s' validity mismatch (errorCode=%s, msg=%s)",
                            name, result.getErrorCode(), result.getErrorMessage())
                    .isEqualTo(expectedValid);

            if (!expectedValid) {
                String expectedErrorCode = tc.get("expectedErrorCode").getAsString();
                assertThat(result.getErrorCode())
                        .as("Graph case '%s' errorCode mismatch", name)
                        .isEqualTo(expectedErrorCode);
                if (tc.has("expectedCycleContains")) {
                    List<String> expectedCycleNodes = new ArrayList<>();
                    for (JsonElement nodeEl : tc.getAsJsonArray("expectedCycleContains")) {
                        expectedCycleNodes.add(nodeEl.getAsString());
                    }
                    assertThat(result.getCyclePath())
                            .as("Graph case '%s' cyclePath should contain %s", name, expectedCycleNodes)
                            .isNotNull()
                            .containsAll(expectedCycleNodes);
                    assertThat(result.getCyclePath().size()).isGreaterThanOrEqualTo(2);
                    assertThat(result.getCyclePath().get(0))
                            .isEqualTo(result.getCyclePath().get(result.getCyclePath().size() - 1));
                }
            }
        }
    }

    @Test
    void testAstNodeLimitExceeded() {
        // 105 additions => 106 number nodes + 105 binary nodes = 211 > 200 AST nodes, while <= 1000 chars and <= 256 tokens
        // Wait: 105 * 2 + 1 = 211 tokens <= 256 tokens, length ~ 420 <= 1000!
        StringBuilder sb = new StringBuilder("1");
        for (int i = 0; i < 105; i++) {
            sb.append("+1");
        }
        FormulaValidator.ValidationResult result = FormulaValidator.validate(sb.toString(), "TEAM");
        assertThat(result.isValid()).isFalse();
        assertThat(result.getErrorCode()).isEqualTo("AST_NODE_LIMIT_EXCEEDED");
    }

    private static String buildRepeatedExpr(JsonObject repeat) {
        int count = repeat.get("count").getAsInt();
        if (repeat.has("open")) {
            String open = repeat.get("open").getAsString();
            String core = repeat.get("core").getAsString();
            String close = repeat.get("close").getAsString();
            return open.repeat(count) + core + close.repeat(count);
        }
        String prefix = repeat.get("prefix").getAsString();
        String unit = repeat.get("unit").getAsString();
        return prefix + unit.repeat(count);
    }

    private static CustomFieldDefinition toFieldDef(JsonObject obj) {
        CustomFieldDefinition def = new CustomFieldDefinition();
        if (obj.has("id")) def.setId(obj.get("id").getAsString());
        if (obj.has("target")) def.setTarget(obj.get("target").getAsString());
        if (obj.has("fieldKey")) def.setFieldKey(obj.get("fieldKey").getAsString());
        if (obj.has("fieldType")) def.setFieldType(obj.get("fieldType").getAsString());
        if (obj.has("formulaExpr")) def.setFormulaExpr(obj.get("formulaExpr").getAsString());
        return def;
    }
}
