const notifier = require('./shared/notifier');

const driverBot    = require('./bot-driver');
const passengerBot = require('./bot-passenger');
const adminBot     = require('./bot-admin');     // eslint-disable-line no-unused-vars

notifier.setDriverBot(driverBot);
notifier.setPassengerBot(passengerBot);

const logger = require('./shared/logger');
logger.info('Evacuator app started — passenger, driver, and admin bots running');
