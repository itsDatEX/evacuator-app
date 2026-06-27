ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'admin'
    CHECK (source IN ('admin', 'driver_self'));
