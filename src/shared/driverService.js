const pool = require('../database/pool');

async function findByTelegramId(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM drivers WHERE telegram_id = $1', [telegramId]
  );
  return rows[0] || null;
}

async function createDriver({ telegramId, username, fullName, phone, truckType, carModel, carPlate }) {
  const { rows } = await pool.query(
    `INSERT INTO drivers
       (telegram_id, username, full_name, phone, truck_type, car_model, car_plate, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
    [telegramId, username || null, fullName, phone, truckType, carModel || null, carPlate]
  );
  return rows[0];
}

async function setAvailability(telegramId, isAvailable) {
  await pool.query(
    'UPDATE drivers SET is_available = $1 WHERE telegram_id = $2',
    [isAvailable, telegramId]
  );
}

async function setRoute(telegramId, { routeFrom, routeTo, departureAt }) {
  await pool.query(
    `UPDATE drivers
     SET route_from = $1, route_to = $2, route_departure_at = $3, is_available = true
     WHERE telegram_id = $4`,
    [routeFrom, routeTo, departureAt, telegramId]
  );
}

async function clearRoute(telegramId) {
  await pool.query(
    `UPDATE drivers
     SET route_from = NULL, route_to = NULL, route_departure_at = NULL
     WHERE telegram_id = $1`,
    [telegramId]
  );
}

async function getAllDrivers({ limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, telegram_id, full_name, phone, truck_type,
            is_active, is_available, balance, car_model, car_plate
     FROM drivers
     ORDER BY is_active DESC, full_name ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function countDrivers() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM drivers');
  return parseInt(rows[0].cnt, 10);
}

async function findDriverById(id) {
  const { rows } = await pool.query('SELECT * FROM drivers WHERE id = $1', [id]);
  return rows[0] || null;
}

async function findDriverByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT * FROM drivers WHERE phone ILIKE '%' || $1 || '%' LIMIT 1`,
    [phone.trim()]
  );
  return rows[0] || null;
}

const EDITABLE_FIELDS = { full_name: true, phone: true, car_model: true, car_plate: true };

async function updateDriverField(driverId, field, value) {
  if (!EDITABLE_FIELDS[field]) throw new Error(`Field "${field}" is not editable`);
  const { rows } = await pool.query(
    `UPDATE drivers SET ${field} = $1 WHERE id = $2 RETURNING *`,
    [value, driverId]
  );
  return rows[0] || null;
}

async function toggleDriverActive(driverId) {
  const { rows } = await pool.query(
    `UPDATE drivers SET is_active = NOT is_active
     WHERE id = $1 RETURNING id, full_name, is_active`,
    [driverId]
  );
  return rows[0] || null;
}

// Add an incentive bonus to a driver's bonus_balance.
async function addBonusBalance(telegramId, amount) {
  const { rows } = await pool.query(
    `UPDATE drivers SET bonus_balance = bonus_balance + $1
     WHERE telegram_id = $2
     RETURNING id, full_name, bonus_balance`,
    [amount, telegramId]
  );
  return rows[0] || null;
}

async function getActiveDriverTelegramIds() {
  const { rows } = await pool.query(
    'SELECT telegram_id FROM drivers WHERE is_active = true'
  );
  return rows.map(r => r.telegram_id);
}

module.exports = {
  findByTelegramId, createDriver,
  setAvailability, setRoute, clearRoute,
  addBonusBalance,
  getAllDrivers, countDrivers,
  findDriverById, findDriverByPhone,
  updateDriverField, toggleDriverActive,
  getActiveDriverTelegramIds,
};
