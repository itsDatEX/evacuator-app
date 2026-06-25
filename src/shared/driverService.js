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

module.exports = {
  findByTelegramId, createDriver,
  setAvailability, setRoute, clearRoute,
  addBonusBalance,
};
