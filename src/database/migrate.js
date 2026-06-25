const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const logger = require('../shared/logger');

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    logger.info(`Running migration: ${file}`);
    await pool.query(sql);
    logger.info(`Migration complete: ${file}`);
  }

  await pool.end();
}

runMigrations().catch(err => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
