'use strict';

const XLSX = require('xlsx');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { TelegramBot } = require('node-telegram-bot-api');
const config      = require('../config');
const logger      = require('../shared/logger');
const {
  STEPS, getSession, setStep,
  updateOrder, updateBonus, updateWd, updateDrvMgmt, updatePassMgmt, updateBroadcast,
  clearOrder, clearBonus, clearWd, clearDrvMgmt, clearPassMgmt, clearBroadcast,
  updateAdminMgmt, clearAdminMgmt, updatePricing, clearPricing, updateBonusCfg, clearBonusCfg,
} = require('./sessions');
const {
  createOrder, getOrderStats, getAdminHistory, getActiveOrders,
  getEligibleDrivers, getDriverBalances, recordWithdrawal, getDriverStats,
  getDriverRatings, getDriverRatingHistory,
  getPassengerRatings, getPassengerRatingHistory, getPassengerStats,
  getPassengerOrderStats, getCompletedOrdersForExport,
  getAllWithdrawals, getPassengerOrderHistory, getDriverWithdrawalHistory,
  arriveOrder, startOrder, completeOrder, settleOrder, getOrderById,
} = require('../shared/orderService');
const { calculatePrice, getPricingConfig, updatePricingConfig } = require('../shared/sheets');
const { getAdminByTelegramId, getAllAdmins, addAdmin, removeAdmin } = require('../shared/adminService');
const {
  addDiscount,
  getAllPassengers, countPassengers, searchPassengers,
  findPassengerById, findPassengerByPhone,
  updatePassengerField, togglePassengerActive,
  getActivePassengerTelegramIds,
} = require('../shared/passengerService');
const {
  addBonusBalance,
  getAllDrivers, countDrivers, searchDrivers,
  findDriverById, findDriverByPhone,
  updateDriverField, toggleDriverActive,
  getActiveDriverTelegramIds,
  setAvailability,
} = require('../shared/driverService');
const { getBonusEnabled, toggleBonusEnabled } = require('../shared/configService');
const notifier = require('../shared/notifier');

const bot = new TelegramBot(config.admin.botToken, { polling: true });

bot.setMyCommands([
  { command: 'start',  description: 'Admin panel' },
  { command: 'cancel', description: 'მიმდინარე მოქმედების გაუქმება' },
]);

// ── Auth ──────────────────────────────────────────────────────────────────────

async function resolveRole(telegramId) {
  if (telegramId === config.admin.telegramId) return 'owner';
  const row = await getAdminByTelegramId(telegramId);
  return row ? row.role : null; // 'admin' | 'moderator' | null
}

function isPrivLevel(role) { return role === 'owner' || role === 'admin'; }

function guard(handler) {
  return async (msg, ...rest) => {
    const role = await resolveRole(msg.from.id);
    if (!role) return;
    getSession(msg.chat.id).role = role;
    return handler(msg, ...rest);
  };
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function mainMenu(chatId) {
  const role = getSession(chatId).role || 'moderator';
  const priv = isPrivLevel(role);
  const kb = [
    [{ text: '📞 ახალი შეკვეთა (ტელეფონი)' }],
    [{ text: '📊 სტატისტიკა' },    { text: '📋 ბოლო შეკვეთები' }],
    [{ text: '🎁 ბონუსები' },       ...(priv ? [{ text: '💰 ბალანსები' }] : [])],
    [{ text: '🚚 მძღოლები' },       { text: '🚨 აქტიური შეკვეთები' }],
    [{ text: '⭐ რეიტინგები' },     { text: '👥 მგზავრები' }],
    [{ text: '📢 ეცნობოთ ყველას' }, ...(priv ? [{ text: '📄 ექსპორტი' }] : [])],
  ];
  if (priv)             kb.push([{ text: '💲 ფასების მართვა' }]);
  if (role === 'owner') kb.push([{ text: '👮 ადმინების მართვა' }]);
  return { keyboard: kb, resize_keyboard: true };
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
  const chatId = msg.chat.id;
  setStep(chatId, STEPS.IDLE);
  await bot.sendMessage(chatId, '👋 Admin panel:', { reply_markup: mainMenu(chatId) });
}));

bot.onText(/\/cancel/, guard(async (msg) => {
  const chatId = msg.chat.id;
  clearOrder(chatId); clearBonus(chatId); clearWd(chatId);
  clearAdminMgmt(chatId); clearPricing(chatId); clearBonusCfg(chatId);
  bot.sendMessage(chatId, '↩️ გაუქმდა.', { reply_markup: mainMenu(chatId) });
}));

// ── Message router ────────────────────────────────────────────────────────────

bot.on('message', guard(async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text?.startsWith('/')) return;
  const { step, role } = getSession(chatId);

  try {
    switch (step) {
      case STEPS.IDLE: {
        const t = msg.text;
        if (!isPrivLevel(role) && (
          t === '💰 ბალანსები' || t === '💲 ფასების მართვა' ||
          t === '📄 ექსპორტი'  || t === '👮 ადმინების მართვა'
        )) return bot.sendMessage(chatId, '⛔ ამ განყოფილებაზე წვდომა არ გაქვს.');
        if      (t === '📞 ახალი შეკვეთა (ტელეფონი)') await startOrderFlow(chatId);
        else if (t === '📊 სტატისტიკა')               await showStats(chatId);
        else if (t === '📋 ბოლო შეკვეთები')           await showHistory(chatId);
        else if (t === '🎁 ბონუსები')                  await showBonusMenu(chatId);
        else if (t === '💰 ბალანსები')                 await showBalanceMenu(chatId);
        else if (t === '🚚 მძღოლები')                  await showDriverMenu(chatId);
        else if (t === '🚨 აქტიური შეკვეთები')         await showActiveOrders(chatId);
        else if (t === '⭐ რეიტინგები')               await showRatingMenu(chatId);
        else if (t === '👥 მგზავრები')               await showPassengerMenu(chatId);
        else if (t === '📢 ეცნობოთ ყველას')         await showBroadcastMenu(chatId);
        else if (t === '📄 ექსპორტი')               await showExportMenu(chatId);
        else if (t === '💲 ფასების მართვა')         await showPricingMenu(chatId);
        else if (t === '👮 ადმინების მართვა')       await showAdminMgmt(chatId);
        break;
      }
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
      case STEPS.AWAIT_WD_BANK_ACCOUNT: await onWdBankAccount(chatId, msg.text); break;
      case STEPS.AWAIT_WD_AMOUNT:       await onWdAmount(chatId, msg.text);       break;
      // Driver management
      case STEPS.AWAIT_DRV_SEARCH:      await onDriverSearch(chatId, msg.text);      break;
      case STEPS.AWAIT_DRV_EDIT_FIELD:  await onDriverEditValue(chatId, msg.text);   break;
      // Passenger management
      case STEPS.AWAIT_PASS_SEARCH:     await onPassengerSearch(chatId, msg.text);    break;
      case STEPS.AWAIT_PASS_EDIT_FIELD: await onPassengerEditValue(chatId, msg.text); break;
      // Broadcast
      case STEPS.AWAIT_BROADCAST_TEXT:  await onBroadcastText(chatId, msg.text);      break;
      // Admin management
      case STEPS.AWAIT_ADMIN_ADD_ID:    await onAdminAddId(chatId, msg.text);         break;
      // Pricing
      case STEPS.AWAIT_PRICING_VALUE:   await onPricingValue(chatId, msg.text);       break;
      // Bonus config
      case STEPS.AWAIT_BONUS_CONFIG_VALUE: await onBonusCfgValue(chatId, msg.text);  break;
      default: break;
    }
  } catch (err) {
    logger.error('Admin bot error', { chatId, step, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /cancel.');
  }
}));

// ── Callback router ───────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Order status buttons (arrived/start/complete) work without admin check
  if (data.startsWith('adm_ostatus:')) {
    try { await onAdminOrderStatus(query); } catch (err) {
      logger.error('Admin ostatus error', { chatId, data, error: err.message });
      await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა.' });
    }
    return;
  }

  const role = await resolveRole(query.from.id);
  if (!role) return bot.answerCallbackQuery(query.id);
  getSession(chatId).role = role;

  const { step } = getSession(chatId);
  const priv = isPrivLevel(role);
  const noAccess = async () => bot.answerCallbackQuery(query.id, { text: '⛔ მხოლოდ admin-ს შეუძლია ამის ცვლილება.', show_alert: true });

  try {
    if      (data.startsWith('adm_vsize:')   && step === STEPS.AWAIT_VSIZE)   await onVsize(query);
    else if (data.startsWith('adm_canroll:') && step === STEPS.AWAIT_CANROLL) await onCanRoll(query);
    else if (data.startsWith('adm_pay:')     && step === STEPS.AWAIT_PAYMENT) await onPayment(query);
    else if ((data === 'adm_confirm' || data === 'adm_cancel') && step === STEPS.AWAIT_CONFIRM) await onConfirm(query);
    // Bonus toggle & sub-flows — priv only
    else if (data === 'adm_bonus_toggle') {
      if (priv) await onBonusToggle(query); else await noAccess();
    }
    else if (data === 'adm_bonus_driver_start') {
      if (priv) {
        await bot.answerCallbackQuery(query.id);
        clearBonus(chatId);
        setStep(chatId, STEPS.AWAIT_BONUS_DRIVER_ID);
        await bot.sendMessage(chatId, '🎯 მძღოლის Telegram ID (ან /cancel):', { reply_markup: { remove_keyboard: true } });
      } else await noAccess();
    }
    else if (data === 'adm_disc_pass_start') {
      if (priv) {
        await bot.answerCallbackQuery(query.id);
        clearBonus(chatId);
        setStep(chatId, STEPS.AWAIT_DISC_PASS_ID);
        await bot.sendMessage(chatId, '🎟️ მგზავრის Telegram ID (ან /cancel):', { reply_markup: { remove_keyboard: true } });
      } else await noAccess();
    }
    // Bonus config submenu (threshold/amount/commission)
    else if (data === 'adm_boncfg_menu') {
      if (priv) await showBonusConfig(query); else await noAccess();
    }
    else if (data.startsWith('adm_boncfg:')) {
      if (priv) await onBonusCfgKey(query); else await noAccess();
    }
    // Pricing
    else if (data.startsWith('adm_price:')) {
      if (priv) await onPricingKey(query); else await noAccess();
    }
    // Withdrawal history (all)
    else if (data === 'adm_wdall_menu')            await showWdAllMenu(query);
    else if (data.startsWith('adm_wdall:'))        await onWdAll(query);
    // Withdrawal (entry only from driver profile)
    else if (data.startsWith('adm_wd_drv:'))       await onWdDriverSelected(query);
    else if (data.startsWith('adm_wd_method:'))    await onWdMethod(query);
    else if (data.startsWith('adm_wdhist_drv:'))   await onWdHistDriver(query);
    // Broadcast
    else if (data.startsWith('adm_bc:'))           await onBroadcastTarget(query);
    // Export
    else if (data.startsWith('adm_exp:'))          await onExport(query);
    // Ratings
    else if (data.startsWith('adm_rat:'))          await onRatingTab(query);
    else if (data.startsWith('adm_rat_drv:'))      await onRatingDriverDetail(query);
    else if (data.startsWith('adm_rat_pass:'))     await onRatingPassDetail(query);
    // Active orders tabs
    else if (data.startsWith('adm_ac:'))           await onActiveTab(query);
    // History filters
    else if (data.startsWith('adm_hist:'))         await onHistFilter(query);
    // Passenger management
    else if (data.startsWith('adm_pass_list:'))    await onPassList(query);
    else if (data === 'adm_pass_search')           await onPassSearchStart(query);
    else if (data.startsWith('adm_pass_edit:'))    await onPassEditStart(query);
    else if (data.startsWith('adm_pass_toggle:'))  await onPassToggle(query);
    else if (data.startsWith('adm_pass_hist:'))    await onPassOrderHistory(query);
    else if (data === 'adm_pass_back')             { await bot.answerCallbackQuery(query.id); await showPassengerMenu(chatId); }
    else if (data.startsWith('adm_pass:'))         await onPassProfile(query);
    // Driver management
    else if (data.startsWith('adm_drv_list:'))     await onDrvList(query);
    else if (data === 'adm_drv_search')            await onDrvSearchStart(query);
    else if (data.startsWith('adm_drv:'))          await onDrvProfile(query);
    else if (data.startsWith('adm_drv_edit:'))     await onDrvEditStart(query);
    else if (data.startsWith('adm_drv_toggle:'))   await onDrvToggle(query);
    else if (data === 'adm_drv_back')              { await bot.answerCallbackQuery(query.id); await showDriverMenu(chatId); }
    // Admin management — owner only
    else if (data.startsWith('adm_admgmt:')) {
      if (role === 'owner') await onAdminMgmtCallback(query);
      else await bot.answerCallbackQuery(query.id, { text: '⛔ მხოლოდ owner-ს შეუძლია.' });
    }
    else if (data === 'cancel_input')              await onCancelInput(query);
    else if (data === 'noop')                      await bot.answerCallbackQuery(query.id);
    else await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error('Admin callback error', { chatId, data, error: err.message });
    await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა. /cancel' });
  }
});

// ══ ORDER FLOW ════════════════════════════════════════════════════════════════

function cancelKb() {
  return { inline_keyboard: [[{ text: '❌ გაუქმება', callback_data: 'cancel_input' }]] };
}

async function startOrderFlow(chatId) {
  clearOrder(chatId);
  setStep(chatId, STEPS.AWAIT_PHONE);
  return bot.sendMessage(chatId,
    '📞 *ახალი ტელეფონური შეკვეთა*\n\n1/7 — მგზავრის ტელეფონი:',
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onPhone(chatId, text) {
  if (!text || !isValidPhone(text))
    return bot.sendMessage(chatId, '⚠️ მინიმუმ 6 ციფრი. სცადეთ ხელახლა:');
  updateOrder(chatId, { callerPhone: text.trim() });
  setStep(chatId, STEPS.AWAIT_PICKUP);
  return bot.sendMessage(chatId, '2/7 — *საიდან* (მისამართი):', { parse_mode: 'Markdown', reply_markup: cancelKb() });
}

async function onPickup(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ვერ ამოიკითხა. სცადეთ:');
  updateOrder(chatId, { pickupAddress: text.trim() });
  setStep(chatId, STEPS.AWAIT_DEST);
  return bot.sendMessage(chatId, '3/7 — *სად* (მისამართი):', { parse_mode: 'Markdown', reply_markup: cancelKb() });
}

async function onDest(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ვერ ამოიკითხა. სცადეთ:');
  updateOrder(chatId, { destAddress: text.trim() });
  setStep(chatId, STEPS.AWAIT_DISTANCE);
  return bot.sendMessage(chatId, '4/7 — *მანძილი კმ-ებში*:', { parse_mode: 'Markdown', reply_markup: cancelKb() });
}

async function onDistance(chatId, text) {
  const km = parseAmount(text);
  if (!km) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი (მაგ. 12 ან 7.5):');
  updateOrder(chatId, { distanceKm: km });
  setStep(chatId, STEPS.AWAIT_VSIZE);
  return bot.sendMessage(chatId, '5/7 — *მანქანის ტიპი:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '🚙 ჩვეულებრივი', callback_data: 'adm_vsize:normal' },
      { text: '🚐 ჯიპი',        callback_data: 'adm_vsize:jeep'   },
      { text: '🚌 დიდი ავტ.',   callback_data: 'adm_vsize:large'  },
    ]] },
  });
}

async function onVsize(query) {
  const chatId = query.message.chat.id;
  const vehicleSize = query.data.split(':')[1];
  updateOrder(chatId, { vehicleSize });
  setStep(chatId, STEPS.AWAIT_CANROLL);
  await bot.answerCallbackQuery(query.id);
  const label = vehicleSize === 'jeep' ? '🚐 ჯიპი' : vehicleSize === 'large' ? '🚌 დიდი ავტ.' : '🚙 ჩვეულებრივი';
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
  const sizeLabel = o.vehicleSize === 'jeep' ? '🚐 ჯიპი' : o.vehicleSize === 'large' ? '🚌 დიდი ავტ.' : '🚙 ჩვეულებრივი';
  const rollLabel = canRoll ? '✅ გორავს' : '❌ არ გორავს';
  const extras    = [
    bd.size_fee  > 0 && `  დიდი მანქანა: +${bd.size_fee} ₾`,
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
    return bot.sendMessage(chatId, '↩️ გაუქმდა.', { reply_markup: mainMenu(chatId) });
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
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
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

  let grandTotal = 0, grandCompany = 0, grandDriver = 0;
  const lines = rows.map(r => {
    const src = r.source === 'phone' ? '📞 ტელეფონი' : '📱 ბოტი';
    grandTotal   += parseFloat(r.total_revenue)  || 0;
    grandCompany += parseFloat(r.company_revenue) || 0;
    grandDriver  += parseFloat(r.driver_earnings) || 0;
    return (
      `${src}\n` +
      `  სულ: ${r.total}  ✅ ${r.completed}  ❌ ${r.cancelled}  ⏳ ${r.pending}\n` +
      `  საშ: ${r.avg_price || '—'} ₾  |  ბრუნვა: ${r.total_revenue} ₾\n` +
      `  ├ ჩემი (საკომ.): *${r.company_revenue} ₾*\n` +
      `  └ მძღოლების:     ${r.driver_earnings} ₾`
    );
  });

  const summaryLine = rows.length > 1
    ? `\n\n📌 *სულ ყველა წყარო:*\n  ბრუნვა: ${grandTotal.toFixed(2)} ₾\n  ├ ჩემი: *${grandCompany.toFixed(2)} ₾*\n  └ მძღოლები: ${grandDriver.toFixed(2)} ₾`
    : '';

  return bot.sendMessage(chatId,
    `📊 *ბოლო 30 დღე*\n\n${lines.join('\n\n')}${summaryLine}`,
    { parse_mode: 'Markdown' }
  );
}

async function showHistory(chatId) {
  return bot.sendMessage(chatId, '📋 *ფილტრი:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 ყველა 7d',      callback_data: 'adm_hist:all:7'        },
          { text: '📋 ყველა 30d',     callback_data: 'adm_hist:all:30'       },
        ],
        [
          { text: '✅ Completed 7d',  callback_data: 'adm_hist:completed:7'  },
          { text: '✅ Completed 30d', callback_data: 'adm_hist:completed:30' },
        ],
        [
          { text: '❌ Cancelled 7d',  callback_data: 'adm_hist:cancelled:7'  },
          { text: '❌ Cancelled 30d', callback_data: 'adm_hist:cancelled:30' },
        ],
        [
          { text: '⏳ Pending (ახლა)',  callback_data: 'adm_hist:pending:0'  },
          { text: '🚗 Active (ახლა)',   callback_data: 'adm_hist:active:0'   },
        ],
      ],
    },
  });
}

const STATUS_ICON = {
  completed: '✅', cancelled: '❌', pending: '⏳',
  accepted: '🚗', arrived: '📍', in_progress: '🚛',
};

async function onHistFilter(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const parts  = query.data.split(':'); // adm_hist:status:days
  const status = parts[1];
  const days   = parseInt(parts[2], 10);

  const statusArg = status === 'all' ? null : status;
  const daysArg   = days > 0 ? days : null;
  const history   = await getAdminHistory({ status: statusArg, days: daysArg, limit: 20 });

  if (!history.length) {
    return bot.sendMessage(chatId, '📋 შეკვეთები ვერ მოიძებნა.');
  }

  const lines = history.map((o, i) => {
    const dt     = new Date(o.created_at);
    const date   = dt.toLocaleDateString('ka-GE');
    const time   = dt.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' });
    const src    = o.source === 'phone' ? '📞' : '📱';
    const who    = o.source === 'phone' ? (o.caller_phone || '?') : (o.passenger_name || '?');
    const driver = o.driver_name ? `👤 ${o.driver_name}` : '—';
    const icon   = STATUS_ICON[o.status] || '•';
    const from   = (o.pickup_address     || '').substring(0, 25);
    const to     = (o.destination_address|| '').substring(0, 25);
    return `${i + 1}. ${icon} ${src} *${date} ${time}*\n   ${who} → ${driver}\n   ${from} → ${to} | ${o.price} ₾`;
  });

  const statusLabel = { all: 'ყველა', completed: '✅ Completed', cancelled: '❌ Cancelled', pending: '⏳ Pending', active: '🚗 Active' };
  const period      = days > 0 ? `ბოლო ${days} დღე` : 'ახლა';
  const header      = `📋 *${statusLabel[status] || status} | ${period}* (${history.length}):`;

  const text = `${header}\n\n${lines.join('\n\n')}`;
  if (text.length > 4000) {
    const chunks = [];
    let cur = header + '\n\n';
    for (const line of lines) {
      if ((cur + line).length > 3900) { chunks.push(cur); cur = ''; }
      cur += line + '\n\n';
    }
    if (cur.trim()) chunks.push(cur);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk.trim(), { parse_mode: 'Markdown' });
    }
    return;
  }
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ══ BROADCAST ════════════════════════════════════════════════════════════════

async function showBroadcastMenu(chatId) {
  return bot.sendMessage(chatId, '📢 *ვის გაუგზავნოთ?*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '👤 მძღოლებს',   callback_data: 'adm_bc:drivers'    },
      { text: '🧍 მგზავრებს',  callback_data: 'adm_bc:passengers' },
    ]] },
  });
}

async function onBroadcastTarget(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const target = query.data.split(':')[1];
  updateBroadcast(chatId, { target });
  setStep(chatId, STEPS.AWAIT_BROADCAST_TEXT);
  const label = target === 'drivers' ? '👤 მძღოლებისთვის' : '🧍 მგზავრებისთვის';
  return bot.sendMessage(chatId,
    `${label}\n\n✏️ ჩაწერეთ შეტყობინების ტექსტი (Markdown მხარდაჭერილია):`,
    { reply_markup: cancelKb() }
  );
}

async function onBroadcastText(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ტექსტი არ შეიძლება ცარიელი იყოს:');
  const { broadcast } = getSession(chatId);
  const target = broadcast.target;
  clearBroadcast(chatId);

  const isDrivers  = target === 'drivers';
  const targetBot  = isDrivers ? notifier.getDriverBot() : notifier.getPassengerBot();

  if (!targetBot) {
    return bot.sendMessage(chatId,
      `❌ ${isDrivers ? 'Driver' : 'Passenger'} bot ჯერ არ არის ინიციალიზებული. სცადეთ მოგვიანებით.`,
      { reply_markup: mainMenu(chatId) }
    );
  }

  const ids = isDrivers
    ? await getActiveDriverTelegramIds()
    : await getActivePassengerTelegramIds();

  if (!ids.length) {
    return bot.sendMessage(chatId, '⚠️ აქტიური მომხმარებელი ვერ მოიძებნა.', { reply_markup: mainMenu(chatId) });
  }

  await bot.sendMessage(chatId, `📤 ვგზავნი ${ids.length} მომხმარებელს...`);

  let sent = 0, failed = 0;
  for (const telegramId of ids) {
    try {
      await targetBot.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
      sent++;
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return bot.sendMessage(chatId,
    `✅ *გაიგზავნა: ${sent}*${failed ? `\n❌ ვერ გაიგზავნა: ${failed}` : ''}`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
  );
}

// ══ EXPORT ════════════════════════════════════════════════════════════════════

async function showExportMenu(chatId) {
  return bot.sendMessage(chatId, '📄 *ექსპორტი — პერიოდი:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '📅 ეს თვე',      callback_data: 'adm_exp:current'  },
      { text: '📅 გასული თვე',  callback_data: 'adm_exp:previous' },
    ]] },
  });
}

async function onExport(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const period = query.data.split(':')[1];

  const now    = new Date();
  let from, to, label;

  if (period === 'current') {
    from  = new Date(now.getFullYear(), now.getMonth(), 1);
    to    = now;
    label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  } else {
    const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const m   = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    from      = new Date(y, m, 1);
    to        = new Date(now.getFullYear(), now.getMonth(), 1);
    label     = `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  await bot.sendMessage(chatId, `⏳ ვამზადებ ექსპორტს (${label})...`);

  const orders = await getCompletedOrdersForExport(from, to);

  if (!orders.length) {
    return bot.sendMessage(chatId, `📄 ${label} — completed შეკვეთა არ არის.`, { reply_markup: mainMenu(chatId) });
  }

  const rows = orders.map(o => ({
    'ID':           o.id,
    'თარიღი':       new Date(o.created_at).toLocaleDateString('ka-GE'),
    'საათი':        new Date(o.created_at).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' }),
    'მგზავარი':     o.passenger_name || o.caller_phone || '—',
    'მძღოლი':       o.driver_name    || '—',
    'მძღოლი ტელ.': o.driver_phone   || '—',
    'საიდან':       o.pickup_address       || '—',
    'სად':          o.destination_address  || '—',
    'ფასი (₾)':    parseFloat(o.price)            || 0,
    'საკომ. (₾)':  parseFloat(o.commission_amount) || 0,
    'გადახდა':      o.payment_method === 'card' ? 'ბარათი' : 'ნაღდი',
    'წყარო':        o.source === 'phone' ? 'ტელეფ.' : 'ბოტი',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'შეკვეთები');

  const tmpFile = path.join(os.tmpdir(), `evacuator_${label}_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmpFile);

  try {
    await bot.sendDocument(chatId, fs.createReadStream(tmpFile), {}, {
      filename:    `evacuator_${label}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ══ RATINGS ══════════════════════════════════════════════════════════════════

const RATING_ALERT_THRESHOLD = 3.5;
const RATING_ALERT_MIN_COUNT = 5;

const RATING_NAV = { inline_keyboard: [[
  { text: '👤 მძღოლები',  callback_data: 'adm_rat:drivers'    },
  { text: '👥 მგზავრები', callback_data: 'adm_rat:passengers' },
]] };

function starsLine(rating) {
  const n = parseInt(rating) || 0;
  return '⭐'.repeat(n) + '☆'.repeat(5 - n);
}

function isAlertRating(avg, count) {
  return parseFloat(avg) < RATING_ALERT_THRESHOLD && parseInt(count) >= RATING_ALERT_MIN_COUNT;
}

async function showRatingMenu(chatId) {
  return bot.sendMessage(chatId, '⭐ *რეიტინგების მონიტორინგი:*', {
    parse_mode: 'Markdown',
    reply_markup: RATING_NAV,
  });
}

async function onRatingTab(query) {
  await bot.answerCallbackQuery(query.id);
  const tab = query.data.split(':')[1];
  if (tab === 'drivers')    return showDriverRatings(query.message.chat.id);
  if (tab === 'passengers') return showPassengerRatings(query.message.chat.id);
}

async function showDriverRatings(chatId) {
  const drivers = await getDriverRatings();
  if (!drivers.length) {
    return bot.sendMessage(chatId, '⭐ შეფასებული მძღოლი ჯერ არ არის.',
      { reply_markup: RATING_NAV });
  }

  const rows = drivers.map(d => {
    const avg   = parseFloat(d.avg_rating);
    const cnt   = parseInt(d.rated_count);
    const alert = isAlertRating(avg, cnt) ? '⚠️ ' : '';
    return [{ text: `${alert}${d.full_name} | ⭐ ${avg.toFixed(1)} | ${cnt} შეფ.`, callback_data: `adm_rat_drv:${d.id}` }];
  });
  rows.push([{ text: '👥 მგზავრები →', callback_data: 'adm_rat:passengers' }]);

  const alertCount = drivers.filter(d => isAlertRating(d.avg_rating, d.rated_count)).length;
  const header = `👤 *მძღოლები* (${drivers.length})${alertCount ? ` — ⚠️ ${alertCount} პრობლ.` : ''}:`;

  return bot.sendMessage(chatId, header, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showPassengerRatings(chatId) {
  const passengers = await getPassengerRatings();
  if (!passengers.length) {
    return bot.sendMessage(chatId, '⭐ შეფასებული მგზავრი ჯერ არ არის.',
      { reply_markup: RATING_NAV });
  }

  const rows = passengers.map(p => {
    const avg   = parseFloat(p.avg_rating);
    const cnt   = parseInt(p.rated_count);
    const alert = isAlertRating(avg, cnt) ? '⚠️ ' : '';
    return [{ text: `${alert}${p.full_name} | ⭐ ${avg.toFixed(1)} | ${cnt} შეფ.`, callback_data: `adm_rat_pass:${p.id}` }];
  });
  rows.push([{ text: '← 👤 მძღოლები', callback_data: 'adm_rat:drivers' }]);

  const alertCount = passengers.filter(p => isAlertRating(p.avg_rating, p.rated_count)).length;
  const header = `👥 *მგზავრები* (${passengers.length})${alertCount ? ` — ⚠️ ${alertCount} პრობლ.` : ''}:`;

  return bot.sendMessage(chatId, header, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function onRatingDriverDetail(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId   = query.message.chat.id;
  const driverId = parseInt(query.data.split(':')[1], 10);

  const [history, stats, driver] = await Promise.all([
    getDriverRatingHistory(driverId),
    getDriverStats(driverId),
    findDriverById(driverId),
  ]);

  if (!driver) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.');
  if (!history.length) return bot.sendMessage(chatId, '⭐ შეფასება ჯერ არ არის.',
    { reply_markup: { inline_keyboard: [[{ text: '← სია', callback_data: 'adm_rat:drivers' }]] } });

  const avgAll = stats?.avg_rating ? parseFloat(stats.avg_rating).toFixed(1) : '—';
  const cntAll = parseInt(stats?.rated_count) || 0;
  const alertNote = isAlertRating(stats?.avg_rating, cntAll)
    ? '\n⚠️ *საჭიროებს ყურადღებას!*' : '';

  const lines = history.map((o, i) => {
    const date = new Date(o.created_at).toLocaleDateString('ka-GE');
    const from = (o.pickup_address      || '').substring(0, 14);
    const to   = (o.destination_address || '').substring(0, 14);
    const who  = o.passenger_name || '📞 ტელ.';
    return `${i + 1}. ${starsLine(o.driver_rating)} | ${date}\n    📍 ${from}→${to} | 👤 ${who}`;
  });

  return bot.sendMessage(chatId,
    `👤 *${driver.full_name}*\n⭐ *${avgAll} avg* (სულ ${cntAll} შეფ.)${alertNote}\n\n*ბოლო ${history.length}:*\n\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '← მძღოლები', callback_data: 'adm_rat:drivers' }]] },
    }
  );
}

async function onRatingPassDetail(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId      = query.message.chat.id;
  const passengerId = parseInt(query.data.split(':')[1], 10);

  const [history, stats] = await Promise.all([
    getPassengerRatingHistory(passengerId),
    getPassengerStats(passengerId),
  ]);

  if (!history.length) return bot.sendMessage(chatId, '⭐ შეფასება ჯერ არ არის.',
    { reply_markup: { inline_keyboard: [[{ text: '← სია', callback_data: 'adm_rat:passengers' }]] } });

  const first  = history[0];
  const name   = first.passenger_name || '?';
  const phone  = first.passenger_phone ? ` | 📞 ${first.passenger_phone}` : '';
  const avgAll = stats?.avg_rating ? parseFloat(stats.avg_rating).toFixed(1) : '—';
  const cntAll = parseInt(stats?.rated_count) || 0;
  const alertNote = isAlertRating(stats?.avg_rating, cntAll)
    ? '\n⚠️ *პრობლემური მგზავრი!*' : '';

  const lines = history.map((o, i) => {
    const date = new Date(o.created_at).toLocaleDateString('ka-GE');
    const from = (o.pickup_address      || '').substring(0, 14);
    const to   = (o.destination_address || '').substring(0, 14);
    const drv  = o.driver_name || '?';
    return `${i + 1}. ${starsLine(o.passenger_rating)} | ${date}\n    📍 ${from}→${to} | 🚗 ${drv}`;
  });

  return bot.sendMessage(chatId,
    `👥 *${name}*${phone}\n⭐ *${avgAll} avg* (სულ ${cntAll} შეფ.)${alertNote}\n\n*ბოლო ${history.length}:*\n\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '← მგზავრები', callback_data: 'adm_rat:passengers' }]] },
    }
  );
}

// ══ ACTIVE ORDERS ════════════════════════════════════════════════════════════

const TAB_LABELS = { pending: '⏳ Pending', active: '🚗 Active', alerts: '⚠️ ალერტები' };

const STATUS_ICON_ACTIVE = { accepted: '🚗', arrived: '📍', in_progress: '🚛' };

function formatOrderLine(o) {
  const from = (o.pickup_address      || '').substring(0, 22);
  const to   = (o.destination_address || '').substring(0, 22);
  const src  = o.source === 'phone' ? '📞' : '📱';

  if (o.status === 'pending') {
    const mins  = parseInt(o.minutes_waiting) || 0;
    const alert = mins >= 10 ? '⚠️ ' : '';
    const who   = o.source === 'phone' ? (o.caller_phone || '?') : (o.passenger_name || '?');
    const vtype = o.vehicle_size === 'jeep' ? '🚐' : o.vehicle_size === 'large' ? '🚌' : '🚗';
    const roll  = o.can_roll ? '' : ' ❌გორ';
    return `${alert}*#${o.id}* | ${mins} წთ | ${src} ${who}\n   📍 ${from} → ${to} | ${o.price} ₾ ${vtype}${roll}`;
  }

  const mins    = parseInt(o.minutes_since_accepted) || 0;
  const alert   = o.status === 'accepted' && mins >= 30 ? '⚠️ ' : '';
  const stIcon  = STATUS_ICON_ACTIVE[o.status] || '•';
  const drvLine = o.driver_name
    ? `\n   👤 ${o.driver_name}${o.driver_phone ? ` | 📞 ${o.driver_phone}` : ''}`
    : '';
  return `${alert}*#${o.id}* | ${stIcon} ${o.status} | ${mins} წთ${drvLine}\n   📍 ${from} → ${to} | ${o.price} ₾`;
}

async function showActiveOrders(chatId) {
  return bot.sendMessage(chatId, '🚨 *აქტიური შეკვეთები* — ჩანართი:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '⏳ Pending',    callback_data: 'adm_ac:pending' },
        { text: '🚗 Active',     callback_data: 'adm_ac:active'  },
        { text: '⚠️ ალერტები', callback_data: 'adm_ac:alerts'  },
      ]],
    },
  });
}

async function onActiveTab(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const tab    = query.data.split(':')[1];
  const orders = await getActiveOrders(tab);

  const tabLabel = TAB_LABELS[tab] || tab;
  const navKb = { inline_keyboard: [[
    { text: '⏳ Pending',    callback_data: 'adm_ac:pending' },
    { text: '🚗 Active',     callback_data: 'adm_ac:active'  },
    { text: '⚠️ ალერტები', callback_data: 'adm_ac:alerts'  },
  ]] };

  if (!orders.length) {
    return bot.sendMessage(chatId, `${tabLabel}: შეკვეთები არ არის.`, { reply_markup: navKb });
  }

  // For active orders, send each with control buttons; others send as list
  if (tab === 'active') {
    await bot.sendMessage(chatId, `🚗 *Active (${orders.length}):*`, { parse_mode: 'Markdown' });
    for (const o of orders) {
      const line = formatOrderLine(o);
      const ctrlKb = orderControlKeyboard(o);
      await bot.sendMessage(chatId, line, { parse_mode: 'Markdown', reply_markup: ctrlKb });
    }
    return bot.sendMessage(chatId, '─', { reply_markup: navKb });
  }

  const lines  = orders.map(o => formatOrderLine(o));
  const header = `${tabLabel} (${orders.length}):`;
  const nav    = { reply_markup: navKb };

  const full = `${header}\n\n${lines.join('\n\n')}`;
  if (full.length <= 4000) {
    return bot.sendMessage(chatId, full, { parse_mode: 'Markdown', ...nav });
  }

  const chunks = [];
  let cur = header + '\n\n';
  for (const line of lines) {
    if ((cur + line).length > 3900) { chunks.push(cur.trim()); cur = ''; }
    cur += line + '\n\n';
  }
  if (cur.trim()) chunks.push(cur.trim());

  for (let i = 0; i < chunks.length; i++) {
    const opts = { parse_mode: 'Markdown' };
    if (i === chunks.length - 1) Object.assign(opts, nav);
    await bot.sendMessage(chatId, chunks[i], opts);
  }
}

function orderControlKeyboard(o) {
  const id = o.id;
  if (o.status === 'accepted') {
    return { inline_keyboard: [[{ text: '📍 მოვედი', callback_data: `adm_ostatus:arrived:${id}` }]] };
  }
  if (o.status === 'arrived') {
    return { inline_keyboard: [[{ text: '🚛 დავიძარი', callback_data: `adm_ostatus:start:${id}` }]] };
  }
  if (o.status === 'in_progress') {
    return { inline_keyboard: [[{ text: '✅ დავასრულე', callback_data: `adm_ostatus:complete:${id}` }]] };
  }
  return { inline_keyboard: [] };
}

async function onAdminOrderStatus(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId  = query.message.chat.id;
  const parts   = query.data.split(':'); // adm_ostatus:ACTION:ID
  const action  = parts[1];
  const orderId = parseInt(parts[2], 10);

  const order = await getOrderById(orderId);
  if (!order) {
    return bot.sendMessage(chatId, `⚠️ შეკვეთა #${orderId} ვერ მოიძებნა.`);
  }

  const driverId = order.driver_id;
  const driver   = driverId ? await findDriverById(driverId) : null;

  if (action === 'arrived') {
    const updated = await arriveOrder(orderId, driverId);
    if (!updated) return bot.sendMessage(chatId, '⚠️ სტატუსი ვერ განახლდა.');
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id,
    }).catch(() => {});
    await notifier.notifyPassengerDriverArrived(updated.passenger_telegram_id, driver || { phone: '—' });
    return bot.sendMessage(chatId, `📍 #${orderId} — სტატუსი: *მოვიდა* (ადმინ)`, { parse_mode: 'Markdown' });
  }

  if (action === 'start') {
    const updated = await startOrder(orderId, driverId);
    if (!updated) return bot.sendMessage(chatId, '⚠️ სტატუსი ვერ განახლდა.');
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id,
    }).catch(() => {});
    await notifier.notifyPassengerTripStarted(updated.passenger_telegram_id);
    return bot.sendMessage(chatId, `🚛 #${orderId} — სტატუსი: *მგზავრობა დაიწყო* (ადმინ)`, { parse_mode: 'Markdown' });
  }

  if (action === 'complete') {
    const updated = await completeOrder(orderId, driverId);
    if (!updated) return bot.sendMessage(chatId, '⚠️ სტატუსი ვერ განახლდა.');
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id,
    }).catch(() => {});
    const result = await settleOrder(orderId);
    if (driver?.telegram_id) await setAvailability(driver.telegram_id, true);
    await notifier.notifyPassengerTripCompleted(orderId, updated.passenger_telegram_id);
    const note = result ? `💰 ${updated.price} ₾ | კომ: ${result.commission} ₾` : '';
    return bot.sendMessage(chatId, `✅ #${orderId} — *დასრულდა* (ადმინ)\n${note}`, { parse_mode: 'Markdown' });
  }
}

// ══ BONUS MENU ════════════════════════════════════════════════════════════════

async function showBonusMenu(chatId) {
  const role    = getSession(chatId).role || 'moderator';
  const priv    = isPrivLevel(role);
  const enabled = await getBonusEnabled();
  const cfg     = await getPricingConfig().catch(() => null);
  const toggleLabel = enabled ? '✅ ბონუსი: ჩართულია' : '❌ ბონუსი: გამორთულია';
  const params  = cfg
    ? `\n📋 threshold: ${cfg.bonusThreshold} შეკვ. → +${cfg.bonusAmount} ₾  |  საკომ: ${(cfg.commissionRate * 100).toFixed(0)}%`
    : '';
  const readOnlyNote = priv ? '' : '\n\n🔒 ცვლილება მხოლოდ admin-ს შეუძლია';

  const kb = [
    [{ text: toggleLabel, callback_data: 'adm_bonus_toggle' }],
    [{ text: '🎯 მძღოლს ბონუსი',      callback_data: 'adm_bonus_driver_start' }],
    [{ text: '🎟️ მგზავრს ფასდაკლება', callback_data: 'adm_disc_pass_start'   }],
  ];
  if (priv) kb.push([{ text: '⚙️ პირობების მართვა', callback_data: 'adm_boncfg_menu' }]);

  return bot.sendMessage(chatId,
    `🎁 *ბონუს სისტემა*${params}${readOnlyNote}\n\nაირჩიეთ მოქმედება:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
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


async function onBonusDriverId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID (რიცხვი):');
  updateBonus(chatId, { driverTelegramId: id });
  setStep(chatId, STEPS.AWAIT_BONUS_AMOUNT);
  return bot.sendMessage(chatId, '💰 ბონუსის თანხა (₾):', { reply_markup: cancelKb() });
}

async function onBonusAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');
  const { bonus } = getSession(chatId);
  const driver = await addBonusBalance(bonus.driverTelegramId, amount);
  clearBonus(chatId);
  if (!driver) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.', { reply_markup: mainMenu(chatId) });
  return bot.sendMessage(chatId,
    `✅ *${driver.full_name}* — bonus_balance: *${driver.bonus_balance} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
  );
}

async function onDiscPassId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID:');
  updateBonus(chatId, { passTelegramId: id });
  setStep(chatId, STEPS.AWAIT_DISC_AMOUNT);
  return bot.sendMessage(chatId, '💰 ფასდაკლების თანხა (₾):', { reply_markup: cancelKb() });
}

async function onDiscAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');
  const { bonus } = getSession(chatId);
  const pass = await addDiscount(bonus.passTelegramId, amount);
  clearBonus(chatId);
  if (!pass) return bot.sendMessage(chatId, '⚠️ მგზავრი ვერ მოიძებნა.', { reply_markup: mainMenu(chatId) });
  return bot.sendMessage(chatId,
    `✅ *${pass.full_name}* — discount_available: *${pass.discount_available} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
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
  return bot.sendMessage(chatId, '📜 გატანების ისტ.:', {
    reply_markup: { inline_keyboard: [[
      { text: '📜 ყველა გატანის ისტორია', callback_data: 'adm_wdall_menu' },
    ]] },
  });
}

// ══ WITHDRAWAL HISTORY (ALL) ═════════════════════════════════════════════════

const WD_PERIOD_LABELS = { today: '📅 დღეს', week: '📅 ეს კვირა', month: '📅 ეს თვე', all: '📅 ყველა' };

const WD_PERIOD_KB = { inline_keyboard: [
  [
    { text: '📅 დღეს',      callback_data: 'adm_wdall:today:0' },
    { text: '📅 ეს კვირა', callback_data: 'adm_wdall:week:0'  },
  ],
  [
    { text: '📅 ეს თვე',  callback_data: 'adm_wdall:month:0' },
    { text: '📅 ყველა',   callback_data: 'adm_wdall:all:0'   },
  ],
] };

async function showWdAllMenu(query) {
  await bot.answerCallbackQuery(query.id);
  return bot.sendMessage(query.message.chat.id, '📜 *გატანების ისტორია — პერიოდი:*', {
    parse_mode: 'Markdown',
    reply_markup: WD_PERIOD_KB,
  });
}

async function onWdAll(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId  = query.message.chat.id;
  const parts   = query.data.split(':');   // adm_wdall:{period}:{page}
  const period  = parts[1];
  const page    = parseInt(parts[2], 10) || 0;
  const offset  = page * 10;

  const { rows, total } = await getAllWithdrawals(period, offset);

  if (!total) {
    return bot.sendMessage(chatId,
      `📜 *${WD_PERIOD_LABELS[period]}* — გატანა არ ყოფილა.`,
      { parse_mode: 'Markdown', reply_markup: WD_PERIOD_KB }
    );
  }

  const lines = rows.map((w, i) => {
    const dt     = new Date(w.created_at);
    const date   = dt.toLocaleDateString('ka-GE');
    const time   = dt.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' });
    const method = w.method === 'card' ? '💳' : '💵';
    const admin  = w.admin_name || '—';
    const drv    = `${w.driver_name || '—'}${w.driver_phone ? ` | 📞 ${w.driver_phone}` : ''}`;
    return `${offset + i + 1}. ${method} *${w.amount} ₾* | ${date} ${time}\n   👤 ${drv}\n   ⚙️ ${admin}`;
  });

  const totalPages = Math.ceil(total / 10);
  const navRow     = [];
  if (page > 0)              navRow.push({ text: '← წინა',    callback_data: `adm_wdall:${period}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page + 1 < totalPages) navRow.push({ text: 'შემდეგი →', callback_data: `adm_wdall:${period}:${page + 1}` });

  const kb = { inline_keyboard: [] };
  if (navRow.length > 1) kb.inline_keyboard.push(navRow);
  kb.inline_keyboard.push([{ text: '🔄 პერიოდი', callback_data: 'adm_wdall_menu' }]);

  const header = `📜 *გატანები | ${WD_PERIOD_LABELS[period]}* (სულ: ${total})`;
  return bot.sendMessage(chatId,
    `${header}\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
}

// ══ WITHDRAWAL FLOW (inline-keyboard driven) ══════════════════════════════════

async function onWdDriverSelected(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId   = query.message.chat.id;
  const driverId = parseInt(query.data.split(':')[1], 10);

  // Reset wd — entry may come directly from driver profile
  getSession(chatId).wd = {};

  const driver = await findDriverById(driverId);
  if (!driver) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.');

  const adminName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ');
  updateWd(chatId, {
    driverId,
    driverName:        driver.full_name,
    driverBalance:     driver.balance,
    driverBankAccount: driver.bank_account || null,
    adminTelegramId:   query.from.id,
    adminName,
  });

  return bot.sendMessage(chatId,
    `👤 *${driver.full_name}*\n💰 ბალანსი: *${driver.balance} ₾*\n\n💳 გადახდის მეთოდი:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '💵 ქეშად',   callback_data: 'adm_wd_method:cash' },
        { text: '💳 ბარათით', callback_data: 'adm_wd_method:card' },
      ]] },
    }
  );
}

async function onWdMethod(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const method = query.data.split(':')[1];
  updateWd(chatId, { method });
  const { wd } = getSession(chatId);

  if (method === 'card') {
    if (wd.driverBankAccount) {
      setStep(chatId, STEPS.AWAIT_WD_AMOUNT);
      return bot.sendMessage(chatId,
        `💳 გადარიცხვა: *${wd.driverBankAccount}* ანგარიშზე\n\n💰 გატანის თანხა (₾):`,
        { parse_mode: 'Markdown', reply_markup: cancelKb() }
      );
    }
    setStep(chatId, STEPS.AWAIT_WD_BANK_ACCOUNT);
    return bot.sendMessage(chatId,
      '🏦 მძღოლს IBAN არ აქვს. შეიყვანეთ ბანკის ანგარიშის ნომერი:',
      { reply_markup: cancelKb() }
    );
  }

  setStep(chatId, STEPS.AWAIT_WD_AMOUNT);
  return bot.sendMessage(chatId,
    '💵 ქეშად\n\n💰 გატანის თანხა (₾):',
    { reply_markup: cancelKb() }
  );
}

async function onWdBankAccount(chatId, text) {
  const iban = text?.trim();
  if (!iban) return bot.sendMessage(chatId, '⚠️ ჩაწერეთ IBAN:');

  const { wd } = getSession(chatId);
  await updateDriverField(wd.driverId, 'bank_account', iban);
  updateWd(chatId, { driverBankAccount: iban });
  setStep(chatId, STEPS.AWAIT_WD_AMOUNT);

  return bot.sendMessage(chatId,
    `💳 გადარიცხვა: *${iban}* ანგარიშზე\n\n💰 გატანის თანხა (₾):`,
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onWdAmount(chatId, text) {
  const amount = parseAmount(text);
  if (!amount) return bot.sendMessage(chatId, '⚠️ დადებითი რიცხვი:');

  const { wd } = getSession(chatId);
  const { driverId, driverName, driverBalance, method, adminTelegramId, adminName } = wd;

  await recordWithdrawal(driverId, amount, method, { telegramId: adminTelegramId, name: adminName, phone: null });
  const newBalance  = parseFloat(driverBalance) - amount;
  const methodLabel = method === 'card' ? '💳 ბარათი' : '💵 ქეშად';
  clearWd(chatId);

  return bot.sendMessage(chatId,
    `✅ *გატანა ჩაიწერა*\n👤 *${driverName}*\n${methodLabel}: ➖ ${amount} ₾\n💰 ახალი ბალანსი: *${newBalance.toFixed(2)} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
  );
}

async function onWdHistDriver(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId   = query.message.chat.id;
  const driverId = parseInt(query.data.split(':')[1], 10);

  const [history, driver] = await Promise.all([
    getDriverWithdrawalHistory(driverId),
    findDriverById(driverId),
  ]);

  if (!driver) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.');
  if (!history.length) {
    return bot.sendMessage(chatId,
      `📋 *${driver.full_name}* — გატანა ჯერ არ ყოფილა.`,
      { parse_mode: 'Markdown' }
    );
  }

  const lines = history.map((w, i) => {
    const date        = new Date(w.created_at).toLocaleDateString('ka-GE');
    const time        = new Date(w.created_at).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' });
    const methodLabel = w.method === 'card' ? '💳' : '💵';
    const note        = w.note ? ` | ${w.note}` : '';
    return `${i + 1}. ${methodLabel} *${w.amount} ₾* | ${date} ${time}${note}`;
  });

  return bot.sendMessage(chatId,
    `📋 *${driver.full_name}* — გატანის ისტორია (ბოლო ${history.length}):\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ══ PASSENGER MANAGEMENT ═════════════════════════════════════════════════════

const PASS_PAGE_SIZE = 8;

const PASS_FIELD_LABELS = { full_name: 'სახელი', phone: 'ტელეფონი' };

async function showPassengerMenu(chatId) {
  return bot.sendMessage(chatId, '👥 *მგზავრები:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '📋 ყველა მგზავარი', callback_data: 'adm_pass_list:0' }],
      [{ text: '🔍 ძებნა',           callback_data: 'adm_pass_search' }],
    ]},
  });
}

async function showPassengerList(chatId, page = 0) {
  const [passengers, total] = await Promise.all([
    getAllPassengers({ limit: PASS_PAGE_SIZE, offset: page * PASS_PAGE_SIZE }),
    countPassengers(),
  ]);

  if (!passengers.length) return bot.sendMessage(chatId, '👥 მგზავრები ვერ მოიძებნა.');

  const rows = passengers.map(p => {
    const active = p.is_active !== false ? '✅' : '🔴';
    const name   = p.full_name || p.phone || '?';
    return [{ text: `${active} ${name}`, callback_data: `adm_pass:${p.id}` }];
  });

  const totalPages = Math.ceil(total / PASS_PAGE_SIZE);
  const navRow     = [];
  if (page > 0)              navRow.push({ text: '← წინა',    callback_data: `adm_pass_list:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page + 1 < totalPages) navRow.push({ text: 'შემდეგი →', callback_data: `adm_pass_list:${page + 1}` });
  if (navRow.length > 1) rows.push(navRow);

  return bot.sendMessage(chatId, `👥 *მგზავრები* (სულ: ${total}):`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showPassengerProfile(chatId, passengerId) {
  const [p, ostats] = await Promise.all([
    findPassengerById(passengerId),
    getPassengerOrderStats(passengerId),
  ]);
  if (!p) return bot.sendMessage(chatId, '⚠️ მგზავრი ვერ მოიძებნა.');

  const statusLabel = p.is_active !== false ? '✅ აქტიური' : '🔴 დაბლოკილი';
  const regDate     = new Date(p.created_at).toLocaleDateString('ka-GE');
  const disc        = parseFloat(p.discount_available) || 0;

  const text = [
    `👥 *${p.full_name || '—'}*`,
    `📱 Telegram ID: \`${p.telegram_id}\``,
    `📞 ტელეფონი: ${p.phone || '—'}`,
    `📅 რეგ.: ${regDate}`,
    `📦 შეკვეთები: ${ostats.total} სულ | ✅ ${ostats.completed} | ❌ ${ostats.cancelled}`,
    disc > 0 ? `💰 ფასდაკლება: ${disc} ₾` : null,
    statusLabel,
  ].filter(Boolean).join('\n');

  const toggleLabel = p.is_active !== false ? '🔴 გაბლოკვა' : '🟢 განბლოკვა';

  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✏️ სახელი',    callback_data: `adm_pass_edit:${p.id}:full_name` },
          { text: '📱 ტელეფონი', callback_data: `adm_pass_edit:${p.id}:phone`     },
        ],
        [{ text: '📜 შეკვ. ისტ.',  callback_data: `adm_pass_hist:${p.id}`     }],
        [{ text: toggleLabel,        callback_data: `adm_pass_toggle:${p.id}`  }],
        [{ text: '← უკან',           callback_data: 'adm_pass_back'            }],
      ],
    },
  });
}

async function onPassOrderHistory(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId      = query.message.chat.id;
  const passengerId = parseInt(query.data.split(':')[1], 10);

  const [history, p] = await Promise.all([
    getPassengerOrderHistory(passengerId),
    findPassengerById(passengerId),
  ]);

  if (!p) return bot.sendMessage(chatId, '⚠️ მგზავრი ვერ მოიძებნა.');

  const backBtn = { reply_markup: { inline_keyboard: [[{ text: '← უკან', callback_data: `adm_pass:${passengerId}` }]] } };

  if (!history.length) {
    return bot.sendMessage(chatId,
      `📜 *${p.full_name || '—'}* — შეკვეთები არ არის.`,
      { parse_mode: 'Markdown', ...backBtn }
    );
  }

  const ST = { completed: '✅', cancelled: '❌', pending: '⏳', accepted: '🚗', arrived: '📍', in_progress: '🚛' };
  const lines = history.map((o, i) => {
    const date   = new Date(o.created_at).toLocaleDateString('ka-GE');
    const icon   = ST[o.status] || '•';
    const pay    = o.payment_method === 'card' ? '💳' : '💵';
    const from   = (o.pickup_address      || '').substring(0, 16);
    const to     = (o.destination_address || '').substring(0, 16);
    const drv    = o.driver_name ? ` | 👤 ${o.driver_name}` : '';
    return `${i + 1}. ${icon} ${date} | ${o.price} ₾ ${pay}${drv}\n   📍 ${from} → ${to}`;
  });

  return bot.sendMessage(chatId,
    `📜 *${p.full_name || '—'}* — ბოლო ${history.length} შეკვ.:\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown', ...backBtn }
  );
}

async function onPassList(query) {
  await bot.answerCallbackQuery(query.id);
  const page = parseInt(query.data.split(':')[1], 10) || 0;
  return showPassengerList(query.message.chat.id, page);
}

async function onPassSearchStart(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  clearPassMgmt(chatId);
  setStep(chatId, STEPS.AWAIT_PASS_SEARCH);
  return bot.sendMessage(chatId, '🔍 სახელი ან ტელეფონის ნაწილი:', { reply_markup: cancelKb() });
}

async function onPassengerSearch(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ჩაწერეთ სახელი ან ტელეფონი:');
  clearPassMgmt(chatId);

  const results = await searchPassengers(text.trim());
  if (!results.length) return bot.sendMessage(chatId, '⚠️ მგზავრი ვერ მოიძებნა.', { reply_markup: mainMenu(chatId) });
  if (results.length === 1) return showPassengerProfile(chatId, results[0].id);

  const rows = results.map(p => {
    const active = p.is_active !== false ? '✅' : '🔴';
    const name   = p.full_name || p.phone || '?';
    return [{ text: `${active} ${name} | ${p.phone || '—'}`, callback_data: `adm_pass:${p.id}` }];
  });
  return bot.sendMessage(chatId, `🔍 *${results.length} შედეგი:*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function onPassProfile(query) {
  await bot.answerCallbackQuery(query.id);
  const id = parseInt(query.data.split(':')[1], 10);
  return showPassengerProfile(query.message.chat.id, id);
}

async function onPassEditStart(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const parts  = query.data.split(':');   // adm_pass_edit:{id}:{field}
  const id     = parseInt(parts[1], 10);
  const field  = parts[2];
  updatePassMgmt(chatId, { passengerId: id, editField: field });
  setStep(chatId, STEPS.AWAIT_PASS_EDIT_FIELD);
  return bot.sendMessage(chatId,
    `✏️ ახალი მნიშვნელობა — *${PASS_FIELD_LABELS[field] || field}*:`,
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onPassengerEditValue(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ მნიშვნელობა არ შეიძლება ცარიელი იყოს:');
  const { passMgmt } = getSession(chatId);
  const updated = await updatePassengerField(passMgmt.passengerId, passMgmt.editField, text.trim());
  clearPassMgmt(chatId);
  if (!updated) return bot.sendMessage(chatId, '⚠️ განახლება ვერ მოხდა. /cancel');
  return showPassengerProfile(chatId, updated.id);
}

async function onPassToggle(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const id     = parseInt(query.data.split(':')[1], 10);
  const result = await togglePassengerActive(id);
  if (!result) return bot.sendMessage(chatId, '⚠️ ვერ შეიცვალა სტატუსი.');
  const label  = result.is_active ? '✅ განბლოკილია' : '🔴 დაბლოკილია';
  await bot.sendMessage(chatId, `${label}: *${result.full_name || '—'}*`, { parse_mode: 'Markdown' });
  return showPassengerProfile(chatId, id);
}

// ══ DRIVER MANAGEMENT ════════════════════════════════════════════════════════

const DRV_PAGE_SIZE = 8;

async function showDriverMenu(chatId) {
  return bot.sendMessage(chatId, '🚚 *მძღოლები:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '📋 ყველა მძღოლი', callback_data: 'adm_drv_list:0' }],
      [{ text: '🔍 ძებნა',         callback_data: 'adm_drv_search' }],
    ]},
  });
}

async function showDriverList(chatId, page = 0) {
  const [drivers, total] = await Promise.all([
    getAllDrivers({ limit: DRV_PAGE_SIZE, offset: page * DRV_PAGE_SIZE }),
    countDrivers(),
  ]);

  if (!drivers.length) return bot.sendMessage(chatId, '🚚 მძღოლები ვერ მოიძებნა.');

  const rows = drivers.map(d => {
    const active = d.is_active ? '✅' : '🔴';
    const type   = d.truck_type === 'crane' ? '🏗' : '🚗';
    return [{ text: `${active} ${type} ${d.full_name}`, callback_data: `adm_drv:${d.id}` }];
  });

  const totalPages = Math.ceil(total / DRV_PAGE_SIZE);
  const navRow     = [];
  if (page > 0)              navRow.push({ text: '← წინა',    callback_data: `adm_drv_list:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page + 1 < totalPages) navRow.push({ text: 'შემდეგი →', callback_data: `adm_drv_list:${page + 1}` });
  if (navRow.length > 1) rows.push(navRow);

  return bot.sendMessage(chatId, `🚚 *მძღოლები* (სულ: ${total}):`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showDriverProfile(chatId, driverId) {
  const [d, stats] = await Promise.all([
    findDriverById(driverId),
    getDriverStats(driverId),
  ]);
  if (!d) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.');

  const statusLabel = d.is_active    ? '✅ აქტიური'       : '🔴 დაბლოკილი';
  const availLabel  = d.is_available ? '🟢 ხელმისაწვდომი' : '⚫ მიუწვდომელი';
  const typeLabel   = d.truck_type === 'crane' ? '🏗 ამწე' : '🚗 ჩვეულებრივი';
  const balTxt      = parseFloat(d.balance) < 0 ? `⚠️ ${d.balance} ₾` : `${d.balance} ₾`;
  const bonusTxt    = parseFloat(d.bonus_balance) > 0 ? `  🎁 ${d.bonus_balance} ₾` : '';
  const ratingTxt   = stats?.avg_rating
    ? `⭐ ${parseFloat(stats.avg_rating).toFixed(1)} avg (${parseInt(stats.rated_count)} შეფ.)`
    : '⭐ შეუფასებელი';

  const text = [
    `👤 *${d.full_name}*`,
    `📱 Telegram ID: \`${d.telegram_id}\``,
    `📞 ტელეფონი: ${d.phone}`,
    `🚛 ${typeLabel} | 🚘 ${d.car_model || '—'} | ნომ: ${d.car_plate || '—'}`,
    `💰 ბალანსი: ${balTxt}${bonusTxt}`,
    ratingTxt,
    `🏦 IBAN: ${d.bank_account || '—'}`,
    `${statusLabel} | ${availLabel}`,
  ].join('\n');

  const toggleLabel = d.is_active ? '🔴 გაბლოკვა' : '🟢 განბლოკვა';

  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✏️ სახელი',    callback_data: `adm_drv_edit:${d.id}:full_name`    },
          { text: '📱 ტელეფონი', callback_data: `adm_drv_edit:${d.id}:phone`         },
        ],
        [
          { text: '🚘 მოდელი', callback_data: `adm_drv_edit:${d.id}:car_model`   },
          { text: '🔢 ნომერი', callback_data: `adm_drv_edit:${d.id}:car_plate`   },
        ],
        [{ text: '🏦 ანგარიში (IBAN)', callback_data: `adm_drv_edit:${d.id}:bank_account` }],
        [
          { text: '➖ ფულის გატანა',  callback_data: `adm_wd_drv:${d.id}`       },
          { text: '📜 გატანის ისტ.',   callback_data: `adm_wdhist_drv:${d.id}`  },
        ],
        [{ text: toggleLabel,           callback_data: `adm_drv_toggle:${d.id}` }],
        [{ text: '← უკან',              callback_data: 'adm_drv_back'           }],
      ],
    },
  });
}

async function onDrvList(query) {
  await bot.answerCallbackQuery(query.id);
  const page = parseInt(query.data.split(':')[1], 10) || 0;
  return showDriverList(query.message.chat.id, page);
}

async function onDrvSearchStart(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  clearDrvMgmt(chatId);
  setStep(chatId, STEPS.AWAIT_DRV_SEARCH);
  return bot.sendMessage(chatId, '🔍 სახელი ან ტელეფონის ნაწილი:', { reply_markup: cancelKb() });
}

async function onDriverSearch(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ ჩაწერეთ სახელი ან ტელეფონი:');
  clearDrvMgmt(chatId);

  const results = await searchDrivers(text.trim());
  if (!results.length) return bot.sendMessage(chatId, '⚠️ მძღოლი ვერ მოიძებნა.', { reply_markup: mainMenu(chatId) });
  if (results.length === 1) return showDriverProfile(chatId, results[0].id);

  const rows = results.map(d => {
    const active = d.is_active ? '✅' : '🔴';
    const type   = d.truck_type === 'crane' ? '🏗' : '🚗';
    return [{ text: `${active} ${type} ${d.full_name} | ${d.phone || '—'}`, callback_data: `adm_drv:${d.id}` }];
  });
  return bot.sendMessage(chatId, `🔍 *${results.length} შედეგი:*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function onDrvProfile(query) {
  await bot.answerCallbackQuery(query.id);
  const id = parseInt(query.data.split(':')[1], 10);
  return showDriverProfile(query.message.chat.id, id);
}

const FIELD_LABELS = {
  full_name:    'სახელი',
  phone:        'ტელეფონი',
  car_model:    'მანქანის მოდელი',
  car_plate:    'სახ. ნომერი',
  bank_account: 'ბანკ. ანგარიში (IBAN)',
};

async function onDrvEditStart(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const parts  = query.data.split(':');   // adm_drv_edit:{id}:{field}
  const id     = parseInt(parts[1], 10);
  const field  = parts[2];
  updateDrvMgmt(chatId, { driverId: id, editField: field });
  setStep(chatId, STEPS.AWAIT_DRV_EDIT_FIELD);
  return bot.sendMessage(chatId,
    `✏️ ახალი მნიშვნელობა — *${FIELD_LABELS[field] || field}*:`,
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onDriverEditValue(chatId, text) {
  if (!text?.trim()) return bot.sendMessage(chatId, '⚠️ მნიშვნელობა არ შეიძლება ცარიელი იყოს:');
  const { drvMgmt } = getSession(chatId);
  const updated = await updateDriverField(drvMgmt.driverId, drvMgmt.editField, text.trim());
  clearDrvMgmt(chatId);
  if (!updated) return bot.sendMessage(chatId, '⚠️ განახლება ვერ მოხდა. /cancel');
  return showDriverProfile(chatId, updated.id);
}

async function onDrvToggle(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const id     = parseInt(query.data.split(':')[1], 10);
  const result = await toggleDriverActive(id);
  if (!result) return bot.sendMessage(chatId, '⚠️ ვერ შეიცვალა სტატუსი.');
  const label  = result.is_active ? '✅ განბლოკილია' : '🔴 დაბლოკილია';
  await bot.sendMessage(chatId, `${label}: *${result.full_name}*`, { parse_mode: 'Markdown' });
  return showDriverProfile(chatId, id);
}

async function onCancelInput(query) {
  const chatId = query.message.chat.id;
  clearOrder(chatId); clearBonus(chatId); clearWd(chatId);
  clearDrvMgmt(chatId); clearPassMgmt(chatId); clearBroadcast(chatId);
  clearAdminMgmt(chatId); clearPricing(chatId); clearBonusCfg(chatId);
  setStep(chatId, STEPS.IDLE);
  await bot.answerCallbackQuery(query.id, { text: '❌ გაუქმდა.' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});
  return bot.sendMessage(chatId, '↩️ გაუქმდა.', { reply_markup: mainMenu(chatId) });
}

// ══ PRICING MANAGEMENT ═══════════════════════════════════════════════════════

const PRICING_KEYS = {
  base_fare:              { label: '🏁 საბაზო ფასი',         unit: '₾',  validate: v => v > 0 },
  price_per_km:           { label: '📏 ფასი/კმ',              unit: '₾',  validate: v => v > 0 },
  jeep_surcharge:         { label: '🚐 ჯიპი (surcharge)',     unit: '%',  validate: v => v >= 0 && v <= 1 },
  large_vehicle_surcharge:{ label: '🚌 დიდი ავტ. (surcharge)', unit: '%', validate: v => v >= 0 && v <= 1 },
  non_rolling_surcharge:  { label: '🏗 ამწე (surcharge)',      unit: '%',  validate: v => v >= 0 && v <= 1 },
};

async function showPricingMenu(chatId) {
  const cfg = await getPricingConfig().catch(() => null);
  const rows = Object.entries(PRICING_KEYS).map(([key, meta]) => {
    let val = cfg ? cfg[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] : '?';
    if (meta.unit === '%' && typeof val === 'number') val = `${(val * 100).toFixed(0)}%`;
    else if (typeof val === 'number') val = `${val} ${meta.unit}`;
    return [{ text: `${meta.label}: ${val}`, callback_data: `adm_price:${key}` }];
  });
  return bot.sendMessage(chatId, '💲 *ფასების მართვა* — შეარჩიეთ პარამეტრი:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function onPricingKey(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const key    = query.data.split(':')[1];
  const meta   = PRICING_KEYS[key];
  if (!meta) return;

  const cfg = await getPricingConfig().catch(() => null);
  const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  let current = cfg ? cfg[camelKey] : null;
  if (meta.unit === '%' && typeof current === 'number') current = `${(current * 100).toFixed(0)}%`;
  else if (typeof current === 'number') current = `${current} ${meta.unit}`;

  updatePricing(chatId, { key });
  setStep(chatId, STEPS.AWAIT_PRICING_VALUE);

  const hint = meta.unit === '%'
    ? 'შეიყვანეთ 0-დან 100-მდე (მაგ. 15 = 15%)'
    : 'შეიყვანეთ დადებითი რიცხვი';
  return bot.sendMessage(chatId,
    `${meta.label}\n📌 ამჟამინდელი: *${current ?? '—'}*\n\n✏️ ახალი მნიშვნელობა (${hint}):`,
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onPricingValue(chatId, text) {
  const { pricing } = getSession(chatId);
  const meta = PRICING_KEYS[pricing.key];
  if (!meta) { clearPricing(chatId); return; }

  let num = parseFloat(text?.replace(',', '.'));
  if (isNaN(num)) return bot.sendMessage(chatId, '⚠️ რიცხვი შეიყვანეთ:');

  if (meta.unit === '%') num = num / 100;
  if (!meta.validate(num)) {
    const hint = meta.unit === '%' ? '0–100 შორის' : 'დადებითი';
    return bot.sendMessage(chatId, `⚠️ მნიშვნელობა უნდა იყოს ${hint}.`);
  }

  await updatePricingConfig(pricing.key, num);
  clearPricing(chatId);
  await bot.sendMessage(chatId,
    `✅ *${meta.label}* განახლდა → ${meta.unit === '%' ? `${(num * 100).toFixed(0)}%` : `${num} ${meta.unit}`}`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
  );
  return showPricingMenu(chatId);
}

// ══ BONUS CONFIG (threshold / amount / commission) ════════════════════════════

const BONUS_CFG_KEYS = {
  bonus_threshold:  { label: '🎯 ბონუსის threshold (შეკვ.)', unit: 'შეკვ.', validate: v => v > 0 },
  bonus_amount:     { label: '💰 ბონუსის თანხა',              unit: '₾',     validate: v => v > 0 },
  commission_rate:  { label: '💼 საკომისიო',                   unit: '%',     validate: v => v >= 0 && v <= 1 },
};

async function showBonusConfig(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const cfg    = await getPricingConfig().catch(() => null);
  const rows   = Object.entries(BONUS_CFG_KEYS).map(([key, meta]) => {
    let val = '?';
    if (cfg) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      val = cfg[camel];
      if (meta.unit === '%' && typeof val === 'number') val = `${(val * 100).toFixed(0)}%`;
      else if (typeof val === 'number') val = `${val} ${meta.unit}`;
    }
    return [{ text: `${meta.label}: ${val}`, callback_data: `adm_boncfg:${key}` }];
  });
  return bot.sendMessage(chatId, '⚙️ *ბონუს პარამეტრები* — შეარჩიეთ:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function onBonusCfgKey(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const key    = query.data.split(':')[1];
  const meta   = BONUS_CFG_KEYS[key];
  if (!meta) return;

  const cfg    = await getPricingConfig().catch(() => null);
  const camel  = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  let current  = cfg ? cfg[camel] : null;
  if (meta.unit === '%' && typeof current === 'number') current = `${(current * 100).toFixed(0)}%`;
  else if (typeof current === 'number') current = `${current} ${meta.unit}`;

  updateBonusCfg(chatId, { key });
  setStep(chatId, STEPS.AWAIT_BONUS_CONFIG_VALUE);

  const hint = meta.unit === '%'
    ? 'შეიყვანეთ 0-დან 100-მდე (მაგ. 15 = 15%)'
    : 'შეიყვანეთ დადებითი რიცხვი';
  return bot.sendMessage(chatId,
    `${meta.label}\n📌 ამჟამინდელი: *${current ?? '—'}*\n\n✏️ ახალი მნიშვნელობა (${hint}):`,
    { parse_mode: 'Markdown', reply_markup: cancelKb() }
  );
}

async function onBonusCfgValue(chatId, text) {
  const { bonusCfg } = getSession(chatId);
  const meta = BONUS_CFG_KEYS[bonusCfg.key];
  if (!meta) { clearBonusCfg(chatId); return; }

  let num = parseFloat(text?.replace(',', '.'));
  if (isNaN(num)) return bot.sendMessage(chatId, '⚠️ რიცხვი შეიყვანეთ:');

  if (meta.unit === '%') num = num / 100;
  if (!meta.validate(num)) {
    const hint = meta.unit === '%' ? '0–100 შორის' : 'დადებითი';
    return bot.sendMessage(chatId, `⚠️ მნიშვნელობა უნდა იყოს ${hint}.`);
  }

  await updatePricingConfig(bonusCfg.key, num);
  clearBonusCfg(chatId);
  return bot.sendMessage(chatId,
    `✅ *${meta.label}* განახლდა → ${meta.unit === '%' ? `${(num * 100).toFixed(0)}%` : `${num} ${meta.unit}`}`,
    { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
  );
}

// ══ ADMIN MANAGEMENT (owner only) ════════════════════════════════════════════

async function showAdminMgmt(chatId) {
  const admins = await getAllAdmins();
  const lines  = admins.length
    ? admins.map(a => `• ${a.role === 'admin' ? '👮' : '🛡'} *${a.name || a.telegram_id}* (${a.telegram_id}) — ${a.role}`).join('\n')
    : '_ადმინები არ არიან_';

  return bot.sendMessage(chatId,
    `👮 *ადმინების მართვა*\n\n${lines}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '➕ ახალი ადმინი/მოდერატორი', callback_data: 'adm_admgmt:add' }],
        ...(admins.length ? [[{ text: '➖ წაშლა', callback_data: 'adm_admgmt:remove_list' }]] : []),
      ]},
    }
  );
}

async function onAdminMgmtCallback(query) {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const action = query.data.split(':')[1];

  if (action === 'add') {
    clearAdminMgmt(chatId);
    setStep(chatId, STEPS.AWAIT_ADMIN_ADD_ID);
    return bot.sendMessage(chatId,
      '➕ ახალი ადმინის/მოდერატორის *Telegram ID* (რიცხვი):',
      { parse_mode: 'Markdown', reply_markup: cancelKb() }
    );
  }

  if (action === 'remove_list') {
    const admins = await getAllAdmins();
    if (!admins.length) return bot.sendMessage(chatId, '⚠️ ადმინები ვერ მოიძებნა.');
    const rows = admins.map(a => [{
      text: `${a.role === 'admin' ? '👮' : '🛡'} ${a.name || a.telegram_id} (${a.telegram_id})`,
      callback_data: `adm_admgmt:remove:${a.telegram_id}`,
    }]);
    return bot.sendMessage(chatId, '➖ ვინ წაიშალოს?', {
      reply_markup: { inline_keyboard: rows },
    });
  }

  if (action === 'remove') {
    const targetId = parseInt(query.data.split(':')[2], 10);
    const removed  = await removeAdmin(targetId);
    if (!removed) return bot.sendMessage(chatId, '⚠️ ვერ მოიძებნა.');
    return bot.sendMessage(chatId,
      `✅ *${removed.name || removed.telegram_id}* (${removed.role}) წაიშალა.`,
      { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
    );
  }

  if (action === 'role_admin' || action === 'role_moderator') {
    const { adminMgmt } = getSession(chatId);
    const role = action === 'role_admin' ? 'admin' : 'moderator';
    const name = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || null;
    const saved = await addAdmin(adminMgmt.pendingId, adminMgmt.pendingName || null, role, query.from.id);
    clearAdminMgmt(chatId);
    const roleLabel = role === 'admin' ? '👮 ადმინი' : '🛡 მოდერატორი';
    return bot.sendMessage(chatId,
      `✅ *${saved.name || saved.telegram_id}* (${saved.telegram_id}) დაემატა — ${roleLabel}`,
      { parse_mode: 'Markdown', reply_markup: mainMenu(chatId) }
    );
  }
}

async function onAdminAddId(chatId, text) {
  const id = parseInt(text?.trim(), 10);
  if (!id || isNaN(id)) return bot.sendMessage(chatId, '⚠️ მოქმედი Telegram ID (რიცხვი):');
  if (id === config.admin.telegramId) return bot.sendMessage(chatId, '⚠️ owner-ის ID ვერ დაემატება.');
  updateAdminMgmt(chatId, { pendingId: id });
  setStep(chatId, STEPS.IDLE);
  return bot.sendMessage(chatId,
    `Telegram ID: \`${id}\`\n\nაირჩიეთ როლი:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '👮 ადმინი',      callback_data: 'adm_admgmt:role_admin'     },
        { text: '🛡 მოდერატორი', callback_data: 'adm_admgmt:role_moderator' },
      ]] },
    }
  );
}

// ── Error handling ────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => logger.error('Admin bot polling error', { error: err.message }));

logger.info('Admin bot started');
module.exports = bot;
