require('dotenv').config();

module.exports = {
  telegram: {
    passengerToken: process.env.PASSENGER_BOT_TOKEN,
    driverToken: process.env.DRIVER_BOT_TOKEN,
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'evacuator_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
  },
  google: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  admin: {
    botToken: process.env.ADMIN_BOT_TOKEN,
    telegramId: parseInt(process.env.ADMIN_TELEGRAM_ID, 10),
  },
  app: {
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};
