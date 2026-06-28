ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS personal_bonus_amount    NUMERIC,
  ADD COLUMN IF NOT EXISTS personal_bonus_threshold INTEGER,
  ADD COLUMN IF NOT EXISTS personal_bonus_until     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS personal_bonus_count     INTEGER NOT NULL DEFAULT 0;
