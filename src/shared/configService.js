const pool = require('../database/pool');

async function getBonusEnabled() {
  const { rows } = await pool.query(
    "SELECT value FROM app_config WHERE key = 'bonus_enabled'"
  );
  return rows[0]?.value === 'true';
}

async function toggleBonusEnabled() {
  const { rows } = await pool.query(`
    UPDATE app_config
    SET value = CASE WHEN value = 'true' THEN 'false' ELSE 'true' END
    WHERE key = 'bonus_enabled'
    RETURNING value
  `);
  return rows[0]?.value === 'true';
}

async function getBonusPeriod() {
  const { rows } = await pool.query(
    "SELECT key, value FROM app_config WHERE key IN ('bonus_period_start', 'bonus_period_end')"
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    start: map['bonus_period_start'] ? new Date(map['bonus_period_start']) : null,
    end:   map['bonus_period_end']   ? new Date(map['bonus_period_end'])   : null,
  };
}

async function setBonusPeriod(start, end) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE app_config SET value = $1 WHERE key = 'bonus_period_start'",
      [start ? start.toISOString() : '']
    );
    await client.query(
      "UPDATE app_config SET value = $1 WHERE key = 'bonus_period_end'",
      [end ? end.toISOString() : '']
    );
    await client.query('UPDATE drivers SET bonus_period_completed_count = 0');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getGlobalDiscount() {
  const { rows } = await pool.query(
    "SELECT key, value FROM app_config WHERE key IN ('global_discount_amount', 'global_discount_until')"
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const amount = parseFloat(map['global_discount_amount']) || 0;
  const until  = map['global_discount_until'] ? new Date(map['global_discount_until']) : null;
  if (!until || until < new Date()) return { amount: 0, until };
  return { amount, until };
}

async function setGlobalDiscount(amount, until) {
  await pool.query(
    "UPDATE app_config SET value = $1 WHERE key = 'global_discount_amount'",
    [String(amount)]
  );
  await pool.query(
    "UPDATE app_config SET value = $1 WHERE key = 'global_discount_until'",
    [until ? until.toISOString() : '']
  );
}

module.exports = {
  getBonusEnabled, toggleBonusEnabled,
  getBonusPeriod, setBonusPeriod,
  getGlobalDiscount, setGlobalDiscount,
};
