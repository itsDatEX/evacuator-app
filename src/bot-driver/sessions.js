'use strict';

const STEPS = {
  IDLE:                     'IDLE',
  AWAIT_REG_NAME:           'AWAIT_REG_NAME',
  AWAIT_REG_PHONE:          'AWAIT_REG_PHONE',
  AWAIT_TRUCK_TYPE:         'AWAIT_TRUCK_TYPE',
  AWAIT_CAR_MODEL:          'AWAIT_CAR_MODEL',
  AWAIT_PLATE:              'AWAIT_PLATE',
  AWAIT_ROUTE_FROM_METHOD:  'AWAIT_ROUTE_FROM_METHOD',
  AWAIT_ROUTE_FROM_TEXT:    'AWAIT_ROUTE_FROM_TEXT',
  AWAIT_ROUTE_FROM_CONFIRM: 'AWAIT_ROUTE_FROM_CONFIRM',
  AWAIT_ROUTE_TO_METHOD:    'AWAIT_ROUTE_TO_METHOD',
  AWAIT_ROUTE_TO_TEXT:      'AWAIT_ROUTE_TO_TEXT',
  AWAIT_ROUTE_TO_CONFIRM:   'AWAIT_ROUTE_TO_CONFIRM',
  AWAIT_ROUTE_DEPARTURE:    'AWAIT_ROUTE_DEPARTURE',
  // Self-service profile edit
  AWAIT_SELF_EDIT_FIELD:    'AWAIT_SELF_EDIT_FIELD',
  // Self-service withdrawal
  AWAIT_SELF_WD_BANK:       'AWAIT_SELF_WD_BANK',
  AWAIT_SELF_WD_AMOUNT:     'AWAIT_SELF_WD_AMOUNT',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step:          STEPS.IDLE,
      reg:           {},
      route:         {},
      pending:       null,
      activeOrderId: null,
      selfEdit:      {},
      selfWd:        {},
    });
  }
  return sessions.get(chatId);
}

function setStep(chatId, step)     { getSession(chatId).step = step; }
function updateReg(chatId, data)   { Object.assign(getSession(chatId).reg,   data); }
function updateRoute(chatId, data) { Object.assign(getSession(chatId).route, data); }
function clearReg(chatId)          { getSession(chatId).reg = {}; }

function clearRouteSession(chatId) {
  const session   = getSession(chatId);
  session.route   = {};
  session.pending = null;
}

function clearSelfEdit(chatId) {
  const s     = getSession(chatId);
  s.selfEdit  = {};
  s.step      = STEPS.IDLE;
}

function clearSelfWd(chatId) {
  const s  = getSession(chatId);
  s.selfWd = {};
  s.step   = STEPS.IDLE;
}

module.exports = {
  STEPS, getSession, setStep,
  updateReg, updateRoute, clearReg, clearRouteSession,
  clearSelfEdit, clearSelfWd,
};
