'use strict';

const logger = require('./logger');

const USER_AGENT  = 'evacuator-app/1.0';
const TIMEOUT_MS  = 5000;
const RATE_LIMIT_MS = 1100; // Nominatim policy: max 1 req/sec

let _lastRequestAt = 0;

async function reverseGeocode(lat, lng) {
  const wait = RATE_LIMIT_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=json&lat=${lat}&lon=${lng}&accept-language=ka,en`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const addr = data.address || {};
    return addr.city || addr.town || addr.suburb || addr.village || addr.county || null;
  } catch (err) {
    logger.warn('reverseGeocode failed', { lat, lng, error: err.message });
    return null;
  }
}

async function forwardGeocode(query) {
  const wait = RATE_LIMIT_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1&accept-language=ka,en`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.length) return null;
    const { lat, lon, display_name, address } = data[0];
    const addr = address || {};
    const city = addr.city || addr.town || addr.suburb || addr.village || addr.county || null;
    return { lat: parseFloat(lat), lng: parseFloat(lon), displayName: display_name, city };
  } catch (err) {
    logger.warn('forwardGeocode failed', { query, error: err.message });
    return null;
  }
}

module.exports = { reverseGeocode, forwardGeocode };
