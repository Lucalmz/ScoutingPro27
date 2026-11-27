package com.bear27570.app.util;

import com.bear27570.app.model.CustomFieldDefinition;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.util.*;

/**
 * Zero-eval pure tokenizer, recursive-descent AST validator, cross-layer checker,
 * and 3-color DFS cycle detector for custom field formulas.
 *
 * Grammar & security rules match shared/formula-conformance-cases.json and CONTRACT.md §9.
 */
public final class FormulaValidator {

    public static final int MAX_EXPR_LENGTH = 1000;
    public static final int MAX_TOKENS = 256;
    public static final int MAX_AST_DEPTH = 20;
    public static final int MAX_AST_NODES = 200;

    private static final Gson GSON = new Gson();
    private static final Type STRING_LIST_TYPE = new TypeToken<List<String>>() {}.getType();

    private static final Set<String> FORBIDDEN_IDENTIFIERS = Set.of(
            "__proto__", "constructor", "prototype", "window", "globalthis",
            "process", "eval", "function", "import", "require", "this", "self"
    );

    private static final Set<String> ALL_KNOWN_NAMESPACES = Set.of(
            "match", "official", "opr", "pit", "pit_cf", "cf", "match_cf", "formula"
    );

    private static final Map<String, Set<String>> ALLOWED_NAMESPACES_BY_TARGET = Map.of(
            "MATCH", Set.of("match", "cf", "formula"),
            "PIT", Set.of("pit", "pit_cf", "cf", "formula"),
            "TEAM", Set.of("match", "official", "opr", "pit", "pit_cf", "cf", "match_cf", "formula")
    );

    private static final Set<String> ALLOWED_FUNCTIONS = Set.of(
            "ABS", "ROUND", "FLOOR", "CEIL", "MIN", "MAX", "CLAMP", "SQRT", "POW", "LOG", "SIGN",
            "IF", "COALESCE", "ISNULL", "SAFE_DIV",
            "AVG", "SUM", "MEDIAN", "STDDEV", "COUNT", "RATE", "TRIMMED_AVG", "RECENT_AVG",
            "PERCENTILE", "WEIGHTED_AVG", "NORM", "MAP_RANGE"
    );

    private FormulaValidator() {}

    public static final class ValidationResult {
        private final boolean valid;
        private final String errorCode;
        private final String errorMessage;
        private final List<String> dependencies;
        private final List<String> cyclePath;

        private ValidationResult(
                boolean valid,
                String errorCode,
                String errorMessage,
                List<String> dependencies,
                List<String> cyclePath
        ) {
            this.valid = valid;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
            this.dependencies = dependencies != null ? Collections.unmodifiableList(dependencies) : List.of();
            this.cyclePath = cyclePath != null ? Collections.unmodifiableList(cyclePath) : null;
        }

        public static ValidationResult ok(List<String> dependencies) {
            return new ValidationResult(true, null, null, dependencies, null);
        }

        public static ValidationResult error(String errorCode, String errorMessage) {
            return new ValidationResult(false, errorCode, errorMessage, List.of(), null);
        }

        public static ValidationResult cycleError(String errorMessage, List<String> cyclePath) {
            return new ValidationResult(false, "CIRCULAR_DEPENDENCY", errorMessage, List.of(), cyclePath);
        }

        public boolean isValid() { return valid; }
        public String getErrorCode() { return errorCode; }
        public String getErrorMessage() { return errorMessage; }
        public List<String> getDependencies() { return dependencies; }
        public List<String> getCyclePath() { return cyclePath; }

        public Map<String, Object> toErrorResponseMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("error", errorMessage);
            map.put("errorCode", errorCode);
            if (cyclePath != null && !cyclePath.isEmpty()) {
                map.put("cyclePath", cyclePath);
            }
            return map;
        }
    }

    private enum TokenType {
        NUMBER,
        IDENT,
        OP,
        LPAREN,
        RPAREN,
        COMMA,
        DOT,
        QUESTION,
        COLON,
        EOF
    }

    private record Token(TokenType type, String text, int pos) {}

    private static final class FormulaParseException extends RuntimeException {
        final String errorCode;

        FormulaParseException(String errorCode, String message) {
            super(message);
            this.errorCode = errorCode;
        }
    }

    public static ValidationResult validate(String expr, String target) {
        if (expr == null || expr.trim().isEmpty()) {
            return ValidationResult.error("EMPTY_FORMULA", "Formula expression cannot be empty");
        }
        if (expr.length() > MAX_EXPR_LENGTH) {
            return ValidationResult.error("EXPR_TOO_LONG",
                    "Formula expression exceeds maximum length of " + MAX_EXPR_LENGTH + " characters");
        }

        String normalizedTarget = target != null ? target.trim().toUpperCase(Locale.ROOT) : "MATCH";
        if (!ALLOWED_NAMESPACES_BY_TARGET.containsKey(normalizedTarget)) {
            return ValidationResult.error("INVALID_SYNTAX", "Unsupported formula target: " + normalizedTarget);
        }

        try {
            List<Token> tokens = tokenize(expr);
            // tokens includes EOF; check real token count
            if (tokens.size() - 1 > MAX_TOKENS) {
                return ValidationResult.error("TOKEN_LIMIT_EXCEEDED",
                        "Formula exceeds maximum token limit of " + MAX_TOKENS);
            }
            Parser parser = new Parser(tokens, normalizedTarget);
            parser.parse();
            return ValidationResult.ok(new ArrayList<>(parser.dependencies));
        } catch (FormulaParseException ex) {
            return ValidationResult.error(ex.errorCode, ex.getMessage());
        }
    }

    public static ValidationResult validateWithGraph(
            CustomFieldDefinition candidate,
            List<CustomFieldDefinition> existingFields
    ) {
        if (candidate == null) {
            return ValidationResult.error("EMPTY_FORMULA", "Formula field is required");
        }
        String target = candidate.getTarget() != null ? candidate.getTarget().trim().toUpperCase(Locale.ROOT) : "MATCH";
        ValidationResult syntaxResult = validate(candidate.getFormulaExpr(), target);
        if (!syntaxResult.isValid()) {
            return syntaxResult;
        }

        List<CustomFieldDefinition> fields = existingFields != null ? existingFields : List.of();
        String candidateKey = candidate.getFieldKey() != null
                ? candidate.getFieldKey().trim().toLowerCase(Locale.ROOT)
                : "";
        Map<String, Set<String>> formulaTargetsByKey = new HashMap<>();
        for (CustomFieldDefinition field : fields) {
            if (field == null || field.getFieldKey() == null) continue;
            if (!"formula".equalsIgnoreCase(field.getFieldType())) continue;
            if (candidate.getId() != null && candidate.getId().equals(field.getId())) continue;
            String key = field.getFieldKey().trim().toLowerCase(Locale.ROOT);
            String fieldTarget = field.getTarget() != null ? field.getTarget().trim().toUpperCase(Locale.ROOT) : "MATCH";
            if (!candidateKey.isEmpty() && key.equals(candidateKey) && fieldTarget.equals(target)) continue;
            formulaTargetsByKey.computeIfAbsent(key, k -> new HashSet<>()).add(fieldTarget);
        }
        if (!candidateKey.isEmpty()) {
            formulaTargetsByKey.computeIfAbsent(candidateKey, k -> new HashSet<>()).add(target);
        }

        // Cross-layer check for formula.* references
        for (String dep : syntaxResult.getDependencies()) {
            if (dep.startsWith("formula.")) {
                String refKey = dep.substring("formula.".length()).toLowerCase(Locale.ROOT);
                Set<String> refTargets = formulaTargetsByKey.getOrDefault(refKey, Set.of());
                if ("MATCH".equals(target) && (refTargets.contains("TEAM") || refTargets.contains("PIT"))
                        && !refTargets.contains("MATCH")) {
                    return ValidationResult.error("CROSS_LAYER_REFERENCE",
                            "MATCH formula cannot reference " + (refTargets.contains("TEAM") ? "TEAM" : "PIT")
                                    + " formula 'formula." + refKey + "'");
                }
                if ("PIT".equals(target) && (refTargets.contains("MATCH") || refTargets.contains("TEAM"))
                        && !refTargets.contains("PIT")) {
                    return ValidationResult.error("CROSS_LAYER_REFERENCE",
                            "PIT formula cannot reference MATCH/TEAM formula 'formula." + refKey + "'");
                }
            }
        }

        // Build target-scoped formula dependency graph for 3-color DFS cycle detection
        if (candidateKey.isEmpty()) {
            return syntaxResult;
        }

        Map<String, List<String>> rawFormulaDepsByNode = new LinkedHashMap<>();
        for (CustomFieldDefinition field : fields) {
            if (field == null || !"formula".equalsIgnoreCase(field.getFieldType())) continue;
            if (candidate.getId() != null && candidate.getId().equals(field.getId())) continue;
            String key = field.getFieldKey() != null ? field.getFieldKey().trim().toLowerCase(Locale.ROOT) : "";
            String fieldTarget = field.getTarget() != null ? field.getTarget().trim().toUpperCase(Locale.ROOT) : "MATCH";
            if (key.isEmpty() || (key.equals(candidateKey) && fieldTarget.equals(target))) continue;

            rawFormulaDepsByNode.put(formulaNodeId(fieldTarget, key), extractFormulaDeps(field));
        }

        String candidateNode = formulaNodeId(target, candidateKey);
        List<String> candidateFormulaDeps = extractFormulaKeyRefs(syntaxResult.getDependencies());
        rawFormulaDepsByNode.put(candidateNode, candidateFormulaDeps);

        Map<String, List<String>> graph = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : rawFormulaDepsByNode.entrySet()) {
            String node = entry.getKey();
            int sep = node.indexOf(':');
            String nodeTarget = sep >= 0 ? node.substring(0, sep) : "MATCH";
            String nodeKey = sep >= 0 ? node.substring(sep + 1) : node;
            List<String> resolvedTargets = new ArrayList<>();
            for (String depKey : entry.getValue()) {
                if (!"TEAM".equals(nodeTarget)) {
                    resolvedTargets.add(formulaNodeId(nodeTarget, depKey));
                } else if (depKey.equals(nodeKey)) {
                    boolean addedLower = false;
                    for (String lower : List.of("MATCH", "PIT")) {
                        String lowerNode = formulaNodeId(lower, depKey);
                        if (rawFormulaDepsByNode.containsKey(lowerNode)) {
                            resolvedTargets.add(lowerNode);
                            addedLower = true;
                        }
                    }
                    if (!addedLower) {
                        resolvedTargets.add(formulaNodeId("TEAM", depKey));
                    }
                } else {
                    for (String t : List.of("TEAM", "MATCH", "PIT")) {
                        String depNode = formulaNodeId(t, depKey);
                        if (rawFormulaDepsByNode.containsKey(depNode)) {
                            resolvedTargets.add(depNode);
                        }
                    }
                }
            }
            graph.put(node, resolvedTargets);
        }

        // 3-color DFS: 0 = WHITE, 1 = GRAY, 2 = BLACK
        Map<String, Integer> color = new HashMap<>();
        List<String> stack = new ArrayList<>();
        List<String> cycle = dfsFindCycle(candidateNode, graph, color, stack);
        if (cycle != null) {
            List<String> bareCycle = new ArrayList<>(cycle.size());
            for (String node : cycle) {
                int sep = node.indexOf(':');
                bareCycle.add(sep >= 0 ? node.substring(sep + 1) : node);
            }
            return ValidationResult.cycleError(
                    "Circular dependency detected: " + String.join(" -> ", bareCycle),
                    bareCycle
            );
        }

        return syntaxResult;
    }

    private static String formulaNodeId(String target, String fieldKey) {
        String t = target != null ? target.trim().toUpperCase(Locale.ROOT) : "MATCH";
        String k = fieldKey != null ? fieldKey.trim().toLowerCase(Locale.ROOT) : "";
        return t + ":" + k;
    }

    private static List<String> extractFormulaDeps(CustomFieldDefinition field) {
        if (field.getDependenciesJson() != null && !field.getDependenciesJson().isBlank()) {
            try {
                List<String> parsed = GSON.fromJson(field.getDependenciesJson(), STRING_LIST_TYPE);
                if (parsed != null) {
                    return extractFormulaKeyRefs(parsed);
                }
            } catch (Exception ignored) {
                // Fall back to parsing formulaExpr
            }
        }
        if (field.getFormulaExpr() != null && !field.getFormulaExpr().isBlank()) {
            ValidationResult res = validate(field.getFormulaExpr(), field.getTarget());
            if (res.isValid()) {
                return extractFormulaKeyRefs(res.getDependencies());
            }
        }
        return List.of();
    }

    private static List<String> extractFormulaKeyRefs(List<String> deps) {
        List<String> refs = new ArrayList<>();
        for (String dep : deps) {
            if (dep != null && dep.startsWith("formula.")) {
                String key = dep.substring("formula.".length()).trim().toLowerCase(Locale.ROOT);
                if (!key.isEmpty() && !refs.contains(key)) {
                    refs.add(key);
                }
            }
        }
        return refs;
    }

    private static List<String> dfsFindCycle(
            String node,
            Map<String, List<String>> graph,
            Map<String, Integer> color,
            List<String> stack
    ) {
        color.put(node, 1); // GRAY
        stack.add(node);

        for (String neighbor : graph.getOrDefault(node, List.of())) {
            int neighborColor = color.getOrDefault(neighbor, 0);
            if (neighborColor == 1) {
                int idx = stack.indexOf(neighbor);
                List<String> cycle = new ArrayList<>(stack.subList(idx, stack.size()));
                cycle.add(neighbor);
                return cycle;
            }
            if (neighborColor == 0 && graph.containsKey(neighbor)) {
                List<String> cycle = dfsFindCycle(neighbor, graph, color, stack);
                if (cycle != null) {
                    return cycle;
                }
            }
        }

        stack.remove(stack.size() - 1);
        color.put(node, 2); // BLACK
        return null;
    }

    private static List<Token> tokenize(String expr) {
        List<Token> tokens = new ArrayList<>();
        int n = expr.length();
        int i = 0;

        while (i < n) {
            char c = expr.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }

            // Numbers: digits with optional single decimal part
            if (Character.isDigit(c)) {
                int start = i;
                while (i < n && Character.isDigit(expr.charAt(i))) {
                    i++;
                }
                if (i < n && expr.charAt(i) == '.') {
                    if (i + 1 < n && Character.isDigit(expr.charAt(i + 1))) {
                        i++;
                        while (i < n && Character.isDigit(expr.charAt(i))) {
                            i++;
                        }
                    } else {
                        throw new FormulaParseException("INVALID_TOKEN", "Invalid number literal at position " + start);
                    }
                }
                tokens.add(new Token(TokenType.NUMBER, expr.substring(start, i), start));
                continue;
            }

            // Identifiers
            if (Character.isLetter(c) || c == '_') {
                int start = i;
                while (i < n && (Character.isLetterOrDigit(expr.charAt(i)) || expr.charAt(i) == '_')) {
                    i++;
                }
                String ident = expr.substring(start, i);
                if (FORBIDDEN_IDENTIFIERS.contains(ident.toLowerCase(Locale.ROOT))) {
                    throw new FormulaParseException("FORBIDDEN_IDENTIFIER",
                            "Forbidden identifier '" + ident + "' is not allowed");
                }
                tokens.add(new Token(TokenType.IDENT, ident, start));
                continue;
            }

            // Two-character operators
            if (i + 1 < n) {
                String two = expr.substring(i, i + 2);
                if (two.equals("||") || two.equals("&&") || two.equals("==")
                        || two.equals("!=") || two.equals("<=") || two.equals(">=")) {
                    tokens.add(new Token(TokenType.OP, two, i));
                    i += 2;
                    continue;
                }
            }

            // Single-character operators and punctuation
            switch (c) {
                case '<', '>', '+', '-', '*', '/', '%', '!', '^' -> {
                    tokens.add(new Token(TokenType.OP, String.valueOf(c), i));
                    i++;
                }
                case '(' -> { tokens.add(new Token(TokenType.LPAREN, "(", i)); i++; }
                case ')' -> { tokens.add(new Token(TokenType.RPAREN, ")", i)); i++; }
                case ',' -> { tokens.add(new Token(TokenType.COMMA, ",", i)); i++; }
                case '.' -> { tokens.add(new Token(TokenType.DOT, ".", i)); i++; }
                case '?' -> { tokens.add(new Token(TokenType.QUESTION, "?", i)); i++; }
                case ':' -> { tokens.add(new Token(TokenType.COLON, ":", i)); i++; }
                default -> throw new FormulaParseException("INVALID_TOKEN",
                        "Disallowed character or token '" + c + "' at position " + i);
            }
        }

        tokens.add(new Token(TokenType.EOF, "", n));
        return tokens;
    }

    private static final class Parser {
        private final List<Token> tokens;
        private final String target;
        private final Set<String> allowedNamespaces;
        private final Set<String> dependencies = new LinkedHashSet<>();
        private int pos = 0;
        private int nodeCount = 0;
        private int depth = 0;

        Parser(List<Token> tokens, String target) {
            this.tokens = tokens;
            this.target = target;
            this.allowedNamespaces = ALLOWED_NAMESPACES_BY_TARGET.get(target);
        }

        void parse() {
            parseTernary();
            if (peek().type() != TokenType.EOF) {
                throw new FormulaParseException("INVALID_SYNTAX",
                        "Unexpected token '" + peek().text() + "' at position " + peek().pos());
            }
        }

        private Token peek() {
            return tokens.get(pos);
        }

        private Token advance() {
            Token t = tokens.get(pos);
            if (pos < tokens.size() - 1) {
                pos++;
            }
            return t;
        }

        private boolean matchOp(String op) {
            Token t = peek();
            if (t.type() == TokenType.OP && t.text().equals(op)) {
                advance();
                return true;
            }
            return false;
        }

        private void enterDepth() {
            depth++;
            if (depth > MAX_AST_DEPTH) {
                throw new FormulaParseException("AST_DEPTH_EXCEEDED",
                        "Formula AST nesting depth exceeds maximum of " + MAX_AST_DEPTH);
            }
        }

        private void exitDepth() {
            depth--;
        }

        private void countNode() {
            nodeCount++;
            if (nodeCount > MAX_AST_NODES) {
                throw new FormulaParseException("AST_NODE_LIMIT_EXCEEDED",
                        "Formula AST node count exceeds maximum of " + MAX_AST_NODES);
            }
        }

        // ?: (right-associative)
        private void parseTernary() {
            parseOr();
            if (peek().type() == TokenType.QUESTION) {
                advance();
                countNode();
                enterDepth();
                try {
                    parseTernary();
                    if (peek().type() != TokenType.COLON) {
                        throw new FormulaParseException("INVALID_SYNTAX",
                                "Expected ':' in ternary expression at position " + peek().pos());
                    }
                    advance();
                    parseTernary();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseOr() {
            parseAnd();
            while (matchOp("||")) {
                countNode();
                enterDepth();
                try {
                    parseAnd();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseAnd() {
            parseEquality();
            while (matchOp("&&")) {
                countNode();
                enterDepth();
                try {
                    parseEquality();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseEquality() {
            parseComparison();
            while (matchOp("==") || matchOp("!=")) {
                countNode();
                enterDepth();
                try {
                    parseComparison();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseComparison() {
            parseAdditive();
            while (matchOp("<") || matchOp("<=") || matchOp(">") || matchOp(">=")) {
                countNode();
                enterDepth();
                try {
                    parseAdditive();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseAdditive() {
            parseMultiplicative();
            while (matchOp("+") || matchOp("-")) {
                countNode();
                enterDepth();
                try {
                    parseMultiplicative();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parseMultiplicative() {
            parseUnary();
            while (matchOp("*") || matchOp("/") || matchOp("%")) {
                countNode();
                enterDepth();
                try {
                    parseUnary();
                } finally {
                    exitDepth();
                }
            }
        }

        // Unary ! - + (lower precedence than ^)
        private void parseUnary() {
            if (matchOp("!") || matchOp("-") || matchOp("+")) {
                countNode();
                enterDepth();
                try {
                    parseUnary();
                } finally {
                    exitDepth();
                }
                return;
            }
            parsePower();
        }

        // Power ^ (right-associative, higher precedence than unary)
        private void parsePower() {
            parsePrimary();
            if (matchOp("^")) {
                countNode();
                enterDepth();
                try {
                    parseUnary();
                } finally {
                    exitDepth();
                }
            }
        }

        private void parsePrimary() {
            Token t = peek();
            if (t.type() == TokenType.LPAREN) {
                advance();
                enterDepth();
                try {
                    parseTernary();
                    if (peek().type() != TokenType.RPAREN) {
                        throw new FormulaParseException("INVALID_SYNTAX",
                                "Expected ')' at position " + peek().pos());
                    }
                    advance();
                } finally {
                    exitDepth();
                }
                return;
            }

            if (t.type() == TokenType.NUMBER) {
                advance();
                countNode();
                return;
            }

            if (t.type() == TokenType.IDENT) {
                advance();
                String ident = t.text();

                // Literals true / false / null
                if ("true".equals(ident) || "false".equals(ident) || "null".equals(ident)) {
                    countNode();
                    return;
                }

                // Function call
                if (peek().type() == TokenType.LPAREN) {
                    String fnUpper = ident.toUpperCase(Locale.ROOT);
                    if (!ALLOWED_FUNCTIONS.contains(fnUpper)) {
                        throw new FormulaParseException("DISALLOWED_FUNCTION",
                                "Function '" + ident + "' is not in the allowed whitelist");
                    }
                    advance(); // consume '('
                    countNode();
                    enterDepth();
                    try {
                        if (peek().type() == TokenType.RPAREN) {
                            throw new FormulaParseException("INVALID_SYNTAX",
                                    "Function '" + ident + "' requires at least one argument");
                        }
                        parseTernary();
                        while (peek().type() == TokenType.COMMA) {
                            advance();
                            parseTernary();
                        }
                        if (peek().type() != TokenType.RPAREN) {
                            throw new FormulaParseException("INVALID_SYNTAX",
                                    "Expected ')' after function arguments at position " + peek().pos());
                        }
                        advance();
                    } finally {
                        exitDepth();
                    }
                    return;
                }

                // Namespaced variable reference: namespace.fieldKey
                if (peek().type() == TokenType.DOT) {
                    advance(); // consume '.'
                    Token fieldTok = peek();
                    if (fieldTok.type() != TokenType.IDENT) {
                        throw new FormulaParseException("INVALID_SYNTAX",
                                "Expected field identifier after '.' at position " + fieldTok.pos());
                    }
                    advance();

                    // Reject deep property chains like a.b.c or method calls like a.b()
                    if (peek().type() == TokenType.DOT || peek().type() == TokenType.LPAREN) {
                        throw new FormulaParseException("INVALID_SYNTAX",
                                "Deep property chains or method calls are not allowed at position " + peek().pos());
                    }

                    String ns = ident;
                    String field = fieldTok.text();

                    if (!allowedNamespaces.contains(ns)) {
                        if (ALL_KNOWN_NAMESPACES.contains(ns)) {
                            throw new FormulaParseException("CROSS_LAYER_REFERENCE",
                                    "Target '" + target + "' formula cannot reference namespace '" + ns + ".*'");
                        }
                        throw new FormulaParseException("DISALLOWED_NAMESPACE",
                                "Namespace '" + ns + "' is not allowed");
                    }

                    String fullRef = ns + "." + field;
                    if (!fullRef.matches("^[a-z][a-z0-9_]*\\.[A-Za-z0-9_]+$")) {
                        throw new FormulaParseException("INVALID_SYNTAX",
                                "Invalid variable reference '" + fullRef + "'");
                    }

                    dependencies.add(fullRef);
                    countNode();
                    return;
                }

                // Bare identifier without namespace
                throw new FormulaParseException("DISALLOWED_NAMESPACE",
                        "Bare identifier '" + ident + "' must use an allowed namespace prefix");
            }

            throw new FormulaParseException("INVALID_SYNTAX",
                    "Unexpected token '" + t.text() + "' at position " + t.pos());
        }
    }
}
