-- Additive migration 0005: Singleton Gemini pulse tuning preset pickup table (/api/pulse-preset)
CREATE TABLE IF NOT EXISTS pulse_presets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
