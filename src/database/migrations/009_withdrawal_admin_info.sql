ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS admin_telegram_id BIGINT,
  ADD COLUMN IF NOT EXISTS admin_name        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS admin_phone       VARCHAR(50);
