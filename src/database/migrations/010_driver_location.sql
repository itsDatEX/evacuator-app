ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS current_lat          DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS current_lng          DECIMAL(11,8),
  ADD COLUMN IF NOT EXISTS location_updated_at  TIMESTAMPTZ;
