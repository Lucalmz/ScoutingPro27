package com.bear27570.app.model;

public class CustomFieldDefinition {
    private String id;
    private String eventId;
    private String target; // "MATCH" or "PIT"
    private String phase = "overall"; // "auto", "teleop", "endgame", "overall", "hardware", "strategy"
    private String name;
    private String fieldKey;
    private String fieldType; // "boolean", "number", "level", "select", "multi_select", "text"
    private boolean required = false;
    private String defaultVal;
    private String optionsJson;
    private Double minVal;
    private Double maxVal;
    private Double stepVal;
    private String unit;
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
