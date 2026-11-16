// Kriptografski primitivi (WebCrypto).
//
// Model ključeva:
//   DEK (data encryption key)  - nasumični AES-256-GCM ključ koji šifruje sve podatke.
//   KEK (key encryption key)   - izveden iz lozinke (PBKDF2-SHA256, 600k iteracija, nasumični salt)
//                                ILI iz recovery ključa ILI iz WebAuthn PRF izlaza.
//   DEK se čuva samo "omotan" (wrapped) pod KEK-om; u memoriji je dok je aplikacija otključana.
//   Zbog ovoga promjena/reset lozinke ne uništava podatke (samo se DEK ponovo omota).
//
// Format šifrata: "v1:" + base64( IV[12] || ciphertext+GCM-tag ).
// Stari (CryptoJS "U2FsdGVkX1…") format se podržava SAMO za čitanje/migraciju.

import { bytesToBase64, base64ToBytes } from './utils.js';

export const FORMAT_PREFIX = 'v1:';
export const PBKDF2_ITERATIONS = 600_000; // OWASP preporuka za PBKDF2-HMAC-SHA256
const IV_LENGTH = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class DecryptionError extends Error {
  constructor(message = 'Dešifrovanje nije uspjelo (pogrešan ključ ili oštećeni podaci).') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class LockedError extends Error {
  constructor() {
    super('Aplikacija je zaključana. Prijavite se ili otključajte biometrijom.');
    this.name = 'LockedError';
  }
}

// ---------- Ključ u memoriji (nikad u localStorage) ----------

let activeKey = null;
let legacyKey = null; // CryptoJS passphrase, samo za migraciju starih podataka

export function setActiveKey(key) { activeKey = key; }
export function getActiveKey() { return activeKey; }
export function hasActiveKey() { return activeKey !== null; }
export function setLegacyKey(key) { legacyKey = key; }
export function getLegacyKey() { return legacyKey; }
export function clearKeys() { activeKey = null; legacyKey = null; }

function requireKey(key) {
  const k = key || activeKey;
  if (!k) throw new LockedError();
  return k;
}

// ---------- Pomoćno ----------

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------- Ključevi ----------

export function generateDataKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** KEK iz lozinke. */
export async function deriveKeyFromPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/** KEK iz visoko-entropijskih sirovih bajtova (recovery ključ). */
export function importRawWrappingKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

/** KEK iz WebAuthn PRF izlaza (HKDF). */
export async function deriveKeyFromPrf(prfOutput) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('geolock-bio-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function wrapDataKey(dek, wrappingKey) {
  const iv = randomBytes(IV_LENGTH);
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', dek, wrappingKey, { name: 'AES-GCM', iv }));
  return FORMAT_PREFIX + bytesToBase64(concat(iv, wrapped));
}

export async function unwrapDataKey(wrapped, wrappingKey) {
  try {
    if (!isEncryptedV1(wrapped)) throw new Error('format');
    const raw = base64ToBytes(wrapped.slice(FORMAT_PREFIX.length));
    return await crypto.subtle.unwrapKey(
      'raw',
      raw.slice(IV_LENGTH),
      wrappingKey,
      { name: 'AES-GCM', iv: raw.slice(0, IV_LENGTH) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } catch {
    throw new DecryptionError('Pogrešna lozinka ili ključ.');
  }
}

// ---------- Šifrovanje podataka ----------

export function isEncryptedV1(value) {
  return typeof value === 'string' && value.startsWith(FORMAT_PREFIX);
}

/** bajtovi -> IV || ciphertext */
export async function encryptBytes(bytes, key) {
  const k = requireKey(key);
  const iv = randomBytes(IV_LENGTH);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes));
  return concat(iv, ct);
}

export async function decryptBytes(data, key) {
  const k = requireKey(key);
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < IV_LENGTH + 16) throw new DecryptionError();
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u8.slice(0, IV_LENGTH) },
      k,
      u8.slice(IV_LENGTH)
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptionError();
  }
}

export async function encryptText(text, key) {
  const bytes = await encryptBytes(encoder.encode(String(text ?? '')), key);
  return FORMAT_PREFIX + bytesToBase64(bytes);
}

export async function decryptText(ciphertext, key) {
  if (!isEncryptedV1(ciphertext)) throw new DecryptionError('Nepoznat format šifrata.');
  const bytes = await decryptBytes(base64ToBytes(ciphertext.slice(FORMAT_PREFIX.length)), key);
  return decoder.decode(bytes);
}

export function encryptJson(obj, key) {
  return encryptText(JSON.stringify(obj), key);
}

export async function decryptJson(ciphertext, key) {
  return JSON.parse(await decryptText(ciphertext, key));
}

// ---------- Stari format (CryptoJS) — samo za migraciju ----------

export function isLegacyCiphertext(value) {
  return typeof value === 'string' && value.startsWith('U2FsdGVkX1');
}

/** Binarni sadržaj koji počinje ASCII-jem "Salted__" u base64 ("U2FsdGVkX1"). */
export function isLegacyBytes(u8) {
  if (!u8 || u8.length < 10) return false;
  return decoder.decode(u8.subarray(0, 10)) === 'U2FsdGVkX1';
}

/** Ista derivacija kao stara verzija (PBKDF2-SHA1, 10k iteracija, salt = SHA256(email)). */
export async function deriveLegacyKey(email, password) {
  const CryptoJS = (await import('crypto-js')).default;
  const salt = CryptoJS.SHA256(String(email).toLowerCase().trim()).toString();
  return CryptoJS.PBKDF2(password, salt, { keySize: 256 / 32, iterations: 10000 }).toString();
}

export async function decryptLegacyText(ciphertext, passphrase = legacyKey) {
  if (!passphrase) throw new DecryptionError('Za stari format potrebna je prijava lozinkom.');
  const CryptoJS = (await import('crypto-js')).default;
  try {
    const out = CryptoJS.AES.decrypt(String(ciphertext), passphrase).toString(CryptoJS.enc.Utf8);
    if (!out) throw new Error('empty');
    return out;
  } catch {
    throw new DecryptionError();
  }
}

/** Dešifruje novi ili stari format; nešifrovan tekst vraća nepromijenjen. */
export async function decryptAnyText(value, key) {
  if (value === null || value === undefined || value === '') return value ?? '';
  if (isEncryptedV1(value)) return decryptText(value, key);
  if (isLegacyCiphertext(value)) return decryptLegacyText(value);
  return value;
}

/** Ukloni ključeve koje je stara verzija ostavila u plain tekstu u localStorage. */
export function purgeLegacyStorage() {
  for (const name of ['terenska_secret_key', 'bio_vault_key', 'bio_cred_id', 'bio_session_active',
    'bio_user_email', 'bio_user_pass', 'biometrics_enabled']) {
    localStorage.removeItem(name);
  }
}
