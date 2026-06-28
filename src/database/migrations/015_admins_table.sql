CREATE TABLE IF NOT EXISTS admins (
  id          SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  name        VARCHAR(100),
  role        VARCHAR(20) NOT NULL DEFAULT 'moderator'
              CHECK (role IN ('admin', 'moderator')),
  added_by    BIGINT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
