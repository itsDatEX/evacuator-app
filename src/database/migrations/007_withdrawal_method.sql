ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'cash'
    CHECK (method IN ('cash', 'card'));
