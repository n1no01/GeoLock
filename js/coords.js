// Koordinate: Lat/Lng <-> MGRS. Jedna implementacija umjesto tri kopije.

import * as mgrs from 'mgrs';
import { isValidLatLng } from './utils.js';

export function toMgrs(lat, lng, precision = 5) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!isValidLatLng(la, ln)) return null;
  try {
    return mgrs.forward([ln, la], precision);
  } catch {
    return null; // MGRS nije definisan iznad 84°N / ispod 80°S
  }
}

export function fromMgrs(text) {
  try {
    const [lng, lat] = mgrs.toPoint(String(text).trim());
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  } catch {
    return null; // nepotpun unos tokom kucanja je očekivan
  }
}

/**
 * Dvosmjerna veza polja Lat / Lng / MGRS (koristi se na formi za unos i na formi za izmjenu).
 * onChange(source) se poziva nakon promjene koordinata ('latlng' | 'mgrs').
 */
export function bindCoordinateInputs({ latEl, lngEl, mgrsEl, onChange }) {
  if (!latEl || !lngEl || !mgrsEl) return { refreshMgrs: () => {} };

  const refreshMgrs = () => {
    mgrsEl.value = toMgrs(parseFloat(latEl.value), parseFloat(lngEl.value)) ?? '';
  };

  const onLatLngInput = () => {
    refreshMgrs();
    onChange?.('latlng');
  };
  latEl.addEventListener('input', onLatLngInput);
  lngEl.addEventListener('input', onLatLngInput);

  mgrsEl.addEventListener('input', () => {
    if (mgrsEl.value.trim().length < 3) return;
    const point = fromMgrs(mgrsEl.value);
    if (!point) return;
    latEl.value = point.lat.toFixed(6);
    lngEl.value = point.lng.toFixed(6);
    onChange?.('mgrs');
  });

  return { refreshMgrs };
}
