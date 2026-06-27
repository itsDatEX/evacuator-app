'use strict';

const { TelegramBot } = require('node-telegram-bot-api');
const config      = require('../config');
const logger      = require('../shared/logger');
const {
  STEPS, getSession, setStep,
  updateReg, updateRoute, clearReg, clearRouteSession,
  clearSelfEdit, clearSelfWd,
} = require('./sessions');
const {
  findByTelegramId, createDriver,
  setAvailability, setRoute, clearRoute,
  updateDriverLocation, updateDriverField,
} = require('../shared/driverService');
const {
  acceptOrder, arriveOrder, startOrder, completeOrder, settleOrder,
  getDriverHistory, getDriverStats, getEligibleDrivers,
  ratePassenger, getOrderById,
  getDriverWithdrawalsToday, recordSelfWithdrawal,
  getPendingOrdersMatchingDriver,
} = require('../shared/orderService');
const { reverseGeocode, forwardGeocode } = require('../shared/geocoder');
const notifier = require('../shared/notifier');

const bot = new TelegramBot(config.telegram.driverToken, { polling: true });

const ARRIVED_THRESHOLD_KM  = 1;
const COMPLETE_THRESHOLD_KM = 3;

const DAILY_WD_LIMIT = 500;
function calcCommission(amount) { return amount < 300 ? 1 : 2; }

const SELF_EDIT_LABELS = {
  phone:        '📱 ტელეფონის ნომერი',
  car_model:    '🚘 მანქანის მოდელი',
  car_plate:    '🔢 სანომრე ნიშანი',
  bank_account: '🏦 საბანკო ანგარიში (IBAN)',
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Keyboard / display helpers ─────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '✅ ხელმისაწვდომი ვარ' }, { text: '❌ მიუწვდომელი ვარ' }],
      [{ text: '📋 ჩემი შეკვეთები' },    { text: '⭐ სტატისტიკა' }],
      [{ text: '💰 ჩემი ბალანსი' },      { text: '💸 ფულის გატანა' }],
      [{ text: '✏️ ჩემი მონაცემები' }],
    ],
    resize_keyboard: true,
  };
}

function cancelKeyboard() {
  return { inline_keyboard: [[{ text: '❌ გაუქმება', callback_data: 'cancel_input' }]] };
}

function locationMethodKeyboard() {
  return {
    keyboard: [
      [{ text: '📍 GPS ლოკაცია', request_location: true }],
      [{ text: '✏️ მისამართის ჩაწერა' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function greetingText(driver) {
  const status = driver.is_available ? '✅ ხელმისაწვდომი' : '❌ მიუწვდომელი';
  const route  = driver.route_from
    ? `🛣️ ${driver.route_from} → ${driver.route_to}`
    : '—';
  return (
    `👷 *${driver.full_name}*\n\n` +
    `სტატუსი: ${status}\n` +
    `მარშრუტი: ${route}\n\n` +
    'აირჩიეთ მოქმედება:'
  );
}

// ── /start ─────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const driver = await findByTelegramId(msg.from.id);
    if (driver) {
      setStep(chatId, STEPS.IDLE);
      return bot.sendMessage(chatId, greetingText(driver), {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard(),
      });
    }
    setStep(chatId, STEPS.AWAIT_REG_NAME);
    return bot.sendMessage(
      chatId,
      'გამარჯობა! EvakBot-ის მძღოლის პანელში მოგესალმებით. 🚛\n\n' +
      'რეგისტრაციისთვის შეიყვანეთ სახელი და გვარი:',
      { reply_markup: { remove_keyboard: true } }
    );
  } catch (err) {
    logger.error('/start driver error', { chatId, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /start ხელახლა.');
  }
});

// ── /cancel ────────────────────────────────────────────────────────────────────

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  clearRouteSession(chatId);
  clearReg(chatId);
  setStep(chatId, STEPS.IDLE);
  const driver = await findByTelegramId(msg.from.id).catch(() => null);
  bot.sendMessage(chatId, '↩️ მოქმედება გაუქმდა.', {
    reply_markup: driver ? mainMenuKeyboard() : { remove_keyboard: true },
  });
});

// ── Main message router ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text?.startsWith('/')) return;

  const { step } = getSession(chatId);

  try {
    // Silently capture any location share (live or one-time) to keep driver GPS fresh
    if (msg.location) {
      const driverForLoc = await findByTelegramId(msg.from.id).catch(() => null);
      if (driverForLoc) {
        await updateDriverLocation(driverForLoc.telegram_id, msg.location.latitude, msg.location.longitude)
          .catch(() => {});
      }
    }

    switch (step) {
      case STEPS.AWAIT_REG_NAME:  await onRegName(msg);  break;
      case STEPS.AWAIT_REG_PHONE: await onRegPhone(msg); break;
      case STEPS.AWAIT_CAR_MODEL: await onCarModel(msg); break;
      case STEPS.AWAIT_PLATE:     await onPlate(msg);    break;

      case STEPS.AWAIT_ROUTE_FROM_METHOD:
        if (msg.location) await onRouteFromGps(msg);
        else if (msg.text === '✏️ მისამართის ჩაწერა') await onRouteFromMethodText(msg);
        else bot.sendMessage(chatId, '📍 გამოიყენეთ ქვემოთ მოცემული ღილაკი.');
        break;

      case STEPS.AWAIT_ROUTE_FROM_TEXT:
        if (msg.text) await onRouteFromText(msg);
        break;

      case STEPS.AWAIT_ROUTE_TO_METHOD:
        if (msg.location) await onRouteToGps(msg);
        else if (msg.text === '✏️ მისამართის ჩაწერა') await onRouteToMethodText(msg);
        else bot.sendMessage(chatId, '📍 გამოიყენეთ ქვემოთ მოცემული ღილაკი.');
        break;

      case STEPS.AWAIT_ROUTE_TO_TEXT:
        if (msg.text) await onRouteToText(msg);
        break;

      case STEPS.IDLE: await onMenuAction(msg); break;

      case STEPS.AWAIT_SELF_EDIT_FIELD: await onSelfEditValue(msg);  break;
      case STEPS.AWAIT_SELF_WD_BANK:    await onSelfWdBank(msg);    break;
      case STEPS.AWAIT_SELF_WD_AMOUNT:  await onSelfWdAmount(msg);  break;

      case STEPS.AWAIT_AVAIL_LOCATION:
        if (msg.location) await onAvailLocation(msg);
        else bot.sendMessage(chatId, '📍 გამოიყენეთ ღილაკი ლოკაციის გასაზიარებლად.');
        break;

      default: break; // AWAIT_TRUCK_TYPE, AWAIT_ROUTE_FROM_CONFIRM, AWAIT_ROUTE_TO_CONFIRM, AWAIT_ROUTE_DEPARTURE: callback-only
    }
  } catch (err) {
    logger.error('Driver bot message error', { chatId, step, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /start ხელახლა.');
  }
});

// ── Availability with GPS ─────────────────────────────────────────────────────

async function onAvailLocation(msg) {
  const chatId = msg.chat.id;
  // location already saved by the silent capture at the top of the handler
  const driver = await findByTelegramId(msg.from.id);
  if (!driver) return;

  await setAvailability(driver.telegram_id, true);
  setStep(chatId, STEPS.IDLE);

  const pending = await getPendingOrdersMatchingDriver(driver);
  if (pending.length > 0) {
    await bot.sendMessage(chatId,
      `✅ ლოკაცია მიღებული! ხელმისაწვდომი ხართ. *${pending.length}* მოლოდინში შეკვეთა გამოგეგზავნათ:`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    return notifier.notifyDriverOfPendingOrders(driver, pending);
  }
  return bot.sendMessage(chatId,
    '✅ ლოკაცია მიღებული! ახლა ხელმისაწვდომი ხართ.',
    { reply_markup: mainMenuKeyboard() });
}

// ── Registration ───────────────────────────────────────────────────────────────

async function onRegName(msg) {
  const chatId = msg.chat.id;
  const name   = msg.text?.trim();
  if (!name || name.length < 2) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სრული სახელი (მინ. 2 სიმბოლო).');
  }
  updateReg(chatId, { name });
  setStep(chatId, STEPS.AWAIT_REG_PHONE);
  return bot.sendMessage(chatId, `✅ ${name}\n\nახლა გაუზიარეთ ტელეფონის ნომერი:`, {
    reply_markup: {
      keyboard: [[{ text: '📱 ნომრის გაზიარება', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function onRegPhone(msg) {
  const chatId = msg.chat.id;
  let phone = null;
  if (msg.contact) {
    phone = msg.contact.phone_number;
  } else if (msg.text && /^\+?[\d\s\-]{7,15}$/.test(msg.text)) {
    phone = msg.text.trim();
  } else {
    return bot.sendMessage(chatId, '⚠️ გამოიყენეთ "📱 ნომრის გაზიარება" ღილაკი.');
  }
  updateReg(chatId, { phone });
  setStep(chatId, STEPS.AWAIT_TRUCK_TYPE);
  return bot.sendMessage(chatId, '🚛 აირჩიეთ სატვირთოს ტიპი:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🚛 ჩვეულებრივი ევაკუატორი', callback_data: 'reg_truck:regular' },
        { text: '🏗️ ამწე (crane)',             callback_data: 'reg_truck:crane'   },
      ]],
    },
  });
}

async function onCarModel(msg) {
  const chatId = msg.chat.id;
  const model  = msg.text?.trim();
  if (!model || model.length < 2) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ მანქანის მოდელი (მინ. 2 სიმბოლო).');
  }
  updateReg(chatId, { carModel: model });
  setStep(chatId, STEPS.AWAIT_PLATE);
  return bot.sendMessage(chatId,
    `✅ ${model}\n\n🔢 შეიყვანეთ სანომრე ნიშანი (მაგ: GD-123-AB):`);
}

async function onPlate(msg) {
  const chatId = msg.chat.id;
  const plate  = msg.text?.trim().toUpperCase();
  if (!plate || plate.length < 3) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სანომრე ნიშანი (მინ. 3 სიმბოლო).');
  }
  const { reg } = getSession(chatId);
  const driver  = await createDriver({
    telegramId: msg.from.id,
    username:   msg.from.username || null,
    fullName:   reg.name,
    phone:      reg.phone,
    truckType:  reg.truckType,
    carModel:   reg.carModel,
    carPlate:   plate,
  });
  clearReg(chatId);
  setStep(chatId, STEPS.IDLE);
  return bot.sendMessage(
    chatId,
    `🎉 რეგისტრაცია დასრულდა!\n\n${greetingText(driver)}`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

// ── Menu actions (IDLE) ────────────────────────────────────────────────────────

async function onMenuAction(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text;

  const driver = await findByTelegramId(msg.from.id);
  if (!driver) {
    setStep(chatId, STEPS.AWAIT_REG_NAME);
    return bot.sendMessage(chatId, '⚠️ ჯერ რეგისტრაცია გაიარეთ. შეიყვანეთ სახელი:',
      { reply_markup: { remove_keyboard: true } });
  }

  switch (text) {
    case '✅ ხელმისაწვდომი ვარ': {
      if (!driver.current_lat) {
        setStep(chatId, STEPS.AWAIT_AVAIL_LOCATION);
        return bot.sendMessage(chatId,
          '📍 გთხოვ, ჩართე ლოკაცია, რომ ხელმისაწვდომი გახდე:',
          {
            reply_markup: {
              keyboard: [[{ text: '📍 ლოკაციის გაზიარება', request_location: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        );
      }
      await setAvailability(driver.telegram_id, true);
      if (driver.current_lat) {
        const pending = await getPendingOrdersMatchingDriver(driver);
        if (pending.length > 0) {
          await bot.sendMessage(chatId,
            `✅ ხელმისაწვდომი ხართ. *${pending.length}* მოლოდინში შეკვეთა გამოგეგზავნათ:`,
            { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
          await notifier.notifyDriverOfPendingOrders(driver, pending);
          return;
        }
      }
      return bot.sendMessage(chatId, '✅ სტატუსი განახლდა — ხელმისაწვდომი ხართ. ახალი შეკვეთები მოვა.',
        { reply_markup: mainMenuKeyboard() });
    }

    case '❌ მიუწვდომელი ვარ':
      await setAvailability(driver.telegram_id, false);
      return bot.sendMessage(chatId, '❌ სტატუსი განახლდა — მიუწვდომელი ხართ.',
        { reply_markup: mainMenuKeyboard() });

    case '🛣️ მარშრუტზე ვარ':
      clearRouteSession(chatId);
      setStep(chatId, STEPS.AWAIT_ROUTE_FROM_METHOD);
      return bot.sendMessage(chatId, '📍 საიდან მიდიხართ? — აირჩიეთ ვარიანტი:', {
        reply_markup: locationMethodKeyboard(),
      });

    case '🗑️ მარშრუტი გავასუფთავე':
      await clearRoute(driver.telegram_id);
      return bot.sendMessage(chatId, '🗑️ მარშრუტი გასუფთავდა. ახლა ყველა შეკვეთა მოვა.',
        { reply_markup: mainMenuKeyboard() });

    case '📋 ჩემი შეკვეთები':
      return showHistory(chatId, driver.id);

    case '⭐ სტატისტიკა':
      return showStats(chatId, driver.id);

    case '💰 ჩემი ბალანსი':
      return showBalance(chatId, driver);

    case '✏️ ჩემი მონაცემები':
      return showSelfEditMenu(chatId, driver);

    case '💸 ფულის გატანა':
      return onSelfWdStart(chatId, driver);
  }
}

// ── Route from — GPS branch ────────────────────────────────────────────────────

async function onRouteFromGps(msg) {
  const chatId = msg.chat.id;
  const { latitude: lat, longitude: lng } = msg.location;

  await bot.sendMessage(chatId, '⏳ ვამოწმებ ადგილს...');
  const city = await reverseGeocode(lat, lng);
  const label = city || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  getSession(chatId).pending = { lat, lng, label, city };
  await bot.sendLocation(chatId, lat, lng);
  setStep(chatId, STEPS.AWAIT_ROUTE_FROM_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${label}\n\nეს სწორი ადგილია (საიდან)?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ სწორია',          callback_data: 'geo_confirm:ok'    },
          { text: '🔄 ხელახლა ჩაწერა', callback_data: 'geo_confirm:retry' },
        ]],
      },
    }
  );
}

// ── Route from — text branch ───────────────────────────────────────────────────

async function onRouteFromMethodText(msg) {
  const chatId = msg.chat.id;
  setStep(chatId, STEPS.AWAIT_ROUTE_FROM_TEXT);
  return bot.sendMessage(
    chatId,
    '✏️ ჩაწერეთ საიდან მიდიხართ:\n_(მაგ: თბილისი, ან ჭავჭავაძის 1)_',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
}

async function onRouteFromText(msg) {
  const chatId = msg.chat.id;
  const query  = msg.text?.trim();
  if (!query || query.length < 2) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ ადგილი (მინ. 2 სიმბოლო).');
  }
  await bot.sendMessage(chatId, '⏳ ვეძებ მისამართს...');
  const result = await forwardGeocode(query);
  if (!result) {
    return bot.sendMessage(chatId, '❌ ადგილი ვერ მოიძებნა. სცადეთ სხვა ფორმულირება:');
  }
  getSession(chatId).pending = { lat: result.lat, lng: result.lng, label: result.displayName, city: result.city };
  await bot.sendLocation(chatId, result.lat, result.lng);
  setStep(chatId, STEPS.AWAIT_ROUTE_FROM_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${result.displayName}\n\nეს სწორი ადგილია (საიდან)?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ სწორია',          callback_data: 'geo_confirm:ok'    },
          { text: '🔄 ხელახლა ჩაწერა', callback_data: 'geo_confirm:retry' },
        ]],
      },
    }
  );
}

// ── Route to — GPS branch ──────────────────────────────────────────────────────

async function onRouteToGps(msg) {
  const chatId = msg.chat.id;
  const { latitude: lat, longitude: lng } = msg.location;

  await bot.sendMessage(chatId, '⏳ ვამოწმებ ადგილს...');
  const city  = await reverseGeocode(lat, lng);
  const label = city || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  getSession(chatId).pending = { lat, lng, label, city };
  await bot.sendLocation(chatId, lat, lng);
  setStep(chatId, STEPS.AWAIT_ROUTE_TO_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${label}\n\nეს სწორი ადგილია (სად)?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ სწორია',          callback_data: 'geo_confirm:ok'    },
          { text: '🔄 ხელახლა ჩაწერა', callback_data: 'geo_confirm:retry' },
        ]],
      },
    }
  );
}

// ── Route to — text branch ─────────────────────────────────────────────────────

async function onRouteToMethodText(msg) {
  const chatId = msg.chat.id;
  setStep(chatId, STEPS.AWAIT_ROUTE_TO_TEXT);
  return bot.sendMessage(
    chatId,
    '✏️ ჩაწერეთ სად მიდიხართ:\n_(მაგ: ბათუმი, ან სამტრედია)_',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
}

async function onRouteToText(msg) {
  const chatId = msg.chat.id;
  const query  = msg.text?.trim();
  if (!query || query.length < 2) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ ადგილი (მინ. 2 სიმბოლო).');
  }
  await bot.sendMessage(chatId, '⏳ ვეძებ მისამართს...');
  const result = await forwardGeocode(query);
  if (!result) {
    return bot.sendMessage(chatId, '❌ ადგილი ვერ მოიძებნა. სცადეთ სხვა ფორმულირება:');
  }
  getSession(chatId).pending = { lat: result.lat, lng: result.lng, label: result.displayName, city: result.city };
  await bot.sendLocation(chatId, result.lat, result.lng);
  setStep(chatId, STEPS.AWAIT_ROUTE_TO_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${result.displayName}\n\nეს სწორი ადგილია (სად)?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ სწორია',          callback_data: 'geo_confirm:ok'    },
          { text: '🔄 ხელახლა ჩაწერა', callback_data: 'geo_confirm:retry' },
        ]],
      },
    }
  );
}

// ── Driver geo confirmation callback ───────────────────────────────────────────

async function onDriverGeoConfirm(query) {
  const chatId  = query.message.chat.id;
  const session = getSession(chatId);
  const { step } = session;
  const action  = query.data.split(':')[1]; // 'ok' | 'retry'

  await bot.answerCallbackQuery(query.id);

  if (action === 'retry') {
    if (step === STEPS.AWAIT_ROUTE_FROM_CONFIRM) {
      setStep(chatId, STEPS.AWAIT_ROUTE_FROM_METHOD);
      return bot.sendMessage(chatId, '📍 საიდან მიდიხართ? — აირჩიეთ ვარიანტი ხელახლა:', {
        reply_markup: locationMethodKeyboard(),
      });
    }
    setStep(chatId, STEPS.AWAIT_ROUTE_TO_METHOD);
    return bot.sendMessage(chatId, '📍 სად მიდიხართ? — აირჩიეთ ვარიანტი ხელახლა:', {
      reply_markup: locationMethodKeyboard(),
    });
  }

  // action === 'ok'
  const { label, city } = session.pending;
  const routeText = city || label;
  session.pending = null;

  if (step === STEPS.AWAIT_ROUTE_FROM_CONFIRM) {
    updateRoute(chatId, { routeFrom: routeText });
    setStep(chatId, STEPS.AWAIT_ROUTE_TO_METHOD);
    return bot.sendMessage(
      chatId,
      `✅ საიდან: *${routeText}*\n\n🏁 სად მიდიხართ? — აირჩიეთ ვარიანტი:`,
      { parse_mode: 'Markdown', reply_markup: locationMethodKeyboard() }
    );
  }

  // AWAIT_ROUTE_TO_CONFIRM
  updateRoute(chatId, { routeTo: routeText });
  setStep(chatId, STEPS.AWAIT_ROUTE_DEPARTURE);
  return bot.sendMessage(
    chatId,
    `✅ სად: *${routeText}*\n\n⏰ როდის გამოდიხართ?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⚡ ახლა',   callback_data: 'depart:0'   },
          { text: '30 წთ-ში', callback_data: 'depart:30'  },
          { text: '1 სთ-ში',  callback_data: 'depart:60'  },
          { text: '2 სთ-ში',  callback_data: 'depart:120' },
        ]],
      },
    }
  );
}

// ── Callback query router ──────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const { step } = getSession(chatId);
  const data   = query.data;

  try {
    if (data.startsWith('geo_confirm:') && (
      step === STEPS.AWAIT_ROUTE_FROM_CONFIRM ||
      step === STEPS.AWAIT_ROUTE_TO_CONFIRM
    )) {
      await onDriverGeoConfirm(query);
    } else if (data.startsWith('arrived:')) {
      await onArrived(query);
    } else if (data.startsWith('start:')) {
      await onStart(query);
    } else if (data.startsWith('reg_truck:') && step === STEPS.AWAIT_TRUCK_TYPE) {
      await onRegTruckType(query);
    } else if (data.startsWith('depart:') && step === STEPS.AWAIT_ROUTE_DEPARTURE) {
      await onRouteDepart(query);
    } else if (data.startsWith('accept:')) {
      await onAccept(query);
    } else if (data.startsWith('complete:')) {
      await onComplete(query);
    } else if (data.startsWith('rate:')) {
      await onRatePassenger(query);
    } else if (data.startsWith('self_edit:')) {
      await onSelfEditField(query);
    } else if (data.startsWith('self_cat:')) {
      await onSelfCatSelect(query);
    } else if (data === 'self_wd_confirm') {
      await onSelfWdConfirm(query);
    } else if (data === 'self_wd_cancel') {
      await onSelfWdCancel(query);
    } else if (data === 'cancel_input') {
      await onCancelInput(query);
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    logger.error('Driver callback error', { chatId, data, error: err.message });
    await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა. სცადეთ /start.' });
  }
});

// ── Registration callbacks ─────────────────────────────────────────────────────

async function onRegTruckType(query) {
  const chatId    = query.message.chat.id;
  const truckType = query.data.split(':')[1];
  updateReg(chatId, { truckType });
  setStep(chatId, STEPS.AWAIT_CAR_MODEL);
  await bot.answerCallbackQuery(query.id);
  const label = truckType === 'crane' ? '🏗️ ამწე' : '🚛 ჩვეულებრივი';
  return bot.sendMessage(
    chatId,
    `✅ ${label}\n\n🚘 შეიყვანეთ მანქანის მოდელი (მაგ: Mercedes Sprinter):`,
    { reply_markup: { remove_keyboard: true } }
  );
}

// ── Route departure callback ───────────────────────────────────────────────────

async function onRouteDepart(query) {
  const chatId  = query.message.chat.id;
  const minutes = parseInt(query.data.split(':')[1], 10);
  const { route } = getSession(chatId);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '❌ შეცდომა — გთხოვ ხელახლა დააჭირო /start.',
      { reply_markup: { remove_keyboard: true } });
  }

  const departureAt = new Date(Date.now() + minutes * 60 * 1000);

  await setRoute(driver.telegram_id, {
    routeFrom:   route.routeFrom,
    routeTo:     route.routeTo,
    departureAt,
  });

  clearRouteSession(chatId);
  setStep(chatId, STEPS.IDLE);
  await bot.answerCallbackQuery(query.id);

  const timeLabel = minutes === 0
    ? 'ახლავე'
    : `~${departureAt.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' })}-ზე`;

  return bot.sendMessage(
    chatId,
    `✅ *მარშრუტი დაყენდა!*\n\n` +
    `🛣️ ${route.routeFrom} → ${route.routeTo}\n` +
    `⏰ გამოსვლა: ${timeLabel}\n\n` +
    'ახლა მხოლოდ ამ მიმართულების შეკვეთები მოვა. სტატუსი ავტომატურად გადავიდა "ხელმისაწვდომი"-ზე.',
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

// ── Order: accept ──────────────────────────────────────────────────────────────

async function onAccept(query) {
  const chatId  = query.message.chat.id;
  const orderId = parseInt(query.data.split(':')[1], 10);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ჯერ დარეგისტრირდით (/start).' });
  }
  if (!driver.is_available) {
    return bot.answerCallbackQuery(query.id, {
      text: '❌ შენ ჯერ კიდევ აქტიურ შეკვეთაზე ხარ.',
      show_alert: true,
    });
  }

  const order = await acceptOrder(orderId, driver.id);
  if (!order) {
    await bot.answerCallbackQuery(query.id, { text: 'ℹ️ შეკვეთა უკვე სხვამ აიღო.' });
    return bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id:    chatId,
      message_id: query.message.message_id,
    }).catch(() => {});
  }

  await bot.answerCallbackQuery(query.id, { text: '✅ შეკვეთა მიღებულია!' });

  await setAvailability(driver.telegram_id, false);
  getSession(chatId).activeOrderId = orderId;

  await notifier.notifyPassengerOrderAccepted(order, driver, order.passenger_telegram_id);

  const others = await getEligibleDrivers(
    order.can_roll,
    order.payment_method,
    order.pickup_city,
    order.dest_city,
    order.pickup_address,
    order.destination_address,
  );
  await notifier.notifyDriversOrderTaken(orderId, driver.telegram_id, others);

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id:    chatId,
    message_id: query.message.message_id,
  }).catch(() => {});

  const payLabel  = order.payment_method === 'card' ? '💳 ბარათი' : '💵 ნაღდი';
  const sizeLabel = order.vehicle_size === 'jeep' ? '🚐 ჯიპი' : order.vehicle_size === 'large' ? '🚌 დიდი მანქანა' : '🚗 ჩვეულებრივი';

  return bot.sendMessage(
    chatId,
    `✅ *შეკვეთა #${orderId} მიღებულია!*\n\n` +
    `📍 ${order.pickup_address}\n` +
    `🏁 ${order.destination_address}\n` +
    `${sizeLabel}  |  💰 ${order.price} ₾  |  ${payLabel}\n\n` +
    'ადგილზე მისვლისას დააჭირეთ:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚗 მოვედი', callback_data: `arrived:${orderId}` },
        ]],
      },
    }
  );
}

// ── Order: arrived ─────────────────────────────────────────────────────────────

async function onArrived(query) {
  const chatId  = query.message.chat.id;
  const orderId = parseInt(query.data.split(':')[1], 10);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ჯერ დარეგისტრირდით (/start).' });
  }

  if (driver.current_lat == null) {
    return bot.answerCallbackQuery(query.id, {
      text: '📍 GPS ლოკაცია გათეშილია — ჩართე location share, რომ შეგეძლოს გამოძახების მიღება/დასრულება.',
      show_alert: true,
    });
  }
  const orderForArrived = await getOrderById(orderId);
  if (orderForArrived?.pickup_lat != null) {
    const dist = haversineKm(
      parseFloat(driver.current_lat), parseFloat(driver.current_lng),
      parseFloat(orderForArrived.pickup_lat), parseFloat(orderForArrived.pickup_lng),
    );
    if (dist > ARRIVED_THRESHOLD_KM) {
      return bot.answerCallbackQuery(query.id, {
        text: `📍 ჯერ ძალიან შორს ხარ (~${dist.toFixed(1)} კმ) — მოახლოვდი ადგილს, შემდეგ ხელახლა ცადო.`,
        show_alert: true,
      });
    }
  }

  const order = await arriveOrder(orderId, driver.id);
  if (!order) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ვერ მოხდა სტატუსის განახლება.' });
  }

  await bot.answerCallbackQuery(query.id, { text: '📍 სტატუსი: მოვედი!' });

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});

  await notifier.notifyPassengerDriverArrived(order.passenger_telegram_id, driver);

  return bot.sendMessage(
    chatId,
    `📍 *მოვედი!*\n\n` +
    `👤 მგზავრი: ${order.passenger_name || '—'}\n` +
    `☎️ ${order.passenger_phone || '—'}\n\n` +
    'მგზავრის ჩასხდომის შემდეგ დააჭირეთ:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚛 დავიძარი', callback_data: `start:${orderId}` },
        ]],
      },
    }
  );
}

// ── Order: in_progress ─────────────────────────────────────────────────────────

async function onStart(query) {
  const chatId  = query.message.chat.id;
  const orderId = parseInt(query.data.split(':')[1], 10);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ჯერ დარეგისტრირდით (/start).' });
  }

  const order = await startOrder(orderId, driver.id);
  if (!order) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ვერ მოხდა სტატუსის განახლება.' });
  }

  await bot.answerCallbackQuery(query.id, { text: '🚛 მგზავრობა დაიწყო!' });

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});

  await notifier.notifyPassengerTripStarted(order.passenger_telegram_id);

  return bot.sendMessage(
    chatId,
    '🚛 *მგზავრობა დაიწყო!*\n\nდანიშნულებაზე მისვლის შემდეგ დააჭირეთ:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ დავასრულე', callback_data: `complete:${orderId}` },
        ]],
      },
    }
  );
}

// ── Order: complete ────────────────────────────────────────────────────────────

async function onComplete(query) {
  const chatId  = query.message.chat.id;
  const orderId = parseInt(query.data.split(':')[1], 10);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ჯერ დარეგისტრირდით (/start).' });
  }

  if (driver.current_lat == null) {
    return bot.answerCallbackQuery(query.id, {
      text: '📍 GPS ლოკაცია გათეშილია — ჩართე location share, რომ შეგეძლოს გამოძახების მიღება/დასრულება.',
      show_alert: true,
    });
  }
  const orderForComplete = await getOrderById(orderId);
  if (orderForComplete?.dest_lat != null) {
    const dist = haversineKm(
      parseFloat(driver.current_lat), parseFloat(driver.current_lng),
      parseFloat(orderForComplete.dest_lat), parseFloat(orderForComplete.dest_lng),
    );
    if (dist > COMPLETE_THRESHOLD_KM) {
      return bot.answerCallbackQuery(query.id, {
        text: `📍 ჯერ ძალიან შორს ხარ დანიშნულების ადგილიდან (~${dist.toFixed(1)} კმ) — მოახლოვდი, შემდეგ ხელახლა ცადო.`,
        show_alert: true,
      });
    }
  }

  const order = await completeOrder(orderId, driver.id);
  if (!order) {
    await bot.answerCallbackQuery(query.id, { text: '⚠️ ვერ მოხდა სტატუსის განახლება.' });
    return;
  }

  const result = await settleOrder(orderId);
  if (!result) {
    await setAvailability(driver.telegram_id, true);
    getSession(chatId).activeOrderId = null;
    await bot.answerCallbackQuery(query.id, { text: '✅ შეასრულდა!' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id,
    }).catch(() => {});
    return bot.sendMessage(chatId,
      '✅ შეასრულდა, მაგრამ დეტალური ანგარიში ვერ ჩაიტვირთა — დაუკავშირდი ადმინს.',
      { reply_markup: mainMenuKeyboard() });
  }

  await setAvailability(driver.telegram_id, true);
  getSession(chatId).activeOrderId = null;

  await bot.answerCallbackQuery(query.id, { text: '✅ შეასრულდა!' });

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id:    chatId,
    message_id: query.message.message_id,
  }).catch(() => {});

  const payLabel = order.payment_method === 'card' ? '💳 ბარათი' : '💵 ნაღდი';
  const sign     = result.balanceDelta >= 0 ? '+' : '';

  await notifier.notifyPassengerTripCompleted(orderId, order.passenger_telegram_id);

  await bot.sendMessage(
    chatId,
    `✅ *შეკვეთა #${orderId} შეასრულდა!*\n\n` +
    `💰 ჯამი: *${order.price} ₾*  |  ${payLabel}\n` +
    `🏦 საკომისიო: ${result.commission} ₾\n` +
    `📊 ბალანსი: ${sign}${result.balanceDelta} ₾\n\n` +
    '⭐ მიეცით შეფასება მგზავრს:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⭐ 1', callback_data: `rate:${orderId}:1` },
          { text: '⭐ 2', callback_data: `rate:${orderId}:2` },
          { text: '⭐ 3', callback_data: `rate:${orderId}:3` },
          { text: '⭐ 4', callback_data: `rate:${orderId}:4` },
          { text: '⭐ 5', callback_data: `rate:${orderId}:5` },
        ]],
      },
    }
  );

  return bot.sendMessage(chatId, 'სტატუსი: ✅ ხელმისაწვდომი ვარ', {
    reply_markup: mainMenuKeyboard(),
  });
}

// ── Rate passenger ─────────────────────────────────────────────────────────────

async function onRatePassenger(query) {
  const chatId  = query.message.chat.id;
  const parts   = query.data.split(':');
  const orderId = parseInt(parts[1], 10);
  const score   = parseInt(parts[2], 10);

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ჯერ დარეგისტრირდით.' });
  }

  await ratePassenger(orderId, driver.id, score);
  await bot.answerCallbackQuery(query.id, { text: `⭐ ${score}/5 ჩაიწერა!` });

  return bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id:    chatId,
    message_id: query.message.message_id,
  }).catch(() => {});
}

// ── History / stats ────────────────────────────────────────────────────────────

async function showHistory(chatId, driverId) {
  const history = await getDriverHistory(driverId);
  if (!history.length) {
    return bot.sendMessage(chatId, '📋 შეკვეთების ისტორია ცარიელია.',
      { reply_markup: mainMenuKeyboard() });
  }
  const lines = history.map((o, i) => {
    const date   = new Date(o.created_at).toLocaleDateString('ka-GE');
    const icon   = o.status === 'completed' ? '✅' : '❌';
    const rating = o.received_rating ? `⭐ ${o.received_rating}/5` : '—';
    return (
      `${i + 1}. ${icon} ${date}\n` +
      `   ${o.pickup_address} → ${o.destination_address || '—'}\n` +
      `   💰 ${o.price} ₾  |  ${rating}`
    );
  });
  return bot.sendMessage(
    chatId,
    `📋 *ჩემი შეკვეთები (${history.length}):*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

async function showBalance(chatId, driver) {
  const balance      = parseFloat(driver.balance)      || 0;
  const bonusBalance = parseFloat(driver.bonus_balance) || 0;
  const warning      = balance < 0
    ? '\n\n⚠️ ბალანსი მინუსშია — cash შეკვეთები ვეღარ მოვა, სანამ არ დაიფარება.'
    : '';
  return bot.sendMessage(
    chatId,
    `💰 *ჩემი ბალანსი*\n\n` +
    `💵 ძირითადი: *${balance.toFixed(2)} ₾*\n` +
    `🎁 ბონუსი:   *${bonusBalance.toFixed(2)} ₾*` +
    warning,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

async function showStats(chatId, driverId) {
  const stats = await getDriverStats(driverId);
  const avg   = stats.avg_rating ? `⭐ ${stats.avg_rating}` : '—';
  return bot.sendMessage(
    chatId,
    `⭐ *სტატისტიკა*\n\n` +
    `✅ დასრულებული: ${stats.total_completed}\n` +
    `⭐ საშუალო რეიტინგი: ${avg} (${stats.rated_count} შეფასება)`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

// ── Self-service profile edit ──────────────────────────────────────────────────

const TRUCK_TYPE_LABELS = { regular: '🚗 ჩვეულებრივი ევაკ.', crane: '🏗 ამწე ევაკ.' };

function showSelfEditMenu(chatId, driver) {
  const iban      = driver.bank_account ? `\n🏦 IBAN: \`${driver.bank_account}\`` : '';
  const truckLine = `\n🚛 ტიპი: ${TRUCK_TYPE_LABELS[driver.truck_type] || driver.truck_type}`;
  return bot.sendMessage(
    chatId,
    `✏️ *ჩემი მონაცემები*\n\n` +
    `👤 ${driver.full_name}\n` +
    `📱 ${driver.phone || '—'}\n` +
    `🚘 ${driver.car_model || '—'}  |  🔢 ${driver.car_plate || '—'}` +
    iban + truckLine +
    `\n\nაირჩიეთ ველი რედაქტირებისთვის:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📱 ტელეფონი',          callback_data: 'self_edit:phone' },
            { text: '🚘 მოდელი',            callback_data: 'self_edit:car_model' },
          ],
          [
            { text: '🔢 ავტომობილის ნომ.', callback_data: 'self_edit:car_plate' },
            { text: '🏦 საბანკო ანგ.',      callback_data: 'self_edit:bank_account' },
          ],
          [
            { text: '🚛 ევაკ. ტიპი',       callback_data: 'self_edit:truck_type' },
          ],
        ],
      },
    }
  );
}

async function onSelfEditField(query) {
  const chatId = query.message.chat.id;
  const field  = query.data.split(':')[1];

  await bot.answerCallbackQuery(query.id);

  if (field === 'truck_type') {
    return bot.sendMessage(chatId, '🚛 *ევაკუატორის ტიპი — აირჩიეთ:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚗 ჩვეულებრივი ევაკ.', callback_data: 'self_cat:regular' },
          { text: '🏗 ამწე ევაკ.',         callback_data: 'self_cat:crane'   },
        ]],
      },
    });
  }

  const label = SELF_EDIT_LABELS[field];
  if (!label) return;

  getSession(chatId).selfEdit = { field };
  setStep(chatId, STEPS.AWAIT_SELF_EDIT_FIELD);

  return bot.sendMessage(chatId, `✏️ შეიყვანეთ ახალი *${label}*:`, {
    parse_mode: 'Markdown',
    reply_markup: cancelKeyboard(),
  });
}

async function onSelfCatSelect(query) {
  const chatId    = query.message.chat.id;
  const truckType = query.data.split(':')[1];
  if (!['regular', 'crane'].includes(truckType)) {
    return bot.answerCallbackQuery(query.id);
  }

  const driver = await findByTelegramId(query.from.id);
  if (!driver) return bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა.' });

  await updateDriverField(driver.id, 'truck_type', truckType);
  await bot.answerCallbackQuery(query.id, { text: `✅ ${TRUCK_TYPE_LABELS[truckType]}` });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});

  const updated = await findByTelegramId(query.from.id);
  return showSelfEditMenu(chatId, updated);
}

async function onSelfEditValue(msg) {
  const chatId = msg.chat.id;
  const value  = msg.text?.trim();
  if (!value || value.length < 2) {
    return bot.sendMessage(chatId, '⚠️ მინიმუმ 2 სიმბოლო.');
  }

  const { selfEdit } = getSession(chatId);
  const driver = await findByTelegramId(msg.from.id);
  if (!driver) {
    clearSelfEdit(chatId);
    return bot.sendMessage(chatId, '❌ მძღოლი ვერ მოიძებნა.', { reply_markup: mainMenuKeyboard() });
  }

  await updateDriverField(driver.id, selfEdit.field, value);
  clearSelfEdit(chatId);

  const updated = await findByTelegramId(msg.from.id);
  await bot.sendMessage(chatId, `✅ *${SELF_EDIT_LABELS[selfEdit.field]}* განახლდა!`, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
  return showSelfEditMenu(chatId, updated);
}

// ── Self-service withdrawal ────────────────────────────────────────────────────

async function onSelfWdStart(chatId, driver) {
  if (!driver.bank_account) {
    setStep(chatId, STEPS.AWAIT_SELF_WD_BANK);
    return bot.sendMessage(
      chatId,
      '🏦 გატანისთვის ჯერ მიუთითეთ საბანკო ანგარიშის ნომერი (IBAN):',
      { reply_markup: cancelKeyboard() }
    );
  }
  return showSelfWdAmountPrompt(chatId, driver);
}

async function onSelfWdBank(msg) {
  const chatId = msg.chat.id;
  const iban   = msg.text?.trim();
  if (!iban || iban.length < 5) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სწორი IBAN ნომერი.');
  }

  const driver = await findByTelegramId(msg.from.id);
  if (!driver) {
    clearSelfWd(chatId);
    return bot.sendMessage(chatId, '❌ შეცდომა. სცადეთ /start.', { reply_markup: mainMenuKeyboard() });
  }

  await updateDriverField(driver.id, 'bank_account', iban);
  const updated = await findByTelegramId(msg.from.id);
  return showSelfWdAmountPrompt(chatId, updated);
}

async function showSelfWdAmountPrompt(chatId, driver) {
  const balance   = parseFloat(driver.balance) || 0;
  const todayUsed = await getDriverWithdrawalsToday(driver.id);
  const remaining = Math.max(0, DAILY_WD_LIMIT - todayUsed);

  setStep(chatId, STEPS.AWAIT_SELF_WD_AMOUNT);
  return bot.sendMessage(
    chatId,
    `💸 *ფულის გატანა*\n\n` +
    `💰 ბალანსი: *${balance.toFixed(2)} ₾*\n` +
    `🏦 ანგარიში: \`${driver.bank_account}\`\n\n` +
    `📅 დღიური ლიმიტი: ${DAILY_WD_LIMIT} ₾\n` +
    `✅ დღეს გამოყენებული: ${todayUsed.toFixed(2)} ₾\n` +
    `🔢 დარჩენილი: *${remaining.toFixed(2)} ₾*\n\n` +
    `საკომისიო: < 300₾ → 1₾  |  300–500₾ → 2₾\n\n` +
    `შეიყვანეთ გასატანი თანხა:`,
    { parse_mode: 'Markdown', reply_markup: cancelKeyboard() }
  );
}

async function onSelfWdAmount(msg) {
  const chatId = msg.chat.id;
  const amount = parseFloat(msg.text?.trim());

  if (!amount || amount <= 0 || isNaN(amount)) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სწორი თანხა (მაგ: 150).');
  }

  const driver = await findByTelegramId(msg.from.id);
  if (!driver) {
    clearSelfWd(chatId);
    return bot.sendMessage(chatId, '❌ შეცდომა. სცადეთ /start.', { reply_markup: mainMenuKeyboard() });
  }

  const commission = calcCommission(amount);
  const total      = amount + commission;
  const balance    = parseFloat(driver.balance) || 0;

  if (total > balance) {
    return bot.sendMessage(
      chatId,
      `❌ *არასაკმარისი ბალანსი*\n\n` +
      `შენ ანგარიშზე მხოლოდ *${balance.toFixed(2)} ₾* მოგაქვს.\n` +
      `ვერ გაიტან *${amount.toFixed(2)} ₾*-ს (+საკომისიო ${commission} ₾ = ჯამი ${total.toFixed(2)} ₾).\n\n` +
      `შეიყვანეთ სხვა თანხა:`,
      { parse_mode: 'Markdown' }
    );
  }

  const todayUsed = await getDriverWithdrawalsToday(driver.id);
  if (todayUsed + amount > DAILY_WD_LIMIT) {
    const remaining = Math.max(0, DAILY_WD_LIMIT - todayUsed);
    return bot.sendMessage(
      chatId,
      `❌ *დღიური ლიმიტი*\n\n` +
      `დღეს უკვე გამოყენებულია *${todayUsed.toFixed(2)} ₾*.\n` +
      `დღეს შეგიძლიათ გაიტანოთ მაქსიმუმ *${remaining.toFixed(2)} ₾*.\n\n` +
      `შეიყვანეთ სხვა თანხა:`,
      { parse_mode: 'Markdown' }
    );
  }

  getSession(chatId).selfWd = { amount, commission };

  return bot.sendMessage(
    chatId,
    `💸 *გატანის დადასტურება*\n\n` +
    `🏦 ანგარიში: \`${driver.bank_account}\`\n` +
    `💵 თანხა: *${amount.toFixed(2)} ₾*\n` +
    `💳 საკომისიო: *${commission} ₾*\n` +
    `📤 ბალანსიდან ჩამოიჭრება: *${total.toFixed(2)} ₾*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ დადასტურება', callback_data: 'self_wd_confirm' },
          { text: '❌ გაუქმება',    callback_data: 'self_wd_cancel'  },
        ]],
      },
    }
  );
}

async function onSelfWdConfirm(query) {
  const chatId  = query.message.chat.id;
  const session = getSession(chatId);
  const { amount, commission } = session.selfWd;

  if (!amount) {
    await bot.answerCallbackQuery(query.id, { text: '⚠️ გატანის მონაცემები არ მოიძებნა.' });
    return;
  }

  const driver = await findByTelegramId(query.from.id);
  if (!driver) {
    await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა.' });
    return;
  }

  const total   = amount + commission;
  const balance = parseFloat(driver.balance) || 0;

  if (total > balance) {
    clearSelfWd(chatId);
    await bot.answerCallbackQuery(query.id, { text: '❌ ბალანსი შეიცვალა. სცადეთ ხელახლა.' });
    return bot.sendMessage(chatId, '❌ ბალანსი შეიცვალა — გატანა გაუქმდა.', { reply_markup: mainMenuKeyboard() });
  }

  const todayUsed = await getDriverWithdrawalsToday(driver.id);
  if (todayUsed + amount > DAILY_WD_LIMIT) {
    clearSelfWd(chatId);
    await bot.answerCallbackQuery(query.id, { text: '❌ დღიური ლიმიტი გადაიჭარბა.' });
    return bot.sendMessage(chatId, '❌ დღიური ლიმიტი — გატანა გაუქმდა.', { reply_markup: mainMenuKeyboard() });
  }

  await recordSelfWithdrawal(driver.id, amount, commission);
  clearSelfWd(chatId);

  await bot.answerCallbackQuery(query.id, { text: '✅ გატანა დარეგისტრირდა!' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});

  return bot.sendMessage(
    chatId,
    `✅ *გატანა დარეგისტრირდა!*\n\n` +
    `💵 *${amount.toFixed(2)} ₾* → \`${driver.bank_account}\`\n` +
    `💳 საკომისიო: ${commission} ₾\n\n` +
    `ახალი ბალანსი: *${(balance - total).toFixed(2)} ₾*`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

async function onSelfWdCancel(query) {
  const chatId = query.message.chat.id;
  clearSelfWd(chatId);
  await bot.answerCallbackQuery(query.id, { text: '❌ გაუქმდა.' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});
  return bot.sendMessage(chatId, '❌ გატანა გაუქმდა.', { reply_markup: mainMenuKeyboard() });
}

async function onCancelInput(query) {
  const chatId = query.message.chat.id;
  clearSelfEdit(chatId);
  clearSelfWd(chatId);
  clearRouteSession(chatId);
  setStep(chatId, STEPS.IDLE);
  await bot.answerCallbackQuery(query.id, { text: '❌ გაუქმდა.' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});
  return bot.sendMessage(chatId, '↩️ გაუქმდა.', { reply_markup: mainMenuKeyboard() });
}

// ── Error handling ─────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => logger.error('Driver bot polling error', { error: err.message }));

logger.info('Driver bot started');
module.exports = bot;
