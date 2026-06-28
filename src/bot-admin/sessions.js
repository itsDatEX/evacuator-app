const STEPS = {
  IDLE:            'IDLE',
  // Manual phone order
  AWAIT_PHONE:     'AWAIT_PHONE',
  AWAIT_PICKUP:    'AWAIT_PICKUP',
  AWAIT_DEST:      'AWAIT_DEST',
  AWAIT_DISTANCE:  'AWAIT_DISTANCE',
  AWAIT_VSIZE:     'AWAIT_VSIZE',
  AWAIT_CANROLL:   'AWAIT_CANROLL',
  AWAIT_PAYMENT:   'AWAIT_PAYMENT',
  AWAIT_CONFIRM:   'AWAIT_CONFIRM',
  // Bonus management
  AWAIT_BONUS_DRIVER_ID: 'AWAIT_BONUS_DRIVER_ID',
  AWAIT_BONUS_AMOUNT:    'AWAIT_BONUS_AMOUNT',
  AWAIT_DISC_PASS_ID:    'AWAIT_DISC_PASS_ID',
  AWAIT_DISC_AMOUNT:     'AWAIT_DISC_AMOUNT',
  // Balance / withdrawals
  AWAIT_WD_BANK_ACCOUNT: 'AWAIT_WD_BANK_ACCOUNT',
  AWAIT_WD_AMOUNT:       'AWAIT_WD_AMOUNT',
  // Driver management
  AWAIT_DRV_SEARCH:      'AWAIT_DRV_SEARCH',
  AWAIT_DRV_EDIT_FIELD:  'AWAIT_DRV_EDIT_FIELD',
  // Passenger management
  AWAIT_PASS_SEARCH:     'AWAIT_PASS_SEARCH',
  AWAIT_PASS_EDIT_FIELD: 'AWAIT_PASS_EDIT_FIELD',
  // Broadcast
  AWAIT_BROADCAST_TEXT:  'AWAIT_BROADCAST_TEXT',
  // Admin management (owner only)
  AWAIT_ADMIN_ADD_ID:    'AWAIT_ADMIN_ADD_ID',
  // Pricing management
  AWAIT_PRICING_VALUE:   'AWAIT_PRICING_VALUE',
  // Bonus config
  AWAIT_BONUS_CONFIG_VALUE: 'AWAIT_BONUS_CONFIG_VALUE',
  // Personal bonus (driver profile)
  AWAIT_PERSONAL_BONUS_AMOUNT:    'AWAIT_PERSONAL_BONUS_AMOUNT',
  AWAIT_PERSONAL_BONUS_THRESHOLD: 'AWAIT_PERSONAL_BONUS_THRESHOLD',
  // Global discount
  AWAIT_GLOBAL_DISC_AMOUNT: 'AWAIT_GLOBAL_DISC_AMOUNT',
  // Promo codes
  AWAIT_PROMO_CODE_TEXT: 'AWAIT_PROMO_CODE_TEXT',
  AWAIT_PROMO_AMOUNT:    'AWAIT_PROMO_AMOUNT',
  AWAIT_PROMO_MAX_USES:  'AWAIT_PROMO_MAX_USES',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step: STEPS.IDLE, role: null,
      order: {}, bonus: {}, wd: {},
      drvMgmt: {}, passMgmt: {}, broadcast: {},
      adminMgmt: {}, pricing: {}, bonusCfg: {},
      personalBonus: {}, globalDiscount: {}, promoMgmt: {},
    });
  }
  return sessions.get(chatId);
}

function setStep(chatId, step) {
  getSession(chatId).step = step;
}

function updateOrder(chatId, data) { Object.assign(getSession(chatId).order, data); }
function updateBonus(chatId, data) { Object.assign(getSession(chatId).bonus, data); }
function updateWd(chatId, data)    { Object.assign(getSession(chatId).wd,    data); }

function clearOrder(chatId) {
  const s = getSession(chatId);
  s.order = {};
  s.step  = STEPS.IDLE;
}

function clearBonus(chatId) {
  const s = getSession(chatId);
  s.bonus = {};
  s.step  = STEPS.IDLE;
}

function clearWd(chatId) {
  const s = getSession(chatId);
  s.wd   = {};
  s.step = STEPS.IDLE;
}

function updateDrvMgmt(chatId, data) { Object.assign(getSession(chatId).drvMgmt, data); }
function clearDrvMgmt(chatId) {
  const s    = getSession(chatId);
  s.drvMgmt = {};
  s.step    = STEPS.IDLE;
}

function updatePassMgmt(chatId, data) { Object.assign(getSession(chatId).passMgmt, data); }
function clearPassMgmt(chatId) {
  const s     = getSession(chatId);
  s.passMgmt  = {};
  s.step      = STEPS.IDLE;
}

function updateBroadcast(chatId, data) { Object.assign(getSession(chatId).broadcast, data); }
function clearBroadcast(chatId) {
  const s     = getSession(chatId);
  s.broadcast = {};
  s.step      = STEPS.IDLE;
}

function updateAdminMgmt(chatId, data) { Object.assign(getSession(chatId).adminMgmt, data); }
function clearAdminMgmt(chatId) {
  const s      = getSession(chatId);
  s.adminMgmt  = {};
  s.step       = STEPS.IDLE;
}

function updatePricing(chatId, data) { Object.assign(getSession(chatId).pricing, data); }
function clearPricing(chatId) {
  const s   = getSession(chatId);
  s.pricing = {};
  s.step    = STEPS.IDLE;
}

function updateBonusCfg(chatId, data) { Object.assign(getSession(chatId).bonusCfg, data); }
function clearBonusCfg(chatId) {
  const s      = getSession(chatId);
  s.bonusCfg   = {};
  s.step       = STEPS.IDLE;
}

function updatePersonalBonus(chatId, data) { Object.assign(getSession(chatId).personalBonus, data); }
function clearPersonalBonus(chatId) {
  const s          = getSession(chatId);
  s.personalBonus  = {};
  s.step           = STEPS.IDLE;
}

function updateGlobalDiscount(chatId, data) { Object.assign(getSession(chatId).globalDiscount, data); }
function clearGlobalDiscount(chatId) {
  const s           = getSession(chatId);
  s.globalDiscount  = {};
  s.step            = STEPS.IDLE;
}

function updatePromoMgmt(chatId, data) { Object.assign(getSession(chatId).promoMgmt, data); }
function clearPromoMgmt(chatId) {
  const s      = getSession(chatId);
  s.promoMgmt  = {};
  s.step       = STEPS.IDLE;
}

module.exports = {
  STEPS, getSession, setStep,
  updateOrder, updateBonus, updateWd, updateDrvMgmt, updatePassMgmt, updateBroadcast,
  clearOrder, clearBonus, clearWd, clearDrvMgmt, clearPassMgmt, clearBroadcast,
  updateAdminMgmt, clearAdminMgmt,
  updatePricing, clearPricing,
  updateBonusCfg, clearBonusCfg,
  updatePersonalBonus, clearPersonalBonus,
  updateGlobalDiscount, clearGlobalDiscount,
  updatePromoMgmt, clearPromoMgmt,
};
