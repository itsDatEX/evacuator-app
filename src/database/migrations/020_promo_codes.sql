CREATE TABLE IF NOT EXISTS promo_codes (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(50) UNIQUE NOT NULL,
  discount_amount NUMERIC NOT NULL,
  max_uses        INTEGER NOT NULL DEFAULT 1,
  used_count      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_code_usages (
  id            SERIAL PRIMARY KEY,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id),
  passenger_id  INTEGER NOT NULL REFERENCES passengers(id),
  used_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (promo_code_id, passenger_id)
);
