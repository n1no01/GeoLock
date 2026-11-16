import { describe, it, expect } from 'vitest';
import {
  bytesToBase64, base64ToBytes, bytesToBase32, base32ToBytes, formatRecoveryKey, parseRecoveryKey,
  csvCell, safeFileName, isValidLatLng, dataUrlToBlob, escapeHtml, isEmail, uuid
} from '../js/utils.js';
import { toMgrs, fromMgrs } from '../js/coords.js';

describe('base64 / base32', () => {
  it('base64 round-trip, uključujući velike nizove', () => {
    // getRandomValues je ograničen na 64 KB po pozivu, pa se niz puni u dijelovima
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i += 65_536) crypto.getRandomValues(big.subarray(i, i + 65_536));
    const back = base64ToBytes(bytesToBase64(big));
    expect(Buffer.compare(Buffer.from(back), Buffer.from(big))).toBe(0);
  });

  it('base32 round-trip', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(base32ToBytes(bytesToBase32(bytes))).toEqual(bytes);
  });

  it('recovery ključ: format sa crticama, tolerantan na mala slova i razmake', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = formatRecoveryKey(bytes);
    expect(key).toMatch(/^([A-Z2-7]{4}-)+[A-Z2-7]{1,4}$/);
    expect(parseRecoveryKey(key.toLowerCase().replaceAll('-', ' '))).toEqual(bytes);
  });

  it('recovery ključ: odbija neispravnu dužinu', () => {
    expect(() => parseRecoveryKey('ABCD-EFGH')).toThrow();
  });
});

describe('csvCell', () => {
  it('udvostručuje navodnike', () => {
    expect(csvCell('on rekao "ćao"')).toBe('"on rekao ""ćao"""');
  });

  it.each(['=1+1', '+cmd', '-2', '@SUM(A1)', '\tx'])('neutralizira formula injection: %s', (value) => {
    expect(csvCell(value).startsWith('"\'')).toBe(true);
  });

  it('obični tekst ostaje nepromijenjen', () => {
    expect(csvCell('Lokacija 1, Sarajevo')).toBe('"Lokacija 1, Sarajevo"');
  });

  it('null/undefined -> prazna ćelija', () => {
    expect(csvCell(null)).toBe('""');
  });
});

describe('safeFileName', () => {
  it('uklanja znakove nedozvoljene u imenima fajlova', () => {
    expect(safeFileName('a/b\\c:d*e?.docx')).toBe('abcde.docx');
  });
  it('sprječava skrivene fajlove i prazna imena', () => {
    expect(safeFileName('...')).toBe('fajl');
    expect(safeFileName('')).toBe('fajl');
  });
});

describe('validacija', () => {
  it('isValidLatLng', () => {
    expect(isValidLatLng(44.5, 18.6)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, 181)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng(null, 0)).toBe(false);
  });
  it('isEmail', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('nije email')).toBe(false);
  });
  it('escapeHtml', () => {
    expect(escapeHtml('<img onerror="x">')).toBe('&lt;img onerror=&quot;x&quot;&gt;');
  });
  it('uuid je jedinstven', () => {
    expect(uuid()).not.toBe(uuid());
  });
});

describe('dataUrlToBlob', () => {
  it('dekodira base64 data URL bez fetch-a', async () => {
    const blob = dataUrlToBlob('data:text/plain;base64,SGVsbG8=');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('Hello');
  });
  it('baca grešku za neispravan ulaz', () => {
    expect(() => dataUrlToBlob('nije data url')).toThrow();
  });
});

describe('MGRS', () => {
  it('Lat/Lng -> MGRS -> Lat/Lng je stabilno (≈1 m)', () => {
    const mgrs = toMgrs(44.538, 18.667);
    expect(mgrs).toMatch(/^34T/);
    const back = fromMgrs(mgrs);
    expect(Math.abs(back.lat - 44.538)).toBeLessThan(0.0002);
    expect(Math.abs(back.lng - 18.667)).toBeLessThan(0.0002);
  });
  it('neispravan unos vraća null umjesto izuzetka', () => {
    expect(fromMgrs('abc')).toBeNull();
    expect(toMgrs(100, 0)).toBeNull();
  });
});
