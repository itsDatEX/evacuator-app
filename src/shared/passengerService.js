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

const PASS_PAGE_SIZE = 10;

async function getAllPassengers({ limit = PASS_PAGE_SIZE, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, telegram_id, full_name, phone, is_active,
            discount_available, created_at
     FROM passengers
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function countPassengers() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM passengers');
  return parseInt(rows[0].cnt, 10);
}

async function findPassengerById(id) {
  const { rows } = await pool.query('SELECT * FROM passengers WHERE id = $1', [id]);
  return rows[0] || null;
}

async function findPassengerByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT * FROM passengers WHERE phone ILIKE '%' || $1 || '%' LIMIT 1`,
    [phone.trim()]
  );
  return rows[0] || null;
}

const PASS_EDITABLE_FIELDS = { full_name: true, phone: true };

async function updatePassengerField(passengerId, field, value) {
  if (!PASS_EDITABLE_FIELDS[field]) throw new Error(`Field "${field}" is not editable`);
  const { rows } = await pool.query(
    `UPDATE passengers SET ${field} = $1 WHERE id = $2 RETURNING *`,
    [value, passengerId]
  );
  return rows[0] || null;
}

async function togglePassengerActive(passengerId) {
  const { rows } = await pool.query(
    `UPDATE passengers SET is_active = NOT is_active
     WHERE id = $1 RETURNING id, full_name, is_active`,
    [passengerId]
  );
  return rows[0] || null;
}

async function getActivePassengerTelegramIds() {
  const { rows } = await pool.query(
    'SELECT telegram_id FROM passengers WHERE is_active IS NOT FALSE'
  );
  return rows.map(r => r.telegram_id);
}

module.exports = {
  findByTelegramId, createPassenger, addDiscount, consumeDiscount,
  getAllPassengers, countPassengers,
  findPassengerById, findPassengerByPhone,
  updatePassengerField, togglePassengerActive,
  getActivePassengerTelegramIds,
};
