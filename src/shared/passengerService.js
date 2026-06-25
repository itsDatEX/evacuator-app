const pool = require('../database/pool');

async function findByTelegramId(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM passengers WHERE telegram_id = $1',
    [telegramId]
  );
  return rows[0] || null;
}

async function createPassenger({ telegramId, username, fullName, phone }) {
  const { rows } = await pool.query(
    `INSERT INTO passengers (telegram_id, username, full_name, phone)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [telegramId, username, fullName, phone]
  );
  return rows[0];
}

// Admin: add a one-time discount to a passenger's account.
async function addDiscount(telegramId, amount) {
  const { rows } = await pool.query(
    `UPDATE passengers SET discount_available = discount_available + $1
     WHERE telegram_id = $2
     RETURNING id, full_name, discount_available`,
    [amount, telegramId]
  );
  return rows[0] || null;
}

// Called at createOrder time: atomically reads the existing discount,
// zeros it, and returns the amount that was consumed.
// Uses a CTE so the pre-update value is captured before the write.
async function consumeDiscount(passengerId) {
  const { rows } = await pool.query(
    `WITH prev AS (SELECT discount_available FROM passengers WHERE id = $1)
     UPDATE passengers SET discount_available = 0
     WHERE id = $1 AND discount_available > 0
     RETURNING (SELECT discount_available FROM prev) AS consumed`,
    [passengerId]
  );
  return rows[0]?.consumed ? parseFloat(rows[0].consumed) : 0;
}

module.exports = { findByTelegramId, createPassenger, addDiscount, consumeDiscount };
