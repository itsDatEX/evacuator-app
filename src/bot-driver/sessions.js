'use strict';

const STEPS = {
  IDLE:                  'IDLE',
  AWAIT_REG_NAME:        'AWAIT_REG_NAME',
  AWAIT_REG_PHONE:       'AWAIT_REG_PHONE',
  AWAIT_TRUCK_TYPE:      'AWAIT_TRUCK_TYPE',
  AWAIT_CAR_MODEL:       'AWAIT_CAR_MODEL',
  AWAIT_PLATE:           'AWAIT_PLATE',
  AWAIT_ROUTE_FROM:      'AWAIT_ROUTE_FROM',
  AWAIT_ROUTE_TO:        'AWAIT_ROUTE_TO',
  AWAIT_ROUTE_DEPARTURE: 'AWAIT_ROUTE_DEPARTURE',
};

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step:          STEPS.IDLE,
      reg:           {},
      route:         {},
      activeOrderId: null,
    });
  }
  return sessions.get(chatId);
}

function setStep(chatId, step)       { getSession(chatId).step = step; }
function updateReg(chatId, data)     { Object.assign(getSession(chatId).reg,   data); }
function updateRoute(chatId, data)   { Object.assign(getSession(chatId).route, data); }
function clearReg(chatId)            { getSession(chatId).reg   = {}; }
function clearRouteSession(chatId)   { getSession(chatId).route = {}; }

module.exports = {
  STEPS, getSession, setStep,
  updateReg, updateRoute, clearReg, clearRouteSession,
};
