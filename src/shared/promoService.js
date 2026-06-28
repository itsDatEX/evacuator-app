'use strict';
const pool = require('../database/pool');

async function validatePromoCode(code, passengerId) {
  const { rows } = await pool.query(
    `SELECT pc.* FROM promo_codes pc
     WHERE pc.code = $1
       AND pc.is_active = true
       AND pc.used_count < pc.max_uses
       AND NOT EXISTS (
         SELECT 1 FROM promo_code_usages pcu
         WHERE pcu.promo_code_id = pc.id AND pcu.passenger_id = $2
       )`,
    [code.trim().toUpperCase(), passengerId]
  );
  return rows[0] || null;
}

async function applyPromoCode(codeId, passengerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1',
      [codeId]
    );
    await client.query(
      'INSERT INTO promo_code_usages (promo_code_id, passenger_id) VALUES ($1, $2)',
      [codeId, passengerId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createPromoCode(code, discountAmount, maxUses = 1) {
  const { rows } = await pool.query(
    `INSERT INTO promo_codes (code, discount_amount, max_uses)
     VALUES ($1, $2, $3) RETURNING *`,
    [code.trim().toUpperCase(), discountAmount, maxUses]
  );
  return rows[0];
}

async function getActivePromoCodes() {
  const { rows } = await pool.query(
    'SELECT * FROM promo_codes WHERE is_active = true ORDER BY created_at DESC'
  );
  return rows;
}

async function deactivatePromoCode(codeId) {
  const { rows } = await pool.query(
    'UPDATE promo_codes SET is_active = false WHERE id = $1 RETURNING *',
    [codeId]
  );
  return rows[0] || null;
}

module.exports = {
  validatePromoCode, applyPromoCode,
  createPromoCode, getActivePromoCodes, deactivatePromoCode,
};
