// Biometrijsko otključavanje preko WebAuthn PRF ekstenzije.
//
// Autentifikator (otisak / FaceID / Windows Hello) za isti credential i isti "salt" uvijek vraća
// isti tajni PRF izlaz — ali samo nakon uspješne biometrijske provjere. Iz tog izlaza izvodimo
// KEK koji omotava DEK. U localStorage ostaje samo omotani DEK, pa bez biometrije (ili lozinke)
// ključ nije dostupan, za razliku od stare verzije koja ga je držala u plain tekstu.
//
// Ako uređaj/preglednik ne podržava PRF, biometrija se ne nudi (lozinka uvijek radi).

import {
  deriveKeyFromPrf, wrapDataKey, unwrapDataKey, getActiveKey, setActiveKey, randomBytes
} from './crypto.js';
import { bytesToBase64, base64ToBytes } from './utils.js';

const BIO_STORAGE = 'geolock_bio_v1';

function loadRecord() {
  try {
    const rec = JSON.parse(localStorage.getItem(BIO_STORAGE));
    return rec && rec.credId && rec.wrapped ? rec : null;
  } catch {
    return null;
  }
}

export async function isBiometricsAvailable() {
  try {
    return !!(window.PublicKeyCredential
      && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export function isBiometricsEnabled(userId) {
  const rec = loadRecord();
  return !!rec && (!userId || rec.userId === userId);
}

export function removeBiometrics() {
  localStorage.removeItem(BIO_STORAGE);
}

function prfFromResult(credential) {
  const ext = credential.getClientExtensionResults?.() ?? {};
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function assertWithPrf(credId, prfSalt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: window.location.hostname,
      allowCredentials: [{ id: credId, type: 'public-key', transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } }
    }
  });
  return assertion ? prfFromResult(assertion) : null;
}

/**
 * Registruje biometriju za trenutno otključanu sesiju.
 * Vraća { ok: true } ili { ok: false, reason }.
 */
export async function registerBiometrics(userId, userLabel = 'GeoLock korisnik') {
  const dek = getActiveKey();
  if (!dek) return { ok: false, reason: 'Prvo se prijavite lozinkom.' };
  if (!(await isBiometricsAvailable())) {
    return { ok: false, reason: 'Vaš uređaj ne podržava biometrijsku autentifikaciju.' };
  }

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'GeoLock', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode(String(userId || 'geolock')).slice(0, 64),
          name: userLabel,
          displayName: userLabel
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'discouraged'
        },
        timeout: 60000,
        extensions: { prf: {} }
      }
    });
    if (!credential) return { ok: false, reason: 'Registracija je otkazana.' };

    // Neki preglednici ne vraćaju PRF rezultat pri kreiranju, pa ga tražimo drugim pozivom.
    const credId = new Uint8Array(credential.rawId);
    const prfSalt = randomBytes(32);
    const prf = await assertWithPrf(credId, prfSalt);
    if (!prf) {
      return {
        ok: false,
        reason: 'Ovaj uređaj/preglednik ne podržava siguran biometrijski ključ (WebAuthn PRF). '
          + 'Koristite lozinku.'
      };
    }

    const kek = await deriveKeyFromPrf(prf);
    localStorage.setItem(BIO_STORAGE, JSON.stringify({
      userId,
      credId: bytesToBase64(credId),
      prfSalt: bytesToBase64(prfSalt),
      wrapped: await wrapDataKey(dek, kek)
    }));
    return { ok: true };
  } catch (err) {
    console.warn('Biometrijska registracija nije uspjela:', err);
    return { ok: false, reason: 'Biometrijska registracija je otkazana ili nije uspjela.' };
  }
}

/** Otključava DEK biometrijom. Vraća true/false. */
export async function unlockWithBiometrics() {
  const rec = loadRecord();
  if (!rec) return false;
  try {
    const prf = await assertWithPrf(base64ToBytes(rec.credId), base64ToBytes(rec.prfSalt));
    if (!prf) return false;
    const dek = await unwrapDataKey(rec.wrapped, await deriveKeyFromPrf(prf));
    setActiveKey(dek);
    return true;
  } catch (err) {
    console.warn('Biometrijsko otključavanje nije uspjelo:', err);
    return false;
  }
}
