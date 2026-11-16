import { describe, it, expect, beforeEach } from 'vitest';
import {
  putLocation, getLocation, getLocations, deleteLocation, getRawLocation, countLocations,
  getUnsyncedLocations, markLocationSynced, applyCloudLocation, getPendingDeletes, listMediaForLocation,
  getMediaBlob, markMediaUploaded, wipeDatabase, migrateLegacyLocal, getMediaRecord
} from '../js/db.js';
import { generateDataKey, setActiveKey, clearKeys } from '../js/crypto.js';

const blobOf = (text, type = 'image/jpeg') => new Blob([text], { type });

const baseLocation = (over = {}) => ({
  id: 'loc-1', title: 'Tajni naslov', description: 'Tajni opis', lat: 44.5, lng: 18.6, accuracy: 7,
  createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z',
  images: [], audio: null, documents: [], ...over
});

beforeEach(async () => {
  setActiveKey(await generateDataKey());
  await wipeDatabase();
});

describe('šifrovanje u mirovanju', () => {
  it('naslov, opis i koordinate se NE nalaze u sirovom zapisu', async () => {
    await putLocation(baseLocation());
    const raw = await getRawLocation('loc-1');
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain('Tajni naslov');
    expect(dump).not.toContain('Tajni opis');
    expect(dump).not.toContain('44.5');
    expect(raw.meta.startsWith('v1:')).toBe(true);
  });

  it('sirovi bajtovi medija ne sadrže originalni sadržaj', async () => {
    await putLocation(baseLocation({ images: ['m1'] }), {
      addMedia: [{ id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('PRAVI-SADRZAJ-SLIKE') }]
    });
    const raw = await getMediaRecord('m1');
    expect(new TextDecoder().decode(raw.bytes)).not.toContain('PRAVI-SADRZAJ-SLIKE');
    expect(await (await getMediaBlob('m1')).text()).toBe('PRAVI-SADRZAJ-SLIKE');
  });

  it('zaključano (bez ključa): ništa se ne vraća', async () => {
    await putLocation(baseLocation());
    clearKeys();
    expect(await getLocations()).toEqual([]);
    expect(await getLocation('loc-1')).toBeNull();
    expect(await countLocations()).toBe(1); // brojač ne zahtijeva ključ
  });

  it('drugi ključ: zapis se označava kao nedešifrovan, bez otkrivanja podataka', async () => {
    await putLocation(baseLocation());
    setActiveKey(await generateDataKey());
    const [loc] = await getLocations();
    expect(loc.undecryptable).toBe(true);
    expect(loc.lat).toBeNull();
    expect(loc.title).not.toContain('Tajni');
  });
});

describe('REGRESIJA: izmjena lokacije ne smije brisati priloge', () => {
  it('zadržava postojeće slike i dokumente kad se doda nova slika', async () => {
    await putLocation(baseLocation({ images: ['m1'], documents: [{ id: 'd1', name: 'izvjestaj.pdf' }] }), {
      addMedia: [
        { id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('slika-1') },
        { id: 'd1', locationId: 'loc-1', mime: 'application/pdf', blob: blobOf('pdf', 'application/pdf') }
      ]
    });

    const before = await getLocation('loc-1');
    await putLocation({
      ...before, title: 'Izmijenjeno', updatedAt: '2026-01-02T10:00:00.000Z',
      images: [...before.images, 'm2']
    }, { addMedia: [{ id: 'm2', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('slika-2') }] });

    const after = await getLocation('loc-1');
    expect(after.title).toBe('Izmijenjeno');
    expect(after.images).toEqual(['m1', 'm2']);
    expect(after.documents).toEqual([{ id: 'd1', name: 'izvjestaj.pdf' }]);
    expect(after.createdAt).toBe('2026-01-01T10:00:00.000Z'); // vrijeme prvobitnog zapisa se čuva
    expect(await (await getMediaBlob('m1')).text()).toBe('slika-1');
    expect(await (await getMediaBlob('m2')).text()).toBe('slika-2');
  });

  it('uklanjanje slike briše medij i stavlja uploadovani fajl u red za brisanje iz storage-a', async () => {
    await putLocation(baseLocation({ images: ['m1'] }), {
      addMedia: [{ id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('x') }]
    });
    await markMediaUploaded('m1', 'user/loc-1/m1.enc');

    const loc = await getLocation('loc-1');
    await putLocation({ ...loc, images: [], updatedAt: '2026-01-02T00:00:00.000Z' }, { removeMediaIds: ['m1'] });

    expect(await getMediaRecord('m1')).toBeUndefined();
    expect((await getPendingDeletes()).paths).toEqual(['user/loc-1/m1.enc']);
  });

  it('izmjena označava lokaciju kao nesinhronizovanu', async () => {
    await putLocation(baseLocation());
    await markLocationSynced('loc-1', '2026-01-01T10:00:00.000Z');
    expect((await getUnsyncedLocations()).length).toBe(0);

    await putLocation(baseLocation({ title: 'novo', updatedAt: '2026-01-03T00:00:00.000Z' }));
    expect((await getUnsyncedLocations()).map((l) => l.id)).toEqual(['loc-1']);
  });
});

describe('sinhronizacija: sigurnosni uslovi', () => {
  it('markLocationSynced ne označava lokaciju izmijenjenu tokom slanja', async () => {
    await putLocation(baseLocation());
    // korisnik izmijeni lokaciju DOK traje upload starog stanja
    await putLocation(baseLocation({ title: 'izmjena tokom slanja', updatedAt: '2026-01-05T00:00:00.000Z' }));

    const ok = await markLocationSynced('loc-1', '2026-01-01T10:00:00.000Z'); // vrijeme koje je poslano
    expect(ok).toBe(false);
    expect((await getUnsyncedLocations()).length).toBe(1);
  });

  it('applyCloudLocation NE prepisuje nesinhronizovanu lokalnu izmjenu', async () => {
    await putLocation(baseLocation({ title: 'moja lokalna izmjena' }));
    const applied = await applyCloudLocation(baseLocation({ title: 'cloud verzija' }), []);
    expect(applied).toBe(false);
    expect((await getLocation('loc-1')).title).toBe('moja lokalna izmjena');
  });

  it('applyCloudLocation ne vraća lokaciju čije je brisanje na čekanju', async () => {
    await putLocation(baseLocation());
    await markLocationSynced('loc-1', '2026-01-01T10:00:00.000Z');
    await deleteLocation('loc-1');

    const applied = await applyCloudLocation(baseLocation(), []);
    expect(applied).toBe(false);
    expect(await getLocation('loc-1')).toBeNull();
  });

  it('applyCloudLocation primjenjuje sinhronizovan zapis i čuva već preuzete bajtove medija', async () => {
    await putLocation(baseLocation({ images: ['m1'] }), {
      addMedia: [{ id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('lokalni-bajtovi') }]
    });
    await markMediaUploaded('m1', 'u/loc-1/m1.enc');
    await markLocationSynced('loc-1', '2026-01-01T10:00:00.000Z');

    const applied = await applyCloudLocation(
      baseLocation({ title: 'sa clouda', images: ['m1'], updatedAt: '2026-02-01T00:00:00.000Z' }),
      [{ id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', bytes: null, uploaded: true, path: 'u/loc-1/m1.enc' }]
    );
    expect(applied).toBe(true);
    expect((await getLocation('loc-1')).title).toBe('sa clouda');
    expect(await (await getMediaBlob('m1')).text()).toBe('lokalni-bajtovi'); // nije ponovo preuzimano
  });

  it('stub medija (bez bajtova) se bilježi kao "missing"', async () => {
    await applyCloudLocation(baseLocation({ images: ['m9'] }),
      [{ id: 'm9', locationId: 'loc-1', mime: 'image/jpeg', bytes: null, uploaded: true, path: 'p' }]);
    const rec = await getMediaRecord('m9');
    expect(rec.missing).toBe(1);
    expect(await getMediaBlob('m9')).toBeNull();
  });
});

describe('brisanje', () => {
  it('briše lokaciju i medije, stavlja red i fajlove u red za cloud', async () => {
    await putLocation(baseLocation({ images: ['m1'] }), {
      addMedia: [{ id: 'm1', locationId: 'loc-1', mime: 'image/jpeg', blob: blobOf('x') }]
    });
    await markMediaUploaded('m1', 'u/loc-1/m1.enc');
    await deleteLocation('loc-1');

    expect(await getLocation('loc-1')).toBeNull();
    expect(await listMediaForLocation('loc-1')).toEqual([]);
    const pending = await getPendingDeletes();
    expect(pending.rowIds).toEqual(['loc-1']);
    expect(pending.paths).toEqual(['u/loc-1/m1.enc']);
  });
});

describe('migracija zapisa iz stare verzije', () => {
  const putRawLegacy = (record) => new Promise((resolve, reject) => {
    const open = indexedDB.open('GeoLockDB');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('locations', 'readwrite');
      tx.objectStore('locations').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });

  it('nesinhronizovani stari zapis (plain tekst + base64 slike) postaje šifrovan i ne gubi se', async () => {
    await putLocation(baseLocation({ id: 'init' })); // osigurava da je baza kreirana
    await wipeDatabase();
    await putRawLegacy({
      id: '1700000000000', title: 'Stari zapis', description: 'opis', lat: 43.8, lng: 18.4,
      timestamp: '2025-05-05T10:00:00.000Z', synced: false,
      images: ['data:image/jpeg;base64,SGVsbG8='],
      audio: null,
      documents: [{ name: 'stari.pdf', data: 'data:application/pdf;base64,SGVsbG8=' }]
    });

    expect(await migrateLegacyLocal()).toBe(1);

    const loc = await getLocation('1700000000000');
    expect(loc.title).toBe('Stari zapis');
    expect(loc.lat).toBe(43.8);
    expect(loc.images.length).toBe(1);
    expect(loc.documents[0].name).toBe('stari.pdf');
    expect(await (await getMediaBlob(loc.images[0])).text()).toBe('Hello');

    const raw = await getRawLocation('1700000000000');
    expect(JSON.stringify(raw)).not.toContain('Stari zapis'); // sad je šifrovano
    expect(raw.synced).toBe(false); // i dalje čeka upload
  });

  it('već sinhronizovani stari zapis se briše lokalno (cloud ga ponovo preuzima)', async () => {
    await putLocation(baseLocation({ id: 'init' }));
    await wipeDatabase();
    await putRawLegacy({ id: '55', title: 'x', lat: 1, lng: 1, timestamp: '2025-01-01T00:00:00Z', synced: true, images: [] });

    await migrateLegacyLocal();
    expect(await countLocations()).toBe(0);
    expect((await getPendingDeletes()).rowIds).toEqual([]); // NE šalje brisanje na cloud
  });
});
