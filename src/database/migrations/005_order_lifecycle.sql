-- Full driver status lifecycle: arrived + in_progress timestamps.
-- Status flow: pending → accepted → arrived → in_progress → completed
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
