const STEPS = {
  IDLE:               'IDLE',
  AWAIT_REG_NAME:     'AWAIT_REG_NAME',
  AWAIT_REG_PHONE:    'AWAIT_REG_PHONE',
  AWAIT_PICKUP_LOC:   'AWAIT_PICKUP_LOC',
  AWAIT_DEST_LOC:     'AWAIT_DEST_LOC',
  AWAIT_VEHICLE_SIZE: 'AWAIT_VEHICLE_SIZE',
  AWAIT_CAN_ROLL:     'AWAIT_CAN_ROLL',
  AWAIT_PAYMENT:      'AWAIT_PAYMENT',
  AWAIT_CONFIRM:      'AWAIT_CONFIRM',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: STEPS.IDLE, reg: {}, order: {} });
  }
  return sessions.get(chatId);
}

function setStep(chatId, step) {
  getSession(chatId).step = step;
}

function updateOrder(chatId, data) {
  Object.assign(getSession(chatId).order, data);
}

function updateReg(chatId, data) {
  Object.assign(getSession(chatId).reg, data);
}

// Resets draft order and reg; step must be set separately.
function clearOrder(chatId) {
  const session = getSession(chatId);
  session.order = {};
  session.reg = {};
}

module.exports = { STEPS, getSession, setStep, updateOrder, updateReg, clearOrder };
