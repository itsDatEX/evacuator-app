const pool = require('../database/pool');
const { getPricingConfig } = require('./sheets');
const { getBonusEnabled } = require('./configService');

// source: 'telegram' (default) | 'phone' (admin-entered manual order)
// callerPhone: phone number typed by admin for phone orders (null for telegram orders)
async function createOrder({
  passengerId = null,
  pickupLat = null, pickupLng = null, pickupAddress,
  destLat = null,   destLng = null,   destAddress,
  vehicleSize, canRoll, price,
  paymentMethod = 'cash',
  source = 'telegram', callerPhone = null,
  pickupCity = null, destCity = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO orders
       (passenger_id,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat,   dest_lng,   destination_address,
        vehicle_size, can_roll, price, payment_method,
        source, caller_phone,
        pickup_city, dest_city)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      passengerId,
      pickupLat, pickupLng, pickupAddress,
      destLat,   destLng,   destAddress,
      vehicleSize, canRoll, price, paymentMethod,
      source, callerPhone,
      pickupCity, destCity,
    ]
  );
  return rows[0];
}

async function acceptOrder(orderId, driverId) {
  const { rows } = await pool.query(
    `WITH updated AS (
       UPDATE orders SET driver_id = $1, status = 'accepted', accepted_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *
     )
     SELECT u.*, p.telegram_id AS passenger_telegram_id
     FROM updated u
     LEFT JOIN passengers p ON u.passenger_id = p.id`,
    [driverId, orderId]
  );
  return rows[0] || null;
}

async function arriveOrder(orderId, driverId) {
  const { rows } = await pool.query(
    `WITH updated AS (
       UPDATE orders SET status = 'arrived', arrived_at = NOW()
       WHERE id = $1 AND driver_id = $2 AND status = 'accepted'
       RETURNING *
     )
     SELECT u.*,
            p.telegram_id AS passenger_telegram_id,
            p.phone       AS passenger_phone,
            p.full_name   AS passenger_name
     FROM updated u
     LEFT JOIN passengers p ON u.passenger_id = p.id`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

async function startOrder(orderId, driverId) {
  const { rows } = await pool.query(
    `WITH updated AS (
       UPDATE orders SET status = 'in_progress', started_at = NOW()
       WHERE id = $1 AND driver_id = $2 AND status = 'arrived'
       RETURNING *
     )
     SELECT u.*, p.telegram_id AS passenger_telegram_id
     FROM updated u
     LEFT JOIN passengers p ON u.passenger_id = p.id`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

async function completeOrder(orderId, driverId) {
  const { rows } = await pool.query(
    `WITH updated AS (
       UPDATE orders SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND driver_id = $2 AND status = 'in_progress'
       RETURNING *
     )
     SELECT u.*, p.telegram_id AS passenger_telegram_id
     FROM updated u
     LEFT JOIN passengers p ON u.passenger_id = p.id`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

async function cancelOrder(orderId, reason) {
  const { rows } = await pool.query(
    `UPDATE orders SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1
     WHERE id=$2 AND status IN ('pending','accepted') RETURNING *`,
    [reason, orderId]
  );
  return rows[0] || null;
}

// truckType: 'regular' | 'crane'
// regular drivers only see rolling orders; crane drivers see all pending orders.
async function getPendingOrders(truckType) {
  const { rows } = await pool.query(
    `SELECT o.*, p.full_name AS passenger_name, p.phone AS passenger_phone
     FROM orders o LEFT JOIN passengers p ON o.passenger_id = p.id
     WHERE o.status = 'pending'
       AND ($1 = 'crane' OR o.can_roll = true)
     ORDER BY o.created_at ASC`,
    [truckType]
  );
  return rows;
}

async function getOrderById(orderId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  return rows[0] || null;
}

// canRoll:         true → regular+crane; false → crane only
// paymentMethod:   'cash' → exclude drivers with negative balance
// pickupCity/destCity: Nominatim city names (null for phone orders or geocode failure)
// pickupAddress/destAddress: raw address strings (fallback for route matching)
//
// Route matching: a driver with an active route (within 2h window) only sees orders
// where the order's city or address contains the driver's route_from or route_to.
// Drivers without a route (route_from IS NULL) see all eligible orders.
async function getEligibleDrivers(
  canRoll,
  paymentMethod   = 'cash',
  pickupCity      = null,
  destCity        = null,
  pickupAddress   = '',
  destAddress     = '',
) {
  const { rows } = await pool.query(
    `SELECT * FROM drivers
     WHERE is_active    = true
       AND is_available = true
       AND ($1::boolean OR truck_type = 'crane')
       AND NOT ($2::text = 'cash' AND balance < 0)
       AND (
         -- No active route: sees all eligible orders
         route_from IS NULL
         OR route_departure_at <= NOW() - INTERVAL '2 hours'
         -- Active route: order must touch the driver's route cities
         OR (
           route_departure_at > NOW() - INTERVAL '2 hours'
           AND (
             ($3::text IS NOT NULL AND ($3::text ILIKE '%' || route_from || '%' OR $3::text ILIKE '%' || route_to || '%'))
             OR ($4::text IS NOT NULL AND ($4::text ILIKE '%' || route_from || '%' OR $4::text ILIKE '%' || route_to || '%'))
             OR COALESCE($5::text, '') ILIKE '%' || route_from || '%'
             OR COALESCE($5::text, '') ILIKE '%' || route_to   || '%'
             OR COALESCE($6::text, '') ILIKE '%' || route_from || '%'
             OR COALESCE($6::text, '') ILIKE '%' || route_to   || '%'
           )
         )
       )`,
    [canRoll, paymentMethod, pickupCity, destCity, pickupAddress, destAddress]
  );
  return rows;
}

// Settle earnings/commission after an order completes.
// Runs in a transaction: updates driver.balance, stores commission_amount on order,
// and conditionally awards a bonus if the milestone is reached.
async function settleOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND status = $2',
      [orderId, 'completed']
    );
    if (!order) { await client.query('ROLLBACK'); return null; }

    const cfg          = await getPricingConfig();
    const bonusEnabled = await getBonusEnabled();
    const price        = parseFloat(order.price);
    const commission   = Math.round(price * cfg.commissionRate * 100) / 100;

    // card: driver receives net fare; cash: driver owes commission to company
    const balanceDelta = order.payment_method === 'card'
      ? Math.round((price - commission) * 100) / 100
      : -commission;

    await client.query(
      'UPDATE drivers SET balance = balance + $1 WHERE id = $2',
      [balanceDelta, order.driver_id]
    );
    await client.query(
      'UPDATE orders SET commission_amount = $1 WHERE id = $2',
      [commission, orderId]
    );

    // Milestone bonus: every Nth completed order earns bonus_amount
    if (bonusEnabled && cfg.bonusThreshold > 0) {
      const { rows: [{ cnt }] } = await client.query(
        `SELECT COUNT(*) AS cnt FROM orders
         WHERE driver_id = $1 AND status = 'completed'`,
        [order.driver_id]
      );
      if (parseInt(cnt, 10) % cfg.bonusThreshold === 0) {
        await client.query(
          'UPDATE drivers SET bonus_balance = bonus_balance + $1 WHERE id = $2',
          [cfg.bonusAmount, order.driver_id]
        );
      }
    }

    await client.query('COMMIT');
    return { commission, balanceDelta };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Admin: all active drivers sorted by balance ascending (negative/debtor first).
async function getDriverBalances() {
  const { rows } = await pool.query(`
    SELECT
      d.id, d.full_name, d.phone, d.telegram_id, d.truck_type,
      d.balance, d.bonus_balance,
      COUNT(w.id)              AS withdrawal_count,
      COALESCE(SUM(w.amount), 0) AS total_withdrawn
    FROM drivers d
    LEFT JOIN withdrawals w ON w.driver_id = d.id
    WHERE d.is_active = true
    GROUP BY d.id
    ORDER BY d.balance ASC
  `);
  return rows;
}

// Admin: record a withdrawal; decrements driver.balance atomically.
// method: 'cash' | 'card'
// adminInfo: { telegramId, name, phone }
async function recordWithdrawal(driverId, amount, method, adminInfo = {}) {
  const {
    telegramId: adminTelegramId = null,
    name:       adminName       = null,
    phone:      adminPhone      = null,
  } = adminInfo;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO withdrawals
         (driver_id, amount, method, admin_telegram_id, admin_name, admin_phone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [driverId, amount, method || 'cash', adminTelegramId, adminName, adminPhone]
    );
    await client.query(
      'UPDATE drivers SET balance = balance - $1 WHERE id = $2',
      [amount, driverId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const WD_PERIOD_SQL = {
  today: `w.created_at >= CURRENT_DATE`,
  week:  `w.created_at >= date_trunc('week',  NOW())`,
  month: `w.created_at >= date_trunc('month', NOW())`,
  all:   `TRUE`,
};

async function getAllWithdrawals(period = 'all', offset = 0) {
  const where = WD_PERIOD_SQL[period] || WD_PERIOD_SQL.all;
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT
         w.id, w.created_at, w.amount, w.method,
         w.admin_name, w.admin_phone,
         d.full_name AS driver_name, d.phone AS driver_phone
       FROM withdrawals w
       JOIN drivers d ON w.driver_id = d.id
       WHERE ${where}
       ORDER BY w.created_at DESC
       LIMIT 10 OFFSET $1`,
      [offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM withdrawals w
       JOIN drivers d ON w.driver_id = d.id
       WHERE ${where}`
    ),
  ]);
  return { rows, total: parseInt(cnt[0].total, 10) };
}

async function getPassengerOrderHistory(passengerId) {
  const { rows } = await pool.query(`
    SELECT
      o.id, o.created_at, o.status, o.price, o.payment_method,
      o.pickup_address, o.destination_address,
      d.full_name AS driver_name
    FROM orders o
    LEFT JOIN drivers d ON o.driver_id = d.id
    WHERE o.passenger_id = $1
    ORDER BY o.created_at DESC
    LIMIT 20
  `, [passengerId]);
  return rows;
}

async function getDriverWithdrawalHistory(driverId) {
  const { rows } = await pool.query(`
    SELECT id, amount, method, note, created_at
    FROM withdrawals
    WHERE driver_id = $1
    ORDER BY created_at DESC
    LIMIT 30
  `, [driverId]);
  return rows;
}

async function getDriverWithdrawalsToday(driverId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_today
     FROM withdrawals
     WHERE driver_id = $1
       AND created_at >= CURRENT_DATE`,
    [driverId]
  );
  return parseFloat(rows[0].total_today);
}

async function recordSelfWithdrawal(driverId, amount, commission) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO withdrawals (driver_id, amount, method, source)
       VALUES ($1, $2, 'card', 'driver_self')`,
      [driverId, amount]
    );
    await client.query(
      'UPDATE drivers SET balance = balance - $1 WHERE id = $2',
      [amount + commission, driverId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Rate the driver after a completed order (called by the passenger).
async function rateDriver(orderId, passengerId, rating) {
  const { rows } = await pool.query(
    `UPDATE orders SET driver_rating=$1
     WHERE id=$2 AND passenger_id=$3 AND status='completed' AND driver_rating IS NULL
     RETURNING id`,
    [rating, orderId, passengerId]
  );
  return rows[0] || null;
}

// Rate the passenger after a completed order (called by the driver).
async function ratePassenger(orderId, driverId, rating) {
  const { rows } = await pool.query(
    `UPDATE orders SET passenger_rating=$1
     WHERE id=$2 AND driver_id=$3 AND status='completed' AND passenger_rating IS NULL
     RETURNING id`,
    [rating, orderId, driverId]
  );
  return rows[0] || null;
}

// Passenger history: what the passenger is allowed to see about their own orders.
// Includes the rating THEY gave the driver, but never the rating the driver gave them.
async function getPassengerHistory(passengerId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       o.id,
       o.created_at,
       o.pickup_address,
       o.destination_address,
       o.price,
       o.status,
       o.driver_rating       AS my_rating_for_driver,
       d.full_name           AS driver_name
     FROM orders o
     LEFT JOIN drivers d ON o.driver_id = d.id
     WHERE o.passenger_id = $1
       AND o.status IN ('completed', 'cancelled')
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3`,
    [passengerId, limit, offset]
  );
  return rows;
}

// Driver history: aggregate view — driver sees average rating they received,
// never which passenger gave which score.
async function getDriverHistory(driverId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       o.id,
       o.created_at,
       o.pickup_address,
       o.destination_address,
       o.price,
       o.status,
       o.driver_rating       AS received_rating
     FROM orders o
     WHERE o.driver_id = $1
       AND o.status IN ('completed', 'cancelled')
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3`,
    [driverId, limit, offset]
  );
  return rows;
}

// Driver aggregate stats: average rating and total completed rides.
async function getDriverStats(driverId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                              AS total_completed,
       ROUND(AVG(driver_rating)::NUMERIC, 2) AS avg_rating,
       COUNT(driver_rating)                  AS rated_count
     FROM orders
     WHERE driver_id = $1 AND status = 'completed'`,
    [driverId]
  );
  return rows[0];
}

// Admin history: full visibility — who rated whom, every score, and order source.
// status: null=all | 'completed' | 'cancelled' | 'pending' | 'active' (accepted+arrived+in_progress)
// days:   null=all time | N=last N days
async function getAdminHistory({ status = null, days = null, limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       o.id,
       o.uuid,
       o.created_at,
       o.pickup_address,
       o.destination_address,
       o.price,
       o.status,
       o.cancel_reason,
       o.source,
       o.caller_phone,
       o.driver_rating,
       o.passenger_rating,
       p.id           AS passenger_id,
       p.full_name    AS passenger_name,
       p.phone        AS registered_phone,
       p.telegram_id  AS passenger_telegram_id,
       d.id           AS driver_id,
       d.full_name    AS driver_name,
       d.phone        AS driver_phone,
       d.telegram_id  AS driver_telegram_id,
       d.car_model,
       d.car_plate
     FROM orders o
     LEFT JOIN passengers p ON o.passenger_id = p.id
     LEFT JOIN drivers    d ON o.driver_id    = d.id
     WHERE (
       $1::text IS NULL
       OR ($1 = 'active'  AND o.status IN ('accepted', 'arrived', 'in_progress'))
       OR ($1 != 'active' AND o.status = $1::text)
     )
     AND ($2::int IS NULL OR o.created_at > NOW() - INTERVAL '1 day' * $2)
     ORDER BY o.created_at DESC
     LIMIT $3 OFFSET $4`,
    [status, days, limit, offset]
  );
  return rows;
}

async function getCompletedOrdersForExport(from, to) {
  const { rows } = await pool.query(`
    SELECT
      o.id, o.created_at,
      o.pickup_address, o.destination_address,
      o.price, o.commission_amount, o.payment_method,
      o.source, o.caller_phone,
      p.full_name AS passenger_name, p.phone AS passenger_phone,
      d.full_name AS driver_name,   d.phone AS driver_phone
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers    d ON o.driver_id    = d.id
    WHERE o.status = 'completed'
      AND o.created_at >= $1 AND o.created_at < $2
    ORDER BY o.created_at ASC
  `, [from, to]);
  return rows;
}

// ── Rating queries ────────────────────────────────────────────────────────────

async function getDriverRatings() {
  const { rows } = await pool.query(`
    SELECT
      d.id, d.full_name, d.phone,
      COUNT(o.driver_rating)::int                AS rated_count,
      ROUND(AVG(o.driver_rating)::NUMERIC, 2)    AS avg_rating
    FROM drivers d
    LEFT JOIN orders o ON o.driver_id = d.id
      AND o.status = 'completed' AND o.driver_rating IS NOT NULL
    WHERE d.is_active = true
    GROUP BY d.id
    HAVING COUNT(o.driver_rating) >= 1
    ORDER BY avg_rating ASC, rated_count DESC
  `);
  return rows;
}

async function getDriverRatingHistory(driverId) {
  const { rows } = await pool.query(`
    SELECT
      o.id, o.driver_rating, o.created_at,
      o.pickup_address, o.destination_address,
      p.full_name AS passenger_name,
      p.phone     AS passenger_phone
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    WHERE o.driver_id = $1 AND o.driver_rating IS NOT NULL
    ORDER BY o.created_at DESC
    LIMIT 10
  `, [driverId]);
  return rows;
}

async function getPassengerRatings() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.full_name, p.phone,
      COUNT(o.passenger_rating)::int              AS rated_count,
      ROUND(AVG(o.passenger_rating)::NUMERIC, 2)  AS avg_rating
    FROM passengers p
    LEFT JOIN orders o ON o.passenger_id = p.id
      AND o.status = 'completed' AND o.passenger_rating IS NOT NULL
    GROUP BY p.id
    HAVING COUNT(o.passenger_rating) >= 1
    ORDER BY avg_rating ASC, rated_count DESC
  `);
  return rows;
}

async function getPassengerRatingHistory(passengerId) {
  const { rows } = await pool.query(`
    SELECT
      o.id, o.passenger_rating, o.created_at,
      o.pickup_address, o.destination_address,
      p.full_name AS passenger_name,
      p.phone     AS passenger_phone,
      d.full_name AS driver_name,
      d.phone     AS driver_phone
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers    d ON o.driver_id    = d.id
    WHERE o.passenger_id = $1 AND o.passenger_rating IS NOT NULL
    ORDER BY o.created_at DESC
    LIMIT 10
  `, [passengerId]);
  return rows;
}

async function getPassengerOrderStats(passengerId) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                     AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
    FROM orders WHERE passenger_id = $1
  `, [passengerId]);
  return rows[0];
}

async function getPassengerStats(passengerId) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                      AS total_completed,
      ROUND(AVG(passenger_rating)::NUMERIC, 2)      AS avg_rating,
      COUNT(passenger_rating)::int                  AS rated_count
    FROM orders
    WHERE passenger_id = $1 AND status = 'completed'
  `, [passengerId]);
  return rows[0];
}

// Admin: live snapshot of pending + active orders with elapsed-time fields.
// tab: 'pending' | 'active' | 'alerts'
async function getActiveOrders(tab) {
  const pendingQ = () => pool.query(`
    SELECT
      o.id, o.created_at, o.status,
      o.pickup_address, o.destination_address,
      o.price, o.vehicle_size, o.can_roll,
      o.source, o.caller_phone,
      p.full_name AS passenger_name,
      p.phone     AS passenger_phone,
      ROUND(EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60)::int AS minutes_waiting,
      NULL::int   AS minutes_since_accepted,
      NULL::text  AS driver_name,
      NULL::text  AS driver_phone
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    WHERE o.status = 'pending'
    ORDER BY o.created_at ASC
  `);

  const activeQ = () => pool.query(`
    SELECT
      o.id, o.created_at, o.status,
      o.pickup_address, o.destination_address,
      o.price, o.vehicle_size, o.can_roll,
      o.source, o.caller_phone,
      p.full_name AS passenger_name,
      p.phone     AS passenger_phone,
      NULL::int   AS minutes_waiting,
      ROUND(EXTRACT(EPOCH FROM (NOW() - o.accepted_at)) / 60)::int AS minutes_since_accepted,
      d.full_name AS driver_name,
      d.phone     AS driver_phone
    FROM orders o
    LEFT JOIN passengers p ON o.passenger_id = p.id
    LEFT JOIN drivers    d ON o.driver_id    = d.id
    WHERE o.status IN ('accepted', 'arrived', 'in_progress')
    ORDER BY o.accepted_at ASC NULLS LAST
  `);

  if (tab === 'pending') { const { rows } = await pendingQ(); return rows; }
  if (tab === 'active')  { const { rows } = await activeQ();  return rows; }

  if (tab === 'alerts') {
    const [{ rows: pending }, { rows: active }] = await Promise.all([
      pool.query(`
        SELECT
          o.id, o.created_at, o.status,
          o.pickup_address, o.destination_address,
          o.price, o.vehicle_size, o.can_roll,
          o.source, o.caller_phone,
          p.full_name AS passenger_name,
          p.phone     AS passenger_phone,
          ROUND(EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60)::int AS minutes_waiting,
          NULL::int  AS minutes_since_accepted,
          NULL::text AS driver_name,
          NULL::text AS driver_phone
        FROM orders o
        LEFT JOIN passengers p ON o.passenger_id = p.id
        WHERE o.status = 'pending'
          AND o.created_at < NOW() - INTERVAL '10 minutes'
        ORDER BY o.created_at ASC
      `),
      pool.query(`
        SELECT
          o.id, o.created_at, o.status,
          o.pickup_address, o.destination_address,
          o.price, o.vehicle_size, o.can_roll,
          o.source, o.caller_phone,
          p.full_name AS passenger_name,
          p.phone     AS passenger_phone,
          NULL::int   AS minutes_waiting,
          ROUND(EXTRACT(EPOCH FROM (NOW() - o.accepted_at)) / 60)::int AS minutes_since_accepted,
          d.full_name AS driver_name,
          d.phone     AS driver_phone
        FROM orders o
        LEFT JOIN passengers p ON o.passenger_id = p.id
        LEFT JOIN drivers    d ON o.driver_id    = d.id
        WHERE o.status = 'accepted'
          AND o.accepted_at < NOW() - INTERVAL '30 minutes'
        ORDER BY o.accepted_at ASC NULLS LAST
      `),
    ]);
    return [...pending, ...active];
  }

  return [];
}

// Source breakdown statistics for admin dashboard.
async function getOrderStats({ days = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       source,
       COUNT(*)                                                             AS total,
       COUNT(*) FILTER (WHERE status = 'completed')                        AS completed,
       COUNT(*) FILTER (WHERE status = 'cancelled')                        AS cancelled,
       COUNT(*) FILTER (WHERE status = 'pending')                          AS pending,
       ROUND(AVG(price) FILTER (WHERE status = 'completed')::NUMERIC, 2)   AS avg_price,
       COALESCE(
         ROUND(SUM(price) FILTER (WHERE status = 'completed')::NUMERIC, 2),
       0)                                                                   AS total_revenue,
       COALESCE(
         ROUND(SUM(commission_amount) FILTER (WHERE status = 'completed')::NUMERIC, 2),
       0)                                                                   AS company_revenue,
       COALESCE(
         ROUND(SUM(COALESCE(price,0) - COALESCE(commission_amount,0))
               FILTER (WHERE status = 'completed')::NUMERIC, 2),
       0)                                                                   AS driver_earnings
     FROM orders
     WHERE created_at > NOW() - INTERVAL '1 day' * $1
     GROUP BY source
     ORDER BY source`,
    [days]
  );
  return rows;
}

module.exports = {
  createOrder,
  getEligibleDrivers,
  acceptOrder,
  arriveOrder,
  startOrder,
  completeOrder,
  cancelOrder,
  getPendingOrders,
  getOrderById,
  rateDriver,
  ratePassenger,
  getPassengerHistory,
  getDriverHistory,
  getDriverStats,
  getAdminHistory,
  getActiveOrders,
  getOrderStats,
  settleOrder,
  getDriverBalances,
  recordWithdrawal,
  getDriverRatings,
  getDriverRatingHistory,
  getPassengerRatings,
  getPassengerRatingHistory,
  getPassengerStats,
  getPassengerOrderStats,
  getCompletedOrdersForExport,
  getAllWithdrawals,
  getPassengerOrderHistory,
  getDriverWithdrawalHistory,
  getDriverWithdrawalsToday,
  recordSelfWithdrawal,
};
