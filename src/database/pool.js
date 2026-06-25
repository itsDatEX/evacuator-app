const { Pool } = require('pg');
const config = require('../config');
const logger = require('../shared/logger');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

module.exports = pool;
