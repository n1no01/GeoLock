import { centerMap, addGpsCircle } from './map.js';

// Ciljana preciznost: čim je očitanje bolje od ovoga, praćenje staje.
const TARGET_ACCURACY_M = 10;
const MAX_WAIT_MS = 25_000;
const POOR_ACCURACY_M = 50;

let lastFix = null; // { lat, lng, accuracy } zadnje prihvaćeno očitanje
let cancelActive = null;

export function getLastFix() { return lastFix; }
export function clearLastFix() { lastFix = null; }

/** Da li se vrijednosti u poljima i dalje poklapaju sa GPS očitanjem (korisnik ih nije ručno mijenjao). */
export function fixMatches(lat, lng) {
  return !!lastFix
    && lat.toFixed(6) === lastFix.lat.toFixed(6)
    && lng.toFixed(6) === lastFix.lng.toFixed(6);
}

function describeError(err) {
  if (err?.code === 1) return '❌ Pristup lokaciji je odbijen. Dozvolite ga u postavkama preglednika.';
  if (err?.code === 2) return '❌ GPS signal nedostupan.';
  return '❌ GPS očitanje nije uspjelo (istek vremena).';
}

/**
 * Prati satelite dok preciznost ne padne ispod cilja (ili do isteka vremena) i zadržava
 * NAJBOLJE očitanje. Ranije se uzimala prva (često gruba Wi-Fi/toranj) pozicija.
 * @param onUpdate  poziva se pri svakom poboljšanju (da UI osvježi MGRS/pregled)
 */
export function getCurrentLocation({ onUpdate, targetAccuracy = TARGET_ACCURACY_M, maxWait = MAX_WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const status = document.getElementById('gpsStatus');
    const setStatus = (text) => { if (status) status.textContent = text; };

    if (!navigator.geolocation) {
      setStatus('GPS nije podržan na ovom uređaju.');
      reject(new Error('Geolocation not supported'));
      return;
    }

    cancelActive?.(); // ponovni klik prekida prethodno praćenje

    let best = null;
    let finished = false;
    let watchId = null;
    let timer = null;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      cancelActive = null;

      if (best) {
        const acc = Math.round(best.accuracy);
        setStatus(best.accuracy > POOR_ACCURACY_M
          ? `⚠️ GPS očitan, ali slaba preciznost (~${acc} m). Pokušajte na otvorenom.`
          : `✓ GPS očitan (preciznost: ~${acc} m)`);
        resolve(best);
      } else {
        setStatus(describeError(err));
        reject(err ?? new Error('GPS timeout'));
      }
    };
    cancelActive = () => finish(new Error('cancelled'));

    setStatus('🛰️ Tražim GPS signal…');

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy;
        if (!best || accuracy < best.accuracy) {
          const first = best === null;
          best = {
            lat: parseFloat(pos.coords.latitude.toFixed(6)),
            lng: parseFloat(pos.coords.longitude.toFixed(6)),
            accuracy
          };
          lastFix = best;

          document.getElementById('lat').value = best.lat;
          document.getElementById('lng').value = best.lng;
          if (first) centerMap(best.lat, best.lng, 16);
          addGpsCircle(best.lat, best.lng, accuracy);
          onUpdate?.(best);
          setStatus(`🛰️ Preciznost ~${Math.round(accuracy)} m (cilj ≤ ${targetAccuracy} m)…`);
        }
        if (accuracy <= targetAccuracy) finish();
      },
      (err) => {
        // Istek vremena pojedinačnog očitanja nije fatalan ako već imamo neko očitanje
        if (!best || err.code === 1) finish(err);
      },
      { enableHighAccuracy: true, timeout: maxWait, maximumAge: 0 }
    );

    timer = setTimeout(() => finish(new Error('GPS timeout')), maxWait);
  });
}
