ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS bonus_period_completed_count INTEGER NOT NULL DEFAULT 0;

INSERT INTO app_config (key, value) VALUES ('bonus_period_start', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_config (key, value) VALUES ('bonus_period_end',   '') ON CONFLICT (key) DO NOTHING;
