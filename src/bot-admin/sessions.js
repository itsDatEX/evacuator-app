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
  AWAIT_WD_DRIVER_ID:    'AWAIT_WD_DRIVER_ID',
  AWAIT_WD_AMOUNT:       'AWAIT_WD_AMOUNT',
  AWAIT_WD_NOTE:         'AWAIT_WD_NOTE',
  // Driver management
  AWAIT_DRV_SEARCH:      'AWAIT_DRV_SEARCH',
  AWAIT_DRV_EDIT_FIELD:  'AWAIT_DRV_EDIT_FIELD',
  // Passenger management
  AWAIT_PASS_SEARCH:     'AWAIT_PASS_SEARCH',
  AWAIT_PASS_EDIT_FIELD: 'AWAIT_PASS_EDIT_FIELD',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: STEPS.IDLE, order: {}, bonus: {}, wd: {}, drvMgmt: {}, passMgmt: {} });
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

module.exports = {
  STEPS, getSession, setStep,
  updateOrder, updateBonus, updateWd, updateDrvMgmt, updatePassMgmt,
  clearOrder, clearBonus, clearWd, clearDrvMgmt, clearPassMgmt,
};
