const R = 6371; // Earth radius in km

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordsLabel(lat, lng) {
  return `📍 ${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}`;
}

const OSRM_TIMEOUT_MS = 5000;

async function getRoadDistanceKm(lat1, lng1, lat2, lng2) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${lng1},${lat1};${lng2},${lat2}?overview=false`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('no route');
    return data.routes[0].distance / 1000;
  } catch {
    return haversineKm(lat1, lng1, lat2, lng2);
  }
}

module.exports = { haversineKm, coordsLabel, getRoadDistanceKm };
