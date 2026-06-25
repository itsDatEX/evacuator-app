'use strict';

const { TelegramBot } = require('node-telegram-bot-api');
const config      = require('../config');
const logger      = require('../shared/logger');
const {
  STEPS, getSession, setStep,
  updateOrder, updateBonus, updateWd,
  clearOrder, clearBonus, clearWd,
} = require('./sessions');
const { createOrder, getOrderStats, getAdminHistory, getEligibleDrivers, getDriverBalances, recordWithdrawal } = require('../shared/orderService');
const { calculatePrice, getPricingConfig }  = require('../shared/sheets');
const { addDiscount }                       = require('../shared/passengerService');
const { addBonusBalance }                   = require('../shared/driverService');
const { getBonusEnabled, toggleBonusEnabled } = require('../shared/configService');
const notifier = require('../shared/notifier');

const bot = new TelegramBot(config.admin.botToken, { polling: true });

// ── Auth guard ────────────────────────────────────────────────────────────────

function isAdmin(from) { return from?.id === config.admin.telegramId; }

function guard(handler) {
  return async (msg, ...rest) => {
    if (!isAdmin(msg.from)) return;
    return handler(msg, ...rest);
  };
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function mainMenu() {
  return {
    keyboard: [
      [{ text: '📞 ახალი შეკვეთა (ტელეფონი)' }],
      [{ text: '📊 სტატისტიკა' },    { text: '📋 ბოლო შეკვეთები' }],
      [{ text: '🎁 ბონუსები' },       { text: '💰 ბალანსები' }],
    ],
    resize_keyboard: true,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidPhone(text) {
  return (text.replace(/[\s\-().+]/g, '').match(/\d/g) || []).length >= 6;
}

function parseAmount(text) {
  const n = parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// ── /start ────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, guard(async (msg) => {
  setStep(msg.chat.id, STEPS.IDLE);
  await bot.sendMessage(msg.chat.id, '👋 Admin panel:', { reply_markup: mainMenu() });
}));

bot.onText(/\/cancel/, guard((msg) => {
  clearOrder(msg.chat.id);
  clearBonus(msg.chat.id);
  clearWd(msg.chat.id);
  bot.sendMessage(msg.chat.id, '↩️ გაუქმდა.', { reply_markup: mainMenu() });
}));

// ── Message router ────────────────────────────────────────────────────────────

bot.on('message', guard(async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text?.startsWith('/')) return;
  const { step } = getSession(chatId);

  try {
    switch (step) {
      case STEPS.IDLE:
        if      (msg.text === '📞 ახალი შეკვეთა (ტელეფონი)') await startOrder(chatId);
        else if (msg.text === '📊 სტატისტიკა')               await showStats(chatId);
        else if (msg.text === '📋 ბოლო შეკვეთები')           await showHistory(chatId);
        else if (msg.text === '🎁 ბონუსები')                  await showBonusMenu(chatId);
        else if (msg.text === '💰 ბალანსები')                 await showBalanceMenu(chatId);
        break;
      // Order flow
      case STEPS.AWAIT_PHONE:    await onPhone(chatId, msg.text);    break;
      case STEPS.AWAIT_PICKUP:   await onPickup(chatId, msg.text);   break;
      case STEPS.AWAIT_DEST:     await onDest(chatId, msg.text);     break;
      case STEPS.AWAIT_DISTANCE: await onDistance(chatId, msg.text); break;
      // Bonus flow
      case STEPS.AWAIT_BONUS_DRIVER_ID: await onBonusDriverId(chatId, msg.text); break;
      case STEPS.AWAIT_BONUS_AMOUNT:    await onBonusAmount(chatId, msg.text);   break;
      case STEPS.AWAIT_DISC_PASS_ID:    await onDiscPassId(chatId, msg.text);    break;
      case STEPS.AWAIT_DISC_AMOUNT:     await onDiscAmount(chatId, msg.text);    break;
      // Withdrawal flow
      case STEPS.AWAIT_WD_DRIVER_ID: await onWdDriverId(chatId, msg.text); break;
      case STEPS.AWAIT_WD_AMOUNT:    await onWdAmount(chatId, msg.text);   break;
      case STEPS.AWAIT_WD_NOTE:      await onWdNote(chatId, msg.text);     break;
      default: break;
    }
  } catch (err) {
    logger.error('Admin bot error', { chatId, step, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /cancel.');
  }
}));

// ── Callback router ───────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  if (!isAdmin(query.from)) return bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const { step } = getSession(chatId);
  const data = query.data;

  try {
    if      (data.startsWith('adm_vsize:')   && step === STEPS.AWAIT_VSIZE)   await onVsize(query);
    else if (data.startsWith('adm_canroll:') && step === STEPS.AWAIT_CANROLL) await onCanRoll(query);
    else if (data.startsWith('adm_pay:')     && step === STEPS.AWAIT_PAYMENT) await onPayment(query);
    else if ((data === 'adm_confirm' || data === 'adm_cancel') && step === STEPS.AWAIT_CONFIRM) await onConfirm(query);
    else if (data === 'adm_bonus_toggle')    await onBonusToggle(query);
    else await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error('Admin callback error', { chatId, data, error: err.message });
    await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა. /cancel' });
  }
});

// ══ ORDER FLOW ════════════════════════════════════════════════════════════════

async function startOrder(chatId) {
  clearOrder(chatId);
  setStep(chatId, STEPS.AWAIT_PHONE);
  return bot.sendMessage(chatId,
    '📞 *ახალი ტელეფონური შეკვეთა*\n\n1/7 — მგზავრის ტელეფონი:',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
}

async function onPhone(chatId, text) {
  if (!text || !isValidPhone(text))
    return bot.sendMessage(chatId, '⚠️ მინიმუმ 6 ციფრი. სცადეთ ხელახლა:');
  updateOrder(chatId, { callerPhone: text.trim() });
  setStep(chatId, STEPS.AWAIT_PICKUP);
  return bot.sendMessage(chatId, '2/7 — *საიდან* (მისამართი):', { parse_mode: 'Markdown' });
}

async function onPickup(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ვერ ამოიკითხა. სცადეთ:');
  updateOrder(chatId, { pickupAddress: text.trim() });
  setStep(chatId, STEPS.AWAIT_DEST);
  return bot.sendMessage(chatId, '3/7 — *სად* (მისამართი):', { parse_mode: 'Markdown' });
}

async function onDest(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ვერ ამოიკითხა. სცადეთ:');
  updateOrder(chatId, { destAddress: text.trim() });
  setStep(chatId, STEPS.AWAIT_DISTANCE);
  return bot.sendMessage(chatId, '4/7 — *მანძილი კმ-ებში*:', { parse_mode: 'Markdown' });
}

async function onDistance(chatId, text) {
  const km = parseAmount(text);
  if (!km) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი (მაგ. 12 ან 7.5):');
  updateOrder(chatId, { distanceKm: km });
  setStep(chatId, STEPS.AWAIT_VSIZE);
  return bot.sendMessage(chatId, '5/7 — *მანქანის ტიპი:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '🚗 ჩვეულებრივი', callback_data: 'adm_vsize:normal' },
      { text: '🚌 დიდი',         callback_data: 'adm_vsize:large'  },
    ]] },
  });
}

async function onVsize(query) {
  const chatId = query.message.chat.id;
  const vehicleSize = query.data.split(':')[1];
  updateOrder(chatId, { vehicleSize });
  setStep(chatId, STEPS.AWAIT_CANROLL);
  await bot.answerCallbackQuery(query.id);
  const label = vehicleSize === 'large' ? '🚌 დიდი' : '🚗 ჩვეულებრივი';
  return bot.sendMessage(chatId, `✅ ${label}\n\n6/7 — *გორავს მანქანა?*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ კი, გორავს', callback_data: 'adm_canroll:true'  },
      { text: '❌ არ გორავს',  callback_data: 'adm_canroll:false' },
    ]] },
  });
}

async function onCanRoll(query) {
  const chatId  = query.message.chat.id;
  const canRoll = query.data.split(':')[1] === 'true';
  const { order } = getSession(chatId);

  let priceResult;
  try {
    priceResult = await calculatePrice(order.distanceKm, order.vehicleSize, canRoll);
  } catch (err) {
    logger.error('calculatePrice failed in admin bot', { error: err.message });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '❌ ფასის გამოთვლა ვერ მოხდა (Sheets). /cancel');
  }

  updateOrder(chatId, { canRoll, price: priceResult.total, breakdown: priceResult.breakdown });
  setStep(chatId, STEPS.AWAIT_PAYMENT);
  await bot.answerCallbackQuery(query.id);

  const bd        = priceResult.breakdown;
  const { order: o } = getSession(chatId);
  const sizeLabel = o.vehicleSize === 'large' ? '🚌 დიდი' : '🚗 ჩვეულებრივი';
  const rollLabel = canRoll ? '✅ გორავს' : '❌ არ გორავს';
  const extras    = [
    bd.size_fee  > 0 && `  მსხვილი: +${bd.size_fee} ₾`,
    bd.crane_fee > 0 && `  ამწე: +${bd.crane_fee} ₾`,
  ].filter(Boolean).join('\n') || '  —';

  return bot.sendMessage(chatId,
    `💰 *ფასი*\n  საბაზო: ${bd.base_fare} ₾\n  მანძილი: ${bd.distance_fee} ₾\n  დამატ.:\n${extras}\n  ─────\n  *სულ: ${priceResult.total} ₾*\n\n7/7 — *გადახდის მეთოდი:*`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '💳 ბარათით', callback_data: 'adm_pay:card' },
        { text: '💵 ნაღდით',  callback_data: 'adm_pay:cash' },
      ]] },
    }
  );
}

async function onPayment(query) {
  const chatId        = query.message.chat.id;
  const paymentMethod = query.data.split(':')[1];
  const { order: o }  = getSession(chatId);
  updateOrder(chatId, { paymentMethod });
  setStep(chatId, STEPS.AWAIT_CONFIRM);
  await bot.answerCallbackQuery(query.id);

  const payLabel = paymentMethod === 'card' ? '💳 ბარათით' : '💵 ნაღდით';
  return bot.sendMessage(chatId,
    `📋 *შეჯამება*\n📱 ${o.callerPhone}\n📍 ${o.pickupAddress}\n🏁 ${o.destAddress}\n💰 *${o.price} ₾*  |  ${payLabel}\n\nდაადასტუროთ?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ შექმნა',   callback_data: 'adm_confirm' },
        { text: '❌ გაუქმება', callback_data: 'adm_cancel'  },
      ]] },
    }
  );
}

async function onConfirm(query) {
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  if (query.data === 'adm_cancel') {
    clearOrder(chatId);
    return bot.sendMessage(chatId, '↩️ გაუქმდა.', { reply_markup: mainMenu() });
  }

  const draft = { ...getSession(chatId).order };
  const newOrder = await createOrder({
    passengerId:   null,
    callerPhone:   draft.callerPhone,
    pickupAddress: draft.pickupAddress,
    destAddress:   draft.destAddress,
    vehicleSize:   draft.vehicleSize,
    canRoll:       draft.canRoll,
    price:         draft.price,
    paymentMethod: draft.paymentMethod,
    source:        'phone',
  });

  clearOrder(chatId);
  await bot.sendMessage(chatId,
    `✅ *შეკვეთა #${newOrder.id} შეიქმნა!*\n📞 ${draft.callerPhone} | 💰 ${newOrder.price} ₾`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );

  const eligibleDrivers = await getEligibleDrivers(
    draft.canRoll,
    draft.paymentMethod,
    null,                // phone orders have no GPS city
    null,
    draft.pickupAddress,
    draft.destAddress,
  );
  await notifier.notifyDriversOfNewOrder(newOrder, eligibleDrivers, draft);

  if (!eligibleDrivers.length)
    bot.sendMessage(chatId, '⚠️ ხელმისაწვდომი მძღოლი ვერ მოიძებნა.');
}

// ══ STATS / HISTORY ══════════════════════════════════════════════════════════

async function showStats(chatId) {
  const rows = await getOrderStats({ days: 30 });
  if (!rows.length) return bot.sendMessage(chatId, '📊 ბოლო 30 დღე — შეკვეთები არ ყოფილა.');
  const lines = rows.map(r => {
    const src = r.source === 'phone' ? '📞 ტელეფონი' : '📱 ბოტი';
    return `${src}\n  სულ: ${r.total}  ✅ ${r.completed}  ❌ ${r.cancelled}  ⏳ ${r.pending}\n  საშ: ${r.avg_price || '—'} ₾  |  შემოს: ${r.total_revenue} ₾`;
  });
  return bot.sendMessage(chatId, `📊 *ბოლო 30 დღე*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
}

async function showHistory(chatId) {
  const history = await getAdminHistory({ limit: 15 });
  if (!history.length) return bot.sendMessage(chatId, '📋 შეკვეთები ვერ მოიძებნა.');
  const statusIcon = { completed: '✅', cancelled: '❌', pending: '⏳', accepted: '🚗' };
  const lines = history.map((o, i) => {
    const date   = new Date(o.created_at).toLocaleDateString('ka-GE');
    const src    = o.source === 'phone' ? '📞' : '📱';
    const who    = o.source === 'phone' ? (o.caller_phone || '?') : (o.passenger_name || '?');
    const driver = o.driver_name || '—';
    const icon   = statusIcon[o.status] || '•';
    return `${i + 1}. ${icon} ${src} ${date} | ${who} → ${driver} | ${o.price} ₾`;
  });
  return bot.sendMessage(chatId, `📋 *ბოლო 15:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

// ══ BONUS MENU ════════════════════════════════════════════════════════════════

async function showBonusMenu(chatId) {
  const enabled = await getBonusEnabled();
  const cfg = await getPricingConfig().catch(() => null);
  const toggleLabel = enabled ? '✅ ბონუსი: ჩართულია' : '❌ ბონუსი: გამორთულია';
  const params = cfg
    ? `\n📋 პარამეტრები (Sheets): ${cfg.bonusThreshold} შეკვეთა → +${cfg.bonusAmount} ₾`
    : '';

  return bot.sendMessage(chatId,
    `🎁 *ბონუს სისტემა*${params}\n\nაირჩიეთ მოქმედება:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: toggleLabel, callback_data: 'adm_bonus_toggle' }],
          [{ text: '🎯 მძღოლს ბონუსი',       callback_data: 'adm_bonus_driver_start' }],
          [{ text: '🎟️ მგზავრს ფასდაკლება',  callback_data: 'adm_disc_pass_start'   }],
        ],
      },
    }
  );
}

async function onBonusToggle(query) {
  const newVal = await toggleBonusEnabled();
  await bot.answerCallbackQuery(query.id, {
    text: newVal ? '✅ ბონუსი ჩართულია' : '❌ ბონუსი გამორთულია',
    show_alert: true,
  });
  return showBonusMenu(query.message.chat.id);
}

// Bonus sub-flows triggered by inline buttons from showBonusMenu
bot.on('callback_query', async (query) => {
  if (!isAdmin(query.from)) return;
  const chatId = query.message.chat.id;
  const data   = query.data;

  if (data === 'adm_bonus_driver_start') {
    await bot.answerCallbackQuery(query.id);
    clearBonus(chatId);
    setStep(chatId, STEPS.AWAIT_BONUS_DRIVER_ID);
    return bot.sendMessage(chatId, '🎯 მძღოლის Telegram ID (ან /cancel):',
      { reply_markup: { remove_keyboard: true } });
  }
  if (data === 'adm_disc_pass_start') {
    await bot.answerCallbackQuery(query.id);
    clearBonus(chatId);
    setStep(chatId, STEPS.AWAIT_DISC_PASS_ID);
    return bot.sendMessage(chatId, '🎟️ მგზავრის Telegram ID (ან /cancel):',
      { reply_markup: { remove_keyboard: true } });
  }
});

async function onBonusDriverId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID (რიცხვი):');
  updateBonus(chatId, { driverTelegramId: id });
  setStep(chatId, STEPS.AWAIT_BONUS_AMOUNT);
  return bot.sendMessage(chatId, '💰 ბონუსის თანხა (₾):');
}

async function onBonusAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');
  const { bonus } = getSession(chatId);
  const driver = await addBonusBalance(bonus.driverTelegramId, amount);
  clearBonus(chatId);
  if (!driver) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.', { reply_markup: mainMenu() });
  return bot.sendMessage(chatId,
    `✅ *${driver.full_name}* — bonus_balance: *${driver.bonus_balance} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
}

async function onDiscPassId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID:');
  updateBonus(chatId, { passTelegramId: id });
  setStep(chatId, STEPS.AWAIT_DISC_AMOUNT);
  return bot.sendMessage(chatId, '💰 ფასდაკლების თანხა (₾):');
}

async function onDiscAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');
  const { bonus } = getSession(chatId);
  const pass = await addDiscount(bonus.passTelegramId, amount);
  clearBonus(chatId);
  if (!pass) return bot.sendMessage(chatId, '⚠️ მგზავრი ვერ მოიძებნა.', { reply_markup: mainMenu() });
  return bot.sendMessage(chatId,
    `✅ *${pass.full_name}* — discount_available: *${pass.discount_available} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
}

// ══ BALANCE MENU ══════════════════════════════════════════════════════════════

async function showBalanceMenu(chatId) {
  const drivers = await getDriverBalances();
  if (!drivers.length) return bot.sendMessage(chatId, '💰 აქტიური მძღოლები ვერ მოიძებნა.');

  const lines = drivers.map(d => {
    const warn    = parseFloat(d.balance) < 0 ? ' ⚠️' : '';
    const bonusTxt = parseFloat(d.bonus_balance) > 0 ? `  🎁 ბონ: ${d.bonus_balance} ₾` : '';
    return `• *${d.full_name}*${warn}\n  balance: ${d.balance} ₾${bonusTxt}`;
  });

  const cfg = await getPricingConfig().catch(() => null);
  const commTxt = cfg ? `\n\n⚙️ საკომისიო: *${(cfg.commissionRate * 100).toFixed(0)}%* (შეცვლა — Sheets Config tab)` : '';

  await bot.sendMessage(chatId,
    `💰 *მძღოლების ბალანსები*\n\n${lines.join('\n')}${commTxt}`,
    { parse_mode: 'Markdown' }
  );

  return bot.sendMessage(chatId, 'მოქმედება:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '➖ გატანის ჩაწერა', callback_data: 'adm_wd_start' },
      ]],
    },
  });
}

bot.on('callback_query', async (query) => {
  if (!isAdmin(query.from)) return;
  const chatId = query.message.chat.id;
  if (query.data === 'adm_wd_start') {
    await bot.answerCallbackQuery(query.id);
    clearWd(chatId);
    setStep(chatId, STEPS.AWAIT_WD_DRIVER_ID);
    return bot.sendMessage(chatId, '➖ მძღოლის Telegram ID:',
      { reply_markup: { remove_keyboard: true } });
  }
});

async function onWdDriverId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID:');
  updateWd(chatId, { driverTelegramId: id });
  setStep(chatId, STEPS.AWAIT_WD_AMOUNT);
  return bot.sendMessage(chatId, '💰 გატანის თანხა (₾):');
}

async function onWdAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');
  updateWd(chatId, { amount });
  setStep(chatId, STEPS.AWAIT_WD_NOTE);
  return bot.sendMessage(chatId, '📝 შენიშვნა (ან "-" გამოსატოვებლად):');
}

async function onWdNote(chatId, text) {
  const { wd } = getSession(chatId);
  const note   = (text?.trim() === '-' || !text?.trim()) ? null : text.trim();

  const drivers = await getDriverBalances();
  const driver  = drivers.find(d => d.telegram_id === wd.driverTelegramId);
  if (!driver) {
    clearWd(chatId);
    return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.', { reply_markup: mainMenu() });
  }

  await recordWithdrawal(driver.id, wd.amount, note);
  const newBalance = parseFloat(driver.balance) - wd.amount;
  clearWd(chatId);
  return bot.sendMessage(chatId,
    `✅ გატანა ჩაიწერა\n👤 *${driver.full_name}*\n➖ ${wd.amount} ₾${note ? `\n📝 ${note}` : ''}\n💰 ახალი ბალანსი: *${newBalance.toFixed(2)} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
}

// ── Error handling ────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => logger.error('Admin bot polling error', { error: err.message }));

logger.info('Admin bot started');
module.exports = bot;
