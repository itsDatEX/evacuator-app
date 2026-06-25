const logger = require('./logger');

let _driverBot    = null;
let _passengerBot = null;

// orderId → Map(driverTelegramId → messageId)
// Lets notifyDriversOrderTaken clear stale accept buttons from other drivers' chats.
const _orderMsgIds = new Map();

function setDriverBot(bot)    { _driverBot = bot; }
function setPassengerBot(bot) { _passengerBot = bot; }

// Called after a new order is created (by passenger bot or admin bot).
// draft: session.order snapshot — has pickupAddress, destAddress, distanceKm,
//        vehicleSize, canRoll, price, and optionally callerPhone (phone orders).
async function notifyDriversOfNewOrder(order, drivers, draft) {
  logger.info('notifyDriversOfNewOrder called', {
    orderId:            order.id,
    driverBotReady:     !!_driverBot,
    eligibleDriverCount: drivers.length,
    driverTelegramIds:  drivers.map(d => d.telegram_id),
  });

  if (!_driverBot) {
    logger.warn('notifyDriversOfNewOrder: driverBot not set — skipping');
    return;
  }
  if (!drivers.length) {
    logger.warn('notifyDriversOfNewOrder: no eligible drivers — skipping', {
      orderId: order.id,
    });
    return;
  }

  const sizeLabel = draft.vehicleSize === 'large' ? '🚌 დიდი' : '🚗 ჩვეულებრივი';
  const rollLabel = draft.canRoll ? '✅ გორავს' : '❌ არ გორავს (ამწე)';
  const sourceTag = order.source === 'phone' ? '📞 ტელეფონით' : '📱 ბოტიდან';
  const phoneInfo = order.source === 'phone' && order.caller_phone
    ? `\n📱 მგზავრის ნომერი: ${order.caller_phone}` : '';

  const text =
    `🔔 *ახალი შეკვეთა #${order.id}* (${sourceTag})\n\n` +
    `📍 საიდან: ${draft.pickupAddress}\n` +
    `🏁 სად: ${draft.destAddress}\n` +
    `📏 მანძილი: ~${draft.distanceKm} კმ\n` +
    `${sizeLabel} | ${rollLabel}${phoneInfo}\n` +
    `💰 ფასი: ${order.price} ₾`;

  const msgMap = new Map();
  for (const driver of drivers) {
    try {
      logger.info('Sending new-order notification', {
        orderId:    order.id,
        driverId:   driver.id,
        telegramId: driver.telegram_id,
      });
      const sent = await _driverBot.sendMessage(driver.telegram_id, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ შეკვეთის მიღება', callback_data: `accept:${order.id}` },
            { text: '⏭ გამოტოვება',      callback_data: `skip:${order.id}` },
          ]],
        },
      });
      msgMap.set(driver.telegram_id, sent.message_id);
    } catch (err) {
      logger.warn('Could not notify driver', { driverId: driver.id, error: err.message });
    }
  }
  _orderMsgIds.set(order.id, msgMap);
}

// Called when a driver accepts an order — tell the passenger their driver is coming.
// Only sent for telegram orders (phone orders have no Telegram passenger).
async function notifyPassengerOrderAccepted(order, driver, passengerTelegramId) {
  if (!_passengerBot || !passengerTelegramId) return;
  try {
    await _passengerBot.sendMessage(
      passengerTelegramId,
      `🚗 *მძღოლი გამოემგზავრა!*\n\n` +
      `👤 ${driver.full_name}\n` +
      `📱 ${driver.phone}\n` +
      `🚙 ${driver.car_model || '—'}  |  ${driver.car_plate || '—'}\n\n` +
      `შეკვეთა #${order.id}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.warn('Could not notify passenger of acceptance', { error: err.message });
  }
}

// Called when a driver accepts an order — tell all other eligible drivers it's gone.
async function notifyDriversOrderTaken(orderId, acceptingDriverTelegramId, eligibleDrivers) {
  if (!_driverBot) return;

  const msgMap = _orderMsgIds.get(orderId) || new Map();

  for (const driver of eligibleDrivers) {
    if (driver.telegram_id === acceptingDriverTelegramId) continue;
    try {
      const origMsgId = msgMap.get(driver.telegram_id);
      if (origMsgId) {
        await _driverBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id:    driver.telegram_id,
          message_id: origMsgId,
        }).catch(() => {});
      }
      await _driverBot.sendMessage(
        driver.telegram_id,
        `ℹ️ შეკვეთა #${orderId} უკვე სხვა მძღოლმა აიღო.`
      );
    } catch (err) {
      logger.warn('Could not send order-taken notice', { driverId: driver.id, error: err.message });
    }
  }

  _orderMsgIds.delete(orderId);
}

module.exports = {
  setDriverBot,
  setPassengerBot,
  notifyDriversOfNewOrder,
  notifyPassengerOrderAccepted,
  notifyDriversOrderTaken,
};
