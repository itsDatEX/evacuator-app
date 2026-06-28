'use strict';

const pool = require('../database/pool');

async function getAdminByTelegramId(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM admins WHERE telegram_id = $1',
    [telegramId]
  );
  return rows[0] || null;
}

async function getAllAdmins() {
  const { rows } = await pool.query(
    'SELECT * FROM admins ORDER BY created_at ASC'
  );
  return rows;
}

async function addAdmin(telegramId, name, role, addedBy) {
  const { rows } = await pool.query(
    `INSERT INTO admins (telegram_id, name, role, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE SET name = $2, role = $3, added_by = $4
     RETURNING *`,
    [telegramId, name || null, role, addedBy]
  );
  return rows[0];
}

async function removeAdmin(telegramId) {
  const { rows } = await pool.query(
    'DELETE FROM admins WHERE telegram_id = $1 RETURNING *',
    [telegramId]
  );
  return rows[0] || null;
}

module.exports = { getAdminByTelegramId, getAllAdmins, addAdmin, removeAdmin };
