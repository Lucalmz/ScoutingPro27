-- V11__Add_AI_Base_Url.sql
-- Add base_url column to ai_settings for custom OpenAI-compatible endpoints (e.g., DeepSeek, SiliconFlow, Ollama)
ALTER TABLE ai_settings ADD COLUMN base_url VARCHAR(500) DEFAULT '';
