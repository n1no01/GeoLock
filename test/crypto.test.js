import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateDataKey, deriveKeyFromPassword, importRawWrappingKey, wrapDataKey, unwrapDataKey,
  encryptText, decryptText, encryptJson, decryptJson, encryptBytes, decryptBytes,
  setActiveKey, clearKeys, hasActiveKey, DecryptionError, LockedError, isEncryptedV1,
  randomBytes, decryptAnyText, isLegacyCiphertext, deriveLegacyKey, setLegacyKey, getLegacyKey,
  PBKDF2_ITERATIONS
} from '../js/crypto.js';

beforeEach(() => clearKeys());

describe('AES-GCM šifrovanje', () => {
  it('round-trip za tekst sa dijakritičkim znakovima i emotikonima', async () => {
    const key = await generateDataKey();
    const text = 'Šđčćž — lokacija 📍 "test"';
    const enc = await encryptText(text, key);
    expect(isEncryptedV1(enc)).toBe(true);
    expect(await decryptText(enc, key)).toBe(text);
  });

  it('isti tekst daje različit šifrat (nasumični IV)', async () => {
    const key = await generateDataKey();
    expect(await encryptText('x', key)).not.toBe(await encryptText('x', key));
  });

  it('pogrešan ključ -> DecryptionError (ne vraća šifrat kao ranije)', async () => {
    const enc = await encryptText('tajna', await generateDataKey());
    await expect(decryptText(enc, await generateDataKey())).rejects.toBeInstanceOf(DecryptionError);
  });

  it('GCM otkriva izmjenu šifrata (autentifikacija)', async () => {
    const key = await generateDataKey();
    const bytes = await encryptBytes(new TextEncoder().encode('podaci'), key);
    bytes[bytes.length - 1] ^= 0xff;
    await expect(decryptBytes(bytes, key)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('JSON round-trip', async () => {
    const key = await generateDataKey();
    const obj = { a: 1, b: [1, 2, 3], c: { d: 'č' } };
    expect(await decryptJson(await encryptJson(obj, key), key)).toEqual(obj);
  });

  it('bez ključa baca LockedError', async () => {
    await expect(encryptText('x')).rejects.toBeInstanceOf(LockedError);
  });

  it('koristi aktivni ključ kad nije proslijeđen', async () => {
    setActiveKey(await generateDataKey());
    expect(hasActiveKey()).toBe(true);
    expect(await decryptText(await encryptText('abc'))).toBe('abc');
  });

  it('veliki binarni sadržaj (5 MB)', async () => {
    const key = await generateDataKey();
    const data = new Uint8Array(5 * 1024 * 1024).fill(7);
    const back = await decryptBytes(await encryptBytes(data, key), key);
    // Buffer.compare umjesto toEqual: poređenje 5M elemenata u vitestu traje desetak sekundi
    expect(back.length).toBe(data.length);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
  });
});

describe('omotani ključ (DEK wrapping)', () => {
  it('lozinka: wrap/unwrap vraća ključ koji dešifruje stare podatke', async () => {
    const dek = await generateDataKey();
    const enc = await encryptText('podatak', dek);

    const salt = randomBytes(16);
    const kek = await deriveKeyFromPassword('tačna lozinka 123', salt, 1000);
    const wrapped = await wrapDataKey(dek, kek);

    const restored = await unwrapDataKey(wrapped, await deriveKeyFromPassword('tačna lozinka 123', salt, 1000));
    expect(await decryptText(enc, restored)).toBe('podatak');
  });

  it('pogrešna lozinka ne otključava ključ', async () => {
    const dek = await generateDataKey();
    const salt = randomBytes(16);
    const wrapped = await wrapDataKey(dek, await deriveKeyFromPassword('prava', salt, 1000));
    await expect(unwrapDataKey(wrapped, await deriveKeyFromPassword('kriva', salt, 1000)))
      .rejects.toBeInstanceOf(DecryptionError);
  });

  it('promjena lozinke: isti DEK, novi wrap -> podaci ostaju čitljivi', async () => {
    const dek = await generateDataKey();
    const enc = await encryptText('ostaje', dek);
    const salt2 = randomBytes(16);
    const wrappedNew = await wrapDataKey(dek, await deriveKeyFromPassword('nova', salt2, 1000));
    const restored = await unwrapDataKey(wrappedNew, await deriveKeyFromPassword('nova', salt2, 1000));
    expect(await decryptText(enc, restored)).toBe('ostaje');
  });

  it('recovery ključ otključava DEK', async () => {
    const dek = await generateDataKey();
    const raw = randomBytes(32);
    const wrapped = await wrapDataKey(dek, await importRawWrappingKey(raw));
    const restored = await unwrapDataKey(wrapped, await importRawWrappingKey(raw));
    expect(await decryptText(await encryptText('r', dek), restored)).toBe('r');
  });

  it('oštećen wrapped ključ -> DecryptionError', async () => {
    const kek = await deriveKeyFromPassword('x', randomBytes(16), 1000);
    await expect(unwrapDataKey('v1:AAAA', kek)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapDataKey('smeće', kek)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('PBKDF2 broj iteracija je ≥ 600 000', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});

describe('podrška za stari (CryptoJS) format', () => {
  it('dešifruje tekst šifrovan starom verzijom aplikacije', async () => {
    const CryptoJS = (await import('crypto-js')).default;
    const legacyKey = await deriveLegacyKey('Korisnik@Primjer.ba ', 'lozinka123');
    const legacyCipher = CryptoJS.AES.encrypt('Stari naslov čćž', legacyKey).toString();

    expect(isLegacyCiphertext(legacyCipher)).toBe(true);
    setLegacyKey(legacyKey);
    expect(getLegacyKey()).toBe(legacyKey);
    expect(await decryptAnyText(legacyCipher)).toBe('Stari naslov čćž');
  });

  it('nešifrovan tekst prolazi nepromijenjen', async () => {
    expect(await decryptAnyText('običan tekst')).toBe('običan tekst');
  });

  it('pogrešan stari ključ -> DecryptionError', async () => {
    const CryptoJS = (await import('crypto-js')).default;
    const cipher = CryptoJS.AES.encrypt('x', 'ključ-A').toString();
    setLegacyKey('ključ-B');
    await expect(decryptAnyText(cipher)).rejects.toBeInstanceOf(DecryptionError);
  });
});
