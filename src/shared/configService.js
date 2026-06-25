const pool = require('../database/pool');

async function getBonusEnabled() {
  const { rows } = await pool.query(
    "SELECT value FROM app_config WHERE key = 'bonus_enabled'"
  );
  return rows[0]?.value === 'true';
}

// Atomically flips bonus_enabled and returns the new value.
async function toggleBonusEnabled() {
  const { rows } = await pool.query(`
    UPDATE app_config
    SET value = CASE WHEN value = 'true' THEN 'false' ELSE 'true' END
    WHERE key = 'bonus_enabled'
    RETURNING value
  `);
  return rows[0]?.value === 'true';
}

module.exports = { getBonusEnabled, toggleBonusEnabled };
