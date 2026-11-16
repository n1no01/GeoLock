// Upravljanje DEK-om: kreiranje, otključavanje lozinkom / recovery ključem,
// promjena lozinke, te čuvanje omotanog ključa lokalno i u Supabase (tabela user_keys).
// Sam DEK se NIKAD ne zapisuje u localStorage — samo omotani oblik.

import { supabase } from './supabase.js';
import {
  generateDataKey, deriveKeyFromPassword, importRawWrappingKey, wrapDataKey, unwrapDataKey,
  randomBytes, DecryptionError, PBKDF2_ITERATIONS, getActiveKey
} from './crypto.js';
import { bytesToBase64, base64ToBytes, formatRecoveryKey, parseRecoveryKey } from './utils.js';

const LOCAL_KEYRING = 'geolock_keyring_v1';

// ---------- Lokalni zapis ----------

export function loadLocalKeyring() {
  try {
    const rec = JSON.parse(localStorage.getItem(LOCAL_KEYRING));
    return rec && rec.wrappedPassword ? rec : null;
  } catch {
    return null;
  }
}

function saveLocalKeyring(record) {
  localStorage.setItem(LOCAL_KEYRING, JSON.stringify(record));
}

export function clearLocalKeyring() {
  localStorage.removeItem(LOCAL_KEYRING);
}

// ---------- Cloud zapis (tabela user_keys) ----------

function fromCloudRow(row, email) {
  return {
    version: 1,
    userId: row.user_id,
    email,
    salt: row.salt,
    iterations: row.iterations,
    wrappedPassword: row.wrapped_dek,
    wrappedRecovery: row.recovery_wrapped_dek
  };
}

export async function fetchCloudKeyring(userId, email) {
  const { data, error } = await supabase
    .from('user_keys')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Nije moguće dohvatiti enkripcijski ključ iz clouda (${error.message}). `
      + 'Provjerite da je pokrenut supabase/schema.sql.');
  }
  return data ? fromCloudRow(data, email) : null;
}

async function saveCloudKeyring(record) {
  const { error } = await supabase.from('user_keys').upsert({
    user_id: record.userId,
    salt: record.salt,
    iterations: record.iterations,
    wrapped_dek: record.wrappedPassword,
    recovery_wrapped_dek: record.wrappedRecovery,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw new Error(`Spremanje enkripcijskog ključa u cloud nije uspjelo: ${error.message}`);
}

// ---------- Gradivni blokovi ----------

async function wrapForPassword(dek, password) {
  const salt = randomBytes(16);
  const kek = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS);
  return {
    salt: bytesToBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    wrappedPassword: await wrapDataKey(dek, kek)
  };
}

async function wrapForRecovery(dek) {
  const bytes = randomBytes(32);
  return {
    recoveryKey: formatRecoveryKey(bytes),
    wrappedRecovery: await wrapDataKey(dek, await importRawWrappingKey(bytes))
  };
}

async function unwrapWithPassword(record, password) {
  const kek = await deriveKeyFromPassword(password, base64ToBytes(record.salt), record.iterations);
  return unwrapDataKey(record.wrappedPassword, kek);
}

// ---------- Javni tokovi ----------

/**
 * Otključava DEK lozinkom.
 * Povratna vrijednost:
 *   { dek }                                  – uspjeh
 *   { dek, created: true, recoveryKey }      – prvi put: ključ kreiran, prikazati recovery ključ
 *   { needsRecovery: true, cloudRecord }     – lozinka ispravna za Supabase ali ne za keyring
 *                                              (lozinka je resetovana) -> traži se recovery ključ
 * Baca grešku kod pogrešne lozinke u offline načinu.
 */
export async function unlockWithPassword({ email, password, user }) {
  const emailNorm = email.trim().toLowerCase();
  const local = loadLocalKeyring();

  // 1) Lokalni keyring (radi i offline)
  if (local && local.email === emailNorm && (!user || local.userId === user.id)) {
    try {
      const dek = await unwrapWithPassword(local, password);
      if (user) healCloudKeyring(local).catch(() => {});
      return { dek, record: local };
    } catch (err) {
      if (!(err instanceof DecryptionError)) throw err;
      // nastavi na cloud: lozinka je možda promijenjena na drugom uređaju
    }
  }

  if (!user) {
    throw new DecryptionError(local && local.email === emailNorm
      ? 'Pogrešna lozinka.'
      : 'Offline prijava je moguća samo za račun koji je već prijavljen na ovom uređaju.');
  }

  // 2) Cloud keyring
  const cloud = await fetchCloudKeyring(user.id, emailNorm);
  if (cloud) {
    try {
      const dek = await unwrapWithPassword(cloud, password);
      saveLocalKeyring(cloud);
      return { dek, record: cloud };
    } catch (err) {
      if (!(err instanceof DecryptionError)) throw err;
      return { needsRecovery: true, cloudRecord: cloud };
    }
  }

  // 3) Prvi put: kreiraj DEK + recovery ključ
  const dek = await generateDataKey();
  const pw = await wrapForPassword(dek, password);
  const rec = await wrapForRecovery(dek);
  const record = {
    version: 1, userId: user.id, email: emailNorm, ...pw, wrappedRecovery: rec.wrappedRecovery
  };
  await saveCloudKeyring(record); // mora uspjeti, inače drugi uređaji ne mogu dešifrovati
  saveLocalKeyring(record);
  return { dek, record, created: true, recoveryKey: rec.recoveryKey };
}

/** Ako cloud nema keyring (npr. prethodni upload nije uspio), pošalji ga. */
async function healCloudKeyring(record) {
  if (!navigator.onLine) return;
  const existing = await fetchCloudKeyring(record.userId, record.email);
  if (!existing) await saveCloudKeyring(record);
}

/** Otključava recovery ključem i ponovo omotava DEK novom lozinkom. */
export async function unlockWithRecovery({ recoveryText, cloudRecord, newPassword }) {
  let bytes;
  try {
    bytes = parseRecoveryKey(recoveryText);
  } catch {
    throw new DecryptionError('Recovery ključ nije ispravnog formata.');
  }
  const dek = await unwrapDataKey(cloudRecord.wrappedRecovery, await importRawWrappingKey(bytes))
    .catch(() => { throw new DecryptionError('Recovery ključ nije ispravan.'); });

  const record = { ...cloudRecord, ...(await wrapForPassword(dek, newPassword)) };
  await saveCloudKeyring(record);
  saveLocalKeyring(record);
  return { dek, record };
}

/** Omotaj isti DEK novom lozinkom (DEK se ne mijenja, pa podaci ostaju čitljivi). */
export async function rewrapPassword(newPassword) {
  const dek = getActiveKey();
  const local = loadLocalKeyring();
  if (!dek || !local) throw new Error('Aplikacija mora biti otključana.');
  const record = { ...local, ...(await wrapForPassword(dek, newPassword)) };
  if (navigator.onLine) await saveCloudKeyring(record);
  saveLocalKeyring(record);
}

/** Novi recovery ključ (stari prestaje važiti). */
export async function regenerateRecoveryKey() {
  const dek = getActiveKey();
  const local = loadLocalKeyring();
  if (!dek || !local) throw new Error('Aplikacija mora biti otključana.');
  if (!navigator.onLine) throw new Error('Za novi recovery ključ potrebna je internet konekcija.');
  const rec = await wrapForRecovery(dek);
  const record = { ...local, wrappedRecovery: rec.wrappedRecovery };
  await saveCloudKeyring(record);
  saveLocalKeyring(record);
  return rec.recoveryKey;
}

/** Provjera lozinke prema lokalnom keyringu (za osjetljive radnje dok je aplikacija otključana). */
export async function verifyPassword(password) {
  const local = loadLocalKeyring();
  if (!local) return false;
  try {
    await unwrapWithPassword(local, password);
    return true;
  } catch {
    return false;
  }
}

/** Briše keyring iz clouda (koristi se samo pri "počni iznova" nakon izgubljenog recovery ključa). */
export async function deleteCloudKeyring(userId) {
  const { error } = await supabase.from('user_keys').delete().eq('user_id', userId);
  if (error) throw new Error(`Brisanje ključa nije uspjelo: ${error.message}`);
}
