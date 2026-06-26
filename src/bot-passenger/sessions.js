'use strict';

const STEPS = {
  IDLE:                    'IDLE',
  AWAIT_REG_NAME:          'AWAIT_REG_NAME',
  AWAIT_REG_PHONE:         'AWAIT_REG_PHONE',
  AWAIT_PICKUP_LOC_METHOD: 'AWAIT_PICKUP_LOC_METHOD',
  AWAIT_PICKUP_TEXT:       'AWAIT_PICKUP_TEXT',
  AWAIT_PICKUP_CONFIRM:    'AWAIT_PICKUP_CONFIRM',
  AWAIT_DEST_LOC_METHOD:   'AWAIT_DEST_LOC_METHOD',
  AWAIT_DEST_TEXT:         'AWAIT_DEST_TEXT',
  AWAIT_DEST_CONFIRM:      'AWAIT_DEST_CONFIRM',
  AWAIT_VEHICLE_SIZE:      'AWAIT_VEHICLE_SIZE',
  AWAIT_CAN_ROLL:          'AWAIT_CAN_ROLL',
  AWAIT_PAYMENT:           'AWAIT_PAYMENT',
  AWAIT_CONFIRM:           'AWAIT_CONFIRM',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: STEPS.IDLE, reg: {}, order: {}, pending: null });
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

function clearOrder(chatId) {
  const session   = getSession(chatId);
  session.order   = {};
  session.reg     = {};
  session.pending = null;
}

module.exports = { STEPS, getSession, setStep, updateOrder, updateReg, clearOrder };
