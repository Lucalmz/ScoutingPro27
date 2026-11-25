package com.bear27570.app.model;

public class CustomFieldDefinition {
    private String id;
    private String eventId;
    private String target; // "MATCH", "PIT", or "TEAM"
    private String phase = "overall"; // "auto", "teleop", "endgame", "overall", "hardware", "strategy"
    private String name;
    private String fieldKey;
    private String fieldType; // "boolean", "number", "timer", "level", "select", "multi_select", "text", "formula"
    private boolean required = false;
    private String defaultVal;
    private String optionsJson;
    private Double minVal;
    private Double maxVal;
    private Double stepVal;
    private String unit;
    private String description;
    private String configJson;
    private String formulaExpr;
    private String aggregationMode = "avg";
    private String displayFormat = "number";
    private String dependenciesJson;
    private int orderSeq = 0;
    private boolean isActive = true;
    private String createdAt;
    private String updatedAt;

    public CustomFieldDefinition() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }

    public String getTarget() { return target; }
    public void setTarget(String target) { this.target = target; }

    public String getPhase() { return phase; }
    public void setPhase(String phase) { this.phase = phase; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getFieldKey() { return fieldKey; }
    public void setFieldKey(String fieldKey) { this.fieldKey = fieldKey; }

    public String getFieldType() { return fieldType; }
    public void setFieldType(String fieldType) { this.fieldType = fieldType; }

    public boolean isRequired() { return required; }
    public boolean getRequired() { return required; }
    public void setRequired(boolean required) { this.required = required; }

    public String getDefaultVal() { return defaultVal; }
    public void setDefaultVal(String defaultVal) { this.defaultVal = defaultVal; }

    public String getOptionsJson() { return optionsJson; }
    public void setOptionsJson(String optionsJson) { this.optionsJson = optionsJson; }

    public Double getMinVal() { return minVal; }
    public void setMinVal(Double minVal) { this.minVal = minVal; }

    public Double getMaxVal() { return maxVal; }
    public void setMaxVal(Double maxVal) { this.maxVal = maxVal; }

    public Double getStepVal() { return stepVal; }
    public void setStepVal(Double stepVal) { this.stepVal = stepVal; }

    public String getUnit() { return unit; }
    public void setUnit(String unit) { this.unit = unit; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getConfigJson() { return configJson; }
    public void setConfigJson(String configJson) { this.configJson = configJson; }

    public String getFormulaExpr() { return formulaExpr; }
    public void setFormulaExpr(String formulaExpr) { this.formulaExpr = formulaExpr; }

    public String getAggregationMode() { return aggregationMode; }
    public void setAggregationMode(String aggregationMode) { this.aggregationMode = aggregationMode; }

    public String getDisplayFormat() { return displayFormat; }
    public void setDisplayFormat(String displayFormat) { this.displayFormat = displayFormat; }

    public String getDependenciesJson() { return dependenciesJson; }
    public void setDependenciesJson(String dependenciesJson) { this.dependenciesJson = dependenciesJson; }

    public int getOrderSeq() { return orderSeq; }
    public void setOrderSeq(int orderSeq) { this.orderSeq = orderSeq; }

    public boolean isIsActive() { return isActive; }
    public boolean isActive() { return isActive; }
    public boolean getIsActive() { return isActive; }
    public void setIsActive(boolean isActive) { this.isActive = isActive; }
    public void setActive(boolean active) { this.isActive = active; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
