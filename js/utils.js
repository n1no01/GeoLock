// Čiste pomoćne funkcije bez zavisnosti od DOM-a (lako testirati).

export function uuid() {
  return crypto.randomUUID();
}

// ---------- Base64 / Base32 ----------

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000; // izbjegava "Maximum call stack size exceeded" kod velikih nizova
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** "data:image/jpeg;base64,..." -> Blob (bez fetch-a, pa radi i uz strogi CSP). */
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Neispravan data URL.');
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = match[2].includes(';base64');
  const payload = match[3];
  const bytes = isBase64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mime });
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function bytesToBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32ToBytes(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 32 bajta -> "ABCD-EFGH-..." (13 grupa po 4 znaka, lako za prepisivanje) */
export function formatRecoveryKey(bytes) {
  return bytesToBase32(bytes).match(/.{1,4}/g).join('-');
}

export function parseRecoveryKey(text) {
  const bytes = base32ToBytes(text);
  if (bytes.length !== 32) throw new Error('Neispravan recovery ključ.');
  return bytes;
}

// ---------- Validacija i formatiranje ----------

export function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/** Ime fajla bez znakova koji su nedozvoljeni na Windows/macOS/Linux. */
export function safeFileName(name, fallback = 'fajl') {
  const cleaned = String(name ?? '')
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- kontrolni znakovi su namjerno uklonjeni iz imena fajla
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * CSV ćelija: udvostručuje navodnike i neutralizira "formula injection"
 * (vrijednosti koje počinju sa = + - @ TAB CR ih Excel/Sheets izvrši kao formulu).
 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}
