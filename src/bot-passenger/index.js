'use strict';

const { TelegramBot } = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../shared/logger');
const { STEPS, getSession, setStep, updateOrder, updateReg, clearOrder } = require('./sessions');
const { findByTelegramId, createPassenger } = require('../shared/passengerService');
const { createOrder, getPassengerHistory, getEligibleDrivers, rateDriver } = require('../shared/orderService');
const { consumeDiscount } = require('../shared/passengerService');
const { calculatePrice } = require('../shared/sheets');
const { haversineKm, coordsLabel, getRoadDistanceKm } = require('../shared/geo');
const { reverseGeocode, forwardGeocode } = require('../shared/geocoder');
const notifier = require('../shared/notifier');

const bot = new TelegramBot(config.telegram.passengerToken, { polling: true });

// ── Keyboard helpers ──────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🚗 ევაკუატორის გამოძახება' }],
      [{ text: '📋 ჩემი შეკვეთები' }],
    ],
    resize_keyboard: true,
  };
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

// ── /start ────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const passenger = await findByTelegramId(msg.from.id);
    if (passenger) {
      setStep(chatId, STEPS.IDLE);
      await bot.sendMessage(
        chatId,
        `გამარჯობა, ${passenger.full_name}! 👋\n\nაირჩიეთ ვარიანტი:`,
        { reply_markup: mainMenuKeyboard() }
      );
    } else {
      setStep(chatId, STEPS.AWAIT_REG_NAME);
      await bot.sendMessage(
        chatId,
        'გამარჯობა! ევაკუატორის სერვისში მოგესალმებით. 🚗\n\n' +
        'პირველი გამოყენებისთვის საჭიროა სწრაფი რეგისტრაცია.\n\n' +
        'შეიყვანეთ თქვენი სახელი და გვარი:',
        { reply_markup: { remove_keyboard: true } }
      );
    }
  } catch (err) {
    logger.error('/start error', { chatId, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /start ხელახლა.');
  }
});

// ── /cancel ───────────────────────────────────────────────────────────────────

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  clearOrder(chatId);
  setStep(chatId, STEPS.IDLE);
  bot.sendMessage(chatId, '↩️ მოქმედება გაუქმდა.', { reply_markup: mainMenuKeyboard() });
});

// ── Main message router ───────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text?.startsWith('/')) return;

  const { step } = getSession(chatId);

  try {
    switch (step) {
      case STEPS.AWAIT_REG_NAME:
        await onRegName(msg);
        break;

      case STEPS.AWAIT_REG_PHONE:
        await onRegPhone(msg);
        break;

      case STEPS.AWAIT_PICKUP_LOC_METHOD:
        if (msg.location) await onPickupLoc(msg);
        else if (msg.text === '✏️ მისამართის ჩაწერა') await onPickupMethodText(msg);
        else bot.sendMessage(chatId, '📍 გამოიყენეთ ქვემოთ მოცემული ღილაკი.');
        break;

      case STEPS.AWAIT_PICKUP_TEXT:
        if (msg.text) await onPickupText(msg);
        break;

      case STEPS.AWAIT_DEST_LOC_METHOD:
        if (msg.location) await onDestLoc(msg);
        else if (msg.text === '✏️ მისამართის ჩაწერა') await onDestMethodText(msg);
        else bot.sendMessage(chatId, '📍 გამოიყენეთ ქვემოთ მოცემული ღილაკი.');
        break;

      case STEPS.AWAIT_DEST_TEXT:
        if (msg.text) await onDestText(msg);
        break;

      case STEPS.IDLE:
        if (msg.text === '🚗 ევაკუატორის გამოძახება') await onStartOrder(msg);
        else if (msg.text === '📋 ჩემი შეკვეთები') await onHistory(msg);
        break;

      default:
        break;
    }
  } catch (err) {
    logger.error('Message handler error', { chatId, step, error: err.message });
    bot.sendMessage(chatId, '❌ სერვერის შეცდომა. სცადეთ /start ხელახლა.');
  }
});

// ── Registration ──────────────────────────────────────────────────────────────

async function onRegName(msg) {
  const chatId = msg.chat.id;
  const name = msg.text?.trim();
  if (!name || name.length < 2) {
    return bot.sendMessage(chatId, '⚠️ გთხოვთ შეიყვანოთ სრული სახელი (მინ. 2 სიმბოლო).');
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
  const { reg } = getSession(chatId);
  let phone = null;

  if (msg.contact) {
    phone = msg.contact.phone_number;
  } else if (msg.text && /^\+?[\d\s\-]{7,15}$/.test(msg.text)) {
    phone = msg.text.trim();
  } else {
    return bot.sendMessage(chatId, '⚠️ გთხოვთ გამოიყენოთ "📱 ნომრის გაზიარება" ღილაკი.');
  }

  await createPassenger({
    telegramId: msg.from.id,
    username:   msg.from.username || null,
    fullName:   reg.name,
    phone,
  });

  clearOrder(chatId);
  setStep(chatId, STEPS.IDLE);
  return bot.sendMessage(
    chatId,
    `🎉 რეგისტრაცია დასრულდა!\n\nგამარჯობა, ${reg.name}! ახლა შეგიძლიათ ევაკუატორის გამოძახება.`,
    { reply_markup: mainMenuKeyboard() }
  );
}

// ── Order flow ────────────────────────────────────────────────────────────────

async function onStartOrder(msg) {
  const chatId = msg.chat.id;
  clearOrder(chatId);
  setStep(chatId, STEPS.AWAIT_PICKUP_LOC_METHOD);
  return bot.sendMessage(chatId, '📍 საიდან ვიყვანოთ მანქანა? — აირჩიეთ ვარიანტი:', {
    reply_markup: locationMethodKeyboard(),
  });
}

// ── Pickup — GPS branch ───────────────────────────────────────────────────────

async function onPickupLoc(msg) {
  const chatId = msg.chat.id;
  const { latitude, longitude } = msg.location;

  updateOrder(chatId, {
    pickupLat:     latitude,
    pickupLng:     longitude,
    pickupAddress: coordsLabel(latitude, longitude),
  });

  await bot.sendMessage(chatId, '⏳ ვამოწმებ ადგილს...');

  const city = await reverseGeocode(latitude, longitude);
  const locationLabel = city
    ? `${coordsLabel(latitude, longitude)} (${city})`
    : coordsLabel(latitude, longitude);

  updateOrder(chatId, { pickupAddress: locationLabel, pickupCity: city || null });
  setStep(chatId, STEPS.AWAIT_DEST_LOC_METHOD);

  return bot.sendMessage(
    chatId,
    `✅ საწყისი: ${locationLabel}\n\n🏁 დანიშნულება — აირჩიეთ ვარიანტი:`,
    { reply_markup: locationMethodKeyboard() }
  );
}

// ── Pickup — text branch ──────────────────────────────────────────────────────

async function onPickupMethodText(msg) {
  const chatId = msg.chat.id;
  setStep(chatId, STEPS.AWAIT_PICKUP_TEXT);
  return bot.sendMessage(
    chatId,
    '✏️ ჩაწერეთ საწყისი მისამართი:\n_(მაგ: ჭავჭავაძის 25, თბილისი)_',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
}

async function onPickupText(msg) {
  const chatId = msg.chat.id;
  const query  = msg.text?.trim();
  if (!query || query.length < 3) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სრული მისამართი (მინ. 3 სიმბოლო).');
  }
  await bot.sendMessage(chatId, '⏳ ვეძებ მისამართს...');
  const result = await forwardGeocode(query);
  if (!result) {
    return bot.sendMessage(chatId, '❌ მისამართი ვერ მოიძებნა. სცადეთ სხვა ფორმულირება:');
  }
  getSession(chatId).pending = result;
  await bot.sendLocation(chatId, result.lat, result.lng);
  setStep(chatId, STEPS.AWAIT_PICKUP_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${result.displayName}\n\nეს სწორი ადგილია?`,
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

// ── Destination — GPS branch ──────────────────────────────────────────────────

async function onDestLoc(msg) {
  const chatId = msg.chat.id;
  const { latitude, longitude } = msg.location;
  const { order } = getSession(chatId);

  const distanceKm = Math.round(
    (await getRoadDistanceKm(order.pickupLat, order.pickupLng, latitude, longitude)) * 10
  ) / 10;

  updateOrder(chatId, {
    destLat:     latitude,
    destLng:     longitude,
    destAddress: coordsLabel(latitude, longitude),
    distanceKm,
  });

  await bot.sendMessage(chatId, '⏳ ვამოწმებ ადგილს...');

  const city = await reverseGeocode(latitude, longitude);
  const locationLabel = city
    ? `${coordsLabel(latitude, longitude)} (${city})`
    : coordsLabel(latitude, longitude);

  updateOrder(chatId, { destAddress: locationLabel, destCity: city || null });
  setStep(chatId, STEPS.AWAIT_VEHICLE_SIZE);

  return bot.sendMessage(
    chatId,
    `✅ დანიშნულება: ${locationLabel}\n` +
    `📏 სავარაუდო მანძილი: ~${distanceKm} კმ\n\n` +
    '🚗 აირჩიეთ მანქანის ტიპი:',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚗 ჩვეულებრივი',          callback_data: 'vsize:normal' },
          { text: '🚌 დიდი (მიკრო/სატვირთო)', callback_data: 'vsize:large'  },
        ]],
      },
    }
  );
}

// ── Destination — text branch ─────────────────────────────────────────────────

async function onDestMethodText(msg) {
  const chatId = msg.chat.id;
  setStep(chatId, STEPS.AWAIT_DEST_TEXT);
  return bot.sendMessage(
    chatId,
    '✏️ ჩაწერეთ დანიშნულების მისამართი:\n_(მაგ: ვარკეთილი 3, თბილისი)_',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
}

async function onDestText(msg) {
  const chatId = msg.chat.id;
  const query  = msg.text?.trim();
  if (!query || query.length < 3) {
    return bot.sendMessage(chatId, '⚠️ შეიყვანეთ სრული მისამართი (მინ. 3 სიმბოლო).');
  }
  await bot.sendMessage(chatId, '⏳ ვეძებ მისამართს...');
  const result = await forwardGeocode(query);
  if (!result) {
    return bot.sendMessage(chatId, '❌ მისამართი ვერ მოიძებნა. სცადეთ სხვა ფორმულირება:');
  }
  getSession(chatId).pending = result;
  await bot.sendLocation(chatId, result.lat, result.lng);
  setStep(chatId, STEPS.AWAIT_DEST_CONFIRM);
  return bot.sendMessage(
    chatId,
    `📍 ${result.displayName}\n\nეს სწორი ადგილია?`,
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

// ── Geo confirmation callback ─────────────────────────────────────────────────

async function onGeoConfirm(query) {
  const chatId  = query.message.chat.id;
  const session = getSession(chatId);
  const { step } = session;
  const action  = query.data.split(':')[1]; // 'ok' | 'retry'

  await bot.answerCallbackQuery(query.id);

  if (action === 'retry') {
    if (step === STEPS.AWAIT_PICKUP_CONFIRM) {
      setStep(chatId, STEPS.AWAIT_PICKUP_TEXT);
      return bot.sendMessage(chatId, '✏️ ჩაწერეთ საწყისი მისამართი ხელახლა:',
        { reply_markup: { remove_keyboard: true } });
    }
    setStep(chatId, STEPS.AWAIT_DEST_TEXT);
    return bot.sendMessage(chatId, '✏️ ჩაწერეთ დანიშნულების მისამართი ხელახლა:',
      { reply_markup: { remove_keyboard: true } });
  }

  // action === 'ok'
  const { lat, lng, displayName, city } = session.pending;
  session.pending = null;

  if (step === STEPS.AWAIT_PICKUP_CONFIRM) {
    updateOrder(chatId, {
      pickupLat:     lat,
      pickupLng:     lng,
      pickupAddress: displayName,
      pickupCity:    city || null,
    });
    setStep(chatId, STEPS.AWAIT_DEST_LOC_METHOD);
    return bot.sendMessage(
      chatId,
      `✅ საწყისი: ${displayName}\n\n🏁 დანიშნულება — აირჩიეთ ვარიანტი:`,
      { reply_markup: locationMethodKeyboard() }
    );
  }

  // AWAIT_DEST_CONFIRM
  const { order } = getSession(chatId);
  const distanceKm = Math.round(
    (await getRoadDistanceKm(order.pickupLat, order.pickupLng, lat, lng)) * 10
  ) / 10;
  updateOrder(chatId, {
    destLat:     lat,
    destLng:     lng,
    destAddress: displayName,
    destCity:    city || null,
    distanceKm,
  });
  setStep(chatId, STEPS.AWAIT_VEHICLE_SIZE);
  return bot.sendMessage(
    chatId,
    `✅ დანიშნულება: ${displayName}\n` +
    `📏 სავარაუდო მანძილი: ~${distanceKm} კმ\n\n` +
    '🚗 აირჩიეთ მანქანის ტიპი:',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚗 ჩვეულებრივი',          callback_data: 'vsize:normal' },
          { text: '🚌 დიდი (მიკრო/სატვირთო)', callback_data: 'vsize:large'  },
        ]],
      },
    }
  );
}

// ── Callback query router ─────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const { step } = getSession(chatId);
  const data = query.data;

  try {
    if (data.startsWith('rate_driver:')) {
      await onRateDriver(query);
    } else if (data.startsWith('geo_confirm:') &&
        (step === STEPS.AWAIT_PICKUP_CONFIRM || step === STEPS.AWAIT_DEST_CONFIRM)) {
      await onGeoConfirm(query);
    } else if (data.startsWith('vsize:') && step === STEPS.AWAIT_VEHICLE_SIZE) {
      await onVehicleSize(query);
    } else if (data.startsWith('canroll:') && step === STEPS.AWAIT_CAN_ROLL) {
      await onCanRoll(query);
    } else if (data.startsWith('payment:') && step === STEPS.AWAIT_PAYMENT) {
      await onPayment(query);
    } else if ((data === 'confirm' || data === 'cancel_order') && step === STEPS.AWAIT_CONFIRM) {
      await onConfirm(query);
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    logger.error('Callback query error', { chatId, data, error: err.message });
    await bot.answerCallbackQuery(query.id, { text: '❌ შეცდომა. სცადეთ /start.' });
  }
});

async function onVehicleSize(query) {
  const chatId      = query.message.chat.id;
  const vehicleSize = query.data.split(':')[1];

  updateOrder(chatId, { vehicleSize });
  setStep(chatId, STEPS.AWAIT_CAN_ROLL);
  await bot.answerCallbackQuery(query.id);

  const label = vehicleSize === 'large' ? '🚌 დიდი' : '🚗 ჩვეულებრივი';
  return bot.sendMessage(
    chatId,
    `✅ მანქანის ტიპი: ${label}\n\n` +
    '🔧 გორავს მანქანა? (შეუძლია თუ არა ევაკუატორის პლატფორმაზე ჩასვლა)',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ კი, გორავს', callback_data: 'canroll:true'  },
          { text: '❌ არ გორავს', callback_data: 'canroll:false' },
        ]],
      },
    }
  );
}

async function onCanRoll(query) {
  const chatId  = query.message.chat.id;
  const canRoll = query.data.split(':')[1] === 'true';
  const { order } = getSession(chatId);

  const passenger = await findByTelegramId(query.from.id);
  const discount  = parseFloat(passenger?.discount_available) || 0;

  let priceResult;
  try {
    priceResult = await calculatePrice(order.distanceKm, order.vehicleSize, canRoll, discount);
  } catch (err) {
    logger.error('calculatePrice failed', { error: err.message });
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '❌ ფასის გამოთვლა ვერ მოხდა. სცადეთ /start ხელახლა.');
  }

  updateOrder(chatId, {
    canRoll,
    price:           priceResult.total,
    breakdown:       priceResult.breakdown,
    discountApplied: discount > 0 ? Math.abs(priceResult.breakdown.discount) : 0,
  });
  setStep(chatId, STEPS.AWAIT_PAYMENT);
  await bot.answerCallbackQuery(query.id);

  const { order: o } = getSession(chatId);
  const bd        = priceResult.breakdown;
  const sizeLabel = o.vehicleSize === 'large' ? '🚌 დიდი' : '🚗 ჩვეულებრივი';
  const rollLabel = canRoll ? '✅ გორავს' : '❌ არ გორავს';

  const extraLines = [];
  if (bd.size_fee  > 0) extraLines.push(`  მსხვილი მანქანა: +${bd.size_fee} ₾`);
  if (bd.crane_fee > 0) extraLines.push(`  ამწე (არ გორავს): +${bd.crane_fee} ₾`);
  if (bd.discount  < 0) extraLines.push(`  🎟️ ფასდაკლება: ${bd.discount} ₾`);
  const extrasText = extraLines.length ? extraLines.join('\n') : '  —';

  return bot.sendMessage(
    chatId,
    `📋 *ფასის დეტალები*\n\n` +
    `📍 ${o.pickupAddress} → ${o.destAddress}\n` +
    `📏 ~${o.distanceKm} კმ  |  ${sizeLabel}  |  ${rollLabel}\n\n` +
    `  საბაზო: ${bd.base_fare} ₾\n` +
    `  მანძილი (${o.distanceKm} კმ × ${bd.price_per_km}₾): ${bd.distance_fee} ₾\n` +
    `  დამატებები:\n${extrasText}\n` +
    `  ─────────────\n` +
    `  *სულ: ${priceResult.total} ₾*\n\n` +
    '💳 როგორ გადაიხდით?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '💳 ბარათით', callback_data: 'payment:card' },
          { text: '💵 ნაღდით',  callback_data: 'payment:cash' },
        ]],
      },
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

  return bot.sendMessage(
    chatId,
    `✅ *შეკვეთის დადასტურება*\n\n` +
    `📍 საიდან: ${o.pickupAddress}\n` +
    `🏁 სად: ${o.destAddress}\n` +
    `💰 ფასი: *${o.price} ₾*  |  ${payLabel}\n\n` +
    'დაადასტურეთ?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ დაადასტურე', callback_data: 'confirm'      },
          { text: '❌ გაუქმება',  callback_data: 'cancel_order' },
        ]],
      },
    }
  );
}

async function onConfirm(query) {
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  if (query.data === 'cancel_order') {
    clearOrder(chatId);
    setStep(chatId, STEPS.IDLE);
    return bot.sendMessage(chatId, '↩️ შეკვეთა გაუქმდა.', { reply_markup: mainMenuKeyboard() });
  }

  const passenger = await findByTelegramId(query.from.id);
  if (!passenger) {
    return bot.sendMessage(chatId, '⚠️ მომხმარებელი ვერ მოიძებნა. სცადეთ /start.');
  }
  if (passenger.is_active === false) {
    clearOrder(chatId);
    return bot.sendMessage(chatId,
      '🚫 თქვენი ანგარიში დაბლოკილია. admin-თან დაუკავშირდით.',
      { reply_markup: mainMenuKeyboard() }
    );
  }

  const draft = { ...getSession(chatId).order };

  const newOrder = await createOrder({
    passengerId:   passenger.id,
    pickupLat:     draft.pickupLat,
    pickupLng:     draft.pickupLng,
    pickupAddress: draft.pickupAddress,
    destLat:       draft.destLat,
    destLng:       draft.destLng,
    destAddress:   draft.destAddress,
    vehicleSize:   draft.vehicleSize,
    canRoll:       draft.canRoll,
    price:         draft.price,
    paymentMethod: draft.paymentMethod,
    pickupCity:    draft.pickupCity  || null,
    destCity:      draft.destCity    || null,
  });

  if (draft.discountApplied > 0) {
    await consumeDiscount(passenger.id);
  }

  clearOrder(chatId);
  setStep(chatId, STEPS.IDLE);

  await bot.sendMessage(
    chatId,
    `✅ *შეკვეთა #${newOrder.id} მიღებულია!*\n\n` +
    'ევაკუატორის ძებნა დაიწყო.\n' +
    'დაგიკავშირდებათ, როგორც კი მძღოლი დაადასტურებს.',
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );

  logger.info('Searching eligible drivers', {
    orderId:       newOrder.id,
    canRoll:       draft.canRoll,
    paymentMethod: draft.paymentMethod,
    pickupCity:    draft.pickupCity  || null,
    destCity:      draft.destCity    || null,
    pickupAddress: draft.pickupAddress,
    destAddress:   draft.destAddress,
  });

  const eligibleDrivers = await getEligibleDrivers(
    draft.canRoll,
    draft.paymentMethod,
    draft.pickupCity  || null,
    draft.destCity    || null,
    draft.pickupAddress,
    draft.destAddress,
  );

  logger.info('Eligible drivers result', {
    orderId: newOrder.id,
    count:   eligibleDrivers.length,
    ids:     eligibleDrivers.map(d => d.id),
  });

  await notifier.notifyDriversOfNewOrder(newOrder, eligibleDrivers, draft);
}

// ── Rate driver (after trip completed) ───────────────────────────────────────

async function onRateDriver(query) {
  const chatId  = query.message.chat.id;
  const parts   = query.data.split(':'); // rate_driver:orderId:score
  const orderId = parseInt(parts[1], 10);
  const score   = parseInt(parts[2], 10);

  const passenger = await findByTelegramId(query.from.id);
  if (!passenger) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ ვერ მოიძებნა.' });
  }

  await rateDriver(orderId, passenger.id, score);
  await bot.answerCallbackQuery(query.id, { text: `⭐ ${score}/5 — გმადლობთ!` });

  return bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id:    chatId,
    message_id: query.message.message_id,
  }).catch(() => {});
}

// ── Order history ─────────────────────────────────────────────────────────────

async function onHistory(msg) {
  const chatId    = msg.chat.id;
  const passenger = await findByTelegramId(msg.from.id);
  if (!passenger) {
    return bot.sendMessage(chatId, '⚠️ მომხმარებელი ვერ მოიძებნა. სცადეთ /start.');
  }

  const history = await getPassengerHistory(passenger.id);
  if (!history.length) {
    return bot.sendMessage(chatId, '📋 შეკვეთების ისტორია ცარიელია.');
  }

  const lines = history.map((o, i) => {
    const date   = new Date(o.created_at).toLocaleDateString('ka-GE');
    const icon   = o.status === 'completed' ? '✅' : '❌';
    const rating = o.my_rating_for_driver ? `⭐ ${o.my_rating_for_driver}/5` : 'შეფასება არ არის';
    const driver = o.driver_name || '—';
    return (
      `${i + 1}. ${icon} ${date}\n` +
      `   ${o.pickup_address} → ${o.destination_address || '—'}\n` +
      `   💰 ${o.price} ₾  |  🚗 ${driver}  |  ${rating}`
    );
  });

  return bot.sendMessage(
    chatId,
    `📋 *თქვენი შეკვეთები (${history.length}):*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ── Error handling ────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => logger.error('Passenger bot polling error', { error: err.message }));

logger.info('Passenger bot started');
module.exports = bot;
