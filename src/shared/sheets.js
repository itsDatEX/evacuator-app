const { google } = require('googleapis');
const config = require('../config');
const logger = require('./logger');

if (!config.google.serviceAccountEmail || !config.google.privateKey) {
  throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY in environment');
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: config.google.serviceAccountEmail,
    private_key:  config.google.privateKey,
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Expected "Config" sheet, columns A (key) | B (value):
//   base_fare               | 20
//   price_per_km            | 1.50
//   jeep_surcharge          | 0.15   (fraction of base, e.g. 0.15 = +15%)
//   large_vehicle_surcharge | 0.15   (fraction of base)
//   non_rolling_surcharge   | 0.30   (fraction of base)
//   bonus_threshold         | 10
//   bonus_amount            | 20
//   commission_rate         | 0.15

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _cacheTime = 0;

async function getPricingConfig() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.spreadsheetId,
    range: 'Config!A2:B20',
  });

  const raw = {};
  for (const [key, value] of (res.data.values || [])) {
    raw[key.trim()] = parseFloat(value);
  }

  const required = [
    'base_fare', 'price_per_km',
    'jeep_surcharge', 'large_vehicle_surcharge', 'non_rolling_surcharge',
    'bonus_threshold', 'bonus_amount', 'commission_rate',
  ];
  for (const field of required) {
    if (isNaN(raw[field])) {
      throw new Error(`Pricing config missing or invalid: "${field}"`);
    }
  }

  _cache = {
    baseFare:              raw['base_fare'],
    pricePerKm:            raw['price_per_km'],
    jeepSurcharge:         raw['jeep_surcharge'],
    largeVehicleSurcharge: raw['large_vehicle_surcharge'],
    nonRollingSurcharge:   raw['non_rolling_surcharge'],
    bonusThreshold:        raw['bonus_threshold'],
    bonusAmount:           raw['bonus_amount'],
    commissionRate:        raw['commission_rate'],
    partnerCommissionRate: isNaN(raw['partner_commission_rate']) ? null : raw['partner_commission_rate'],
  };
  _cacheTime = now;
  logger.info('Pricing config refreshed from Google Sheets', _cache);
  return _cache;
}

// vehicleSize: 'normal' | 'jeep' | 'large'
// canRoll: boolean
// discountAmount: ₾ to subtract (passenger loyalty discount); capped at subtotal
// Surcharges are fractions of base (e.g. 0.15 = +15% of base fare).
async function calculatePrice(distanceKm, vehicleSize, canRoll, discountAmount = 0) {
  const cfg = await getPricingConfig();

  const base = cfg.baseFare + cfg.pricePerKm * distanceKm;

  let sizeFee = 0;
  if (vehicleSize === 'jeep')  sizeFee = Math.round(base * cfg.jeepSurcharge * 100) / 100;
  if (vehicleSize === 'large') sizeFee = Math.round(base * cfg.largeVehicleSurcharge * 100) / 100;

  const craneFee = canRoll ? 0 : Math.round(base * cfg.nonRollingSurcharge * 100) / 100;
  const subtotal = base + sizeFee + craneFee;

  const discount = Math.min(discountAmount, subtotal);
  const total    = Math.round((subtotal - discount) * 100) / 100;

  return {
    total,
    breakdown: {
      base_fare:    cfg.baseFare,
      price_per_km: cfg.pricePerKm,
      distance_fee: Math.round(cfg.pricePerKm * distanceKm * 100) / 100,
      size_fee:     sizeFee,
      crane_fee:    craneFee,
      discount:     discount > 0 ? -Math.round(discount * 100) / 100 : 0,
    },
  };
}

function invalidatePricingCache() {
  _cache = null;
  _cacheTime = 0;
}

async function updatePricingConfig(key, value) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.spreadsheetId,
    range: 'Config!A:A',
  });
  const keys     = res.data.values || [];
  const rowIndex = keys.findIndex(([k]) => k?.trim() === key);
  if (rowIndex < 0) throw new Error(`Config key not found in sheet: "${key}"`);
  const rowNumber = rowIndex + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.spreadsheetId,
    range:         `Config!B${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody:   { values: [[String(value)]] },
  });

  invalidatePricingCache();
  logger.info('Pricing config updated', { key, value });
}

module.exports = { getPricingConfig, calculatePrice, invalidatePricingCache, updatePricingConfig };
