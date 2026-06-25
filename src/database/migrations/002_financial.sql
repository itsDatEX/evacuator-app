-- Passenger loyalty discount (one-time flat amount, zeroed on use)
ALTER TABLE passengers
  ADD COLUMN IF NOT EXISTS discount_available NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Driver financial fields — two separate pools:
--   balance       = real earnings (card revenue minus commission, or cash commission debt)
--   bonus_balance = gift/incentive credits, never goes negative automatically
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance       NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Payment method on each order
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method    VARCHAR(10) NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('card', 'cash')),
  -- Stores the commission charged at completion time for audit trail
  ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(10,2);

-- Driver withdrawal log (admin records cash-outs; balance decremented atomically)
CREATE TABLE IF NOT EXISTS withdrawals (
  id        SERIAL PRIMARY KEY,
  driver_id INTEGER REFERENCES drivers(id) NOT NULL,
  amount    NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  note      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_driver ON withdrawals(driver_id);

-- Runtime toggles managed by admin bot (separate from Google Sheets pricing)
CREATE TABLE IF NOT EXISTS app_config (
  key   VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_config (key, value) VALUES ('bonus_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
