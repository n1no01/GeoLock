// Lokalna baza (IndexedDB), šifrovana u mirovanju.
//
// Stores:
//   locations          { id, synced, createdAt, updatedAt, meta, legacyPaths? }
//                      meta = šifrovani JSON {title, description, lat, lng, accuracy, images[], audio, documents[]}
//   media              { id, locationId, mime, bytes|null, missing(0|1), uploaded, path }
//                      bytes = IV||ciphertext (AES-GCM). null = još nije preuzeto sa clouda.
//   deleted_locations  { id, timestamp }    brisanja koja čekaju cloud
//   deleted_media      { id=storagePath }   fajlovi u storage-u koje treba obrisati
//
// Sve što je osjetljivo (naslov, opis, koordinate, mediji) je šifrovano DEK-om; dok je aplikacija
// zaključana, getLocations() vraća prazan niz.

import {
  encryptJson, decryptJson, encryptBytes, decryptBytes, hasActiveKey
} from './crypto.js';
import { dataUrlToBlob } from './utils.js';

const DB_NAME = 'GeoLockDB';
const DB_VERSION = 3;
const S_LOC = 'locations';
const S_MEDIA = 'media';
const S_DEL_LOC = 'deleted_locations';
const S_DEL_MEDIA = 'deleted_media';

let dbPromise = null;

const reqP = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const txP = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transakcija prekinuta.'));
});

/** Jedna keširana konekcija umjesto nove pri svakom pozivu. */
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(S_LOC)) db.createObjectStore(S_LOC, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(S_DEL_LOC)) db.createObjectStore(S_DEL_LOC, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(S_DEL_MEDIA)) db.createObjectStore(S_DEL_MEDIA, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(S_MEDIA)) {
          const media = db.createObjectStore(S_MEDIA, { keyPath: 'id' });
          media.createIndex('locationId', 'locationId');
          media.createIndex('missing', 'missing');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = null; reject(request.error); };
    });
  }
  return dbPromise;
}

/** Samo za testove / odjavu. */
export async function closeDB() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

// ---------- Pretvaranje zapisa <-> objekat lokacije ----------

function metaOf(location) {
  return {
    title: location.title ?? '',
    description: location.description ?? '',
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy ?? null,
    images: location.images ?? [],
    audio: location.audio ?? null,
    documents: location.documents ?? []
  };
}

async function toPublic(rec) {
  try {
    const meta = await decryptJson(rec.meta);
    return {
      id: rec.id,
      synced: !!rec.synced,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      title: meta.title,
      description: meta.description,
      lat: meta.lat,
      lng: meta.lng,
      accuracy: meta.accuracy ?? null,
      images: meta.images ?? [],
      audio: meta.audio ?? null,
      documents: meta.documents ?? []
    };
  } catch {
    return {
      id: rec.id, synced: !!rec.synced, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      title: '🔒 Nije moguće dešifrovati', description: 'Zapis je šifrovan drugim ključem.',
      lat: null, lng: null, accuracy: null, images: [], audio: null, documents: [],
      undecryptable: true
    };
  }
}

async function encryptMedia(item) {
  const plain = new Uint8Array(await item.blob.arrayBuffer());
  return {
    id: item.id,
    locationId: item.locationId,
    mime: item.mime || item.blob.type || 'application/octet-stream',
    bytes: await encryptBytes(plain),
    missing: 0,
    uploaded: false,
    path: null
  };
}

// ---------- Čitanje ----------

export async function getLocations() {
  if (!hasActiveKey()) return [];
  const db = await openDB();
  const records = await reqP(db.transaction(S_LOC).objectStore(S_LOC).getAll());
  const visible = records.filter((r) => r.meta); // zapisi bez meta čekaju migraciju
  return Promise.all(visible.map(toPublic));
}

export async function getLocation(id) {
  if (!hasActiveKey()) return null;
  const db = await openDB();
  const rec = await reqP(db.transaction(S_LOC).objectStore(S_LOC).get(String(id)));
  return rec && rec.meta ? toPublic(rec) : null;
}

export async function getRawLocation(id) {
  const db = await openDB();
  return reqP(db.transaction(S_LOC).objectStore(S_LOC).get(String(id)));
}

/** Brojač bez dešifrovanja i bez učitavanja medija. */
export async function countLocations() {
  const db = await openDB();
  return reqP(db.transaction(S_LOC).objectStore(S_LOC).count());
}

export async function getUnsyncedLocations() {
  if (!hasActiveKey()) return [];
  const db = await openDB();
  const records = await reqP(db.transaction(S_LOC).objectStore(S_LOC).getAll());
  const pending = records.filter((r) => r.meta && !r.synced);
  const items = await Promise.all(pending.map(toPublic));
  return items.filter((l) => !l.undecryptable);
}

export async function listSyncState() {
  const db = await openDB();
  const records = await reqP(db.transaction(S_LOC).objectStore(S_LOC).getAll());
  return records.map((r) => ({ id: r.id, synced: !!r.synced, updatedAt: r.updatedAt }));
}

// ---------- Pisanje ----------

/**
 * Atomarno snima lokaciju i njene medije.
 * @param location  {id,title,description,lat,lng,accuracy,createdAt,updatedAt,images,audio,documents}
 * @param addMedia  [{id, locationId, mime, blob}]  novi mediji (šifruju se prije transakcije)
 * @param removeMediaIds  ID-evi medija koje treba ukloniti
 * Baca grešku (npr. QuotaExceededError) — pozivalac MORA prikazati korisniku.
 */
export async function putLocation(location, { addMedia = [], removeMediaIds = [] } = {}) {
  const id = String(location.id);
  const encryptedMedia = await Promise.all(addMedia.map(encryptMedia));
  const meta = await encryptJson(metaOf(location));

  const db = await openDB();
  const tx = db.transaction([S_LOC, S_MEDIA, S_DEL_MEDIA], 'readwrite');
  const done = txP(tx);
  const locStore = tx.objectStore(S_LOC);
  const mediaStore = tx.objectStore(S_MEDIA);
  const delMedia = tx.objectStore(S_DEL_MEDIA);

  const existing = await reqP(locStore.get(id));

  for (const mediaId of removeMediaIds) {
    const rec = await reqP(mediaStore.get(mediaId));
    if (rec?.uploaded && rec.path) delMedia.put({ id: rec.path, timestamp: Date.now() });
    mediaStore.delete(mediaId);
  }
  for (const rec of encryptedMedia) mediaStore.put(rec);

  const record = {
    id,
    synced: false,
    createdAt: location.createdAt || existing?.createdAt || new Date().toISOString(),
    updatedAt: location.updatedAt || new Date().toISOString(),
    meta
  };
  const legacyPaths = location.legacyPaths || existing?.legacyPaths;
  if (legacyPaths?.length) record.legacyPaths = legacyPaths;
  locStore.put(record);

  await done;
  return id;
}

/** Briše lokaciju lokalno i stavlja je u red za brisanje sa clouda. */
export async function deleteLocation(id) {
  const key = String(id);
  const db = await openDB();
  const tx = db.transaction([S_LOC, S_MEDIA, S_DEL_LOC, S_DEL_MEDIA], 'readwrite');
  const done = txP(tx);

  const rec = await reqP(tx.objectStore(S_LOC).get(key));
  const media = await reqP(tx.objectStore(S_MEDIA).index('locationId').getAll(key));
  for (const m of media) {
    if (m.uploaded && m.path) tx.objectStore(S_DEL_MEDIA).put({ id: m.path, timestamp: Date.now() });
    tx.objectStore(S_MEDIA).delete(m.id);
  }
  for (const p of rec?.legacyPaths ?? []) tx.objectStore(S_DEL_MEDIA).put({ id: p, timestamp: Date.now() });
  tx.objectStore(S_LOC).delete(key);
  tx.objectStore(S_DEL_LOC).put({ id: key, timestamp: Date.now() });

  await done;
}

/** Briše lokalno bez slanja brisanja na cloud (cloud je već obrisan). */
export async function removeLocalOnly(id) {
  const key = String(id);
  const db = await openDB();
  const tx = db.transaction([S_LOC, S_MEDIA], 'readwrite');
  const done = txP(tx);
  const media = await reqP(tx.objectStore(S_MEDIA).index('locationId').getAll(key));
  for (const m of media) tx.objectStore(S_MEDIA).delete(m.id);
  tx.objectStore(S_LOC).delete(key);
  await done;
}

// ---------- Mediji ----------

export async function getMediaRecord(id) {
  const db = await openDB();
  return reqP(db.transaction(S_MEDIA).objectStore(S_MEDIA).get(id));
}

export async function listMediaForLocation(locationId) {
  const db = await openDB();
  return reqP(db.transaction(S_MEDIA).objectStore(S_MEDIA).index('locationId').getAll(String(locationId)));
}

/** Dešifrovani Blob, ili null ako medij još nije preuzet. */
export async function getMediaBlob(id) {
  const rec = await getMediaRecord(id);
  if (!rec || !rec.bytes) return null;
  const plain = await decryptBytes(rec.bytes);
  return new Blob([plain], { type: rec.mime });
}

/** Spremi (već šifrovane) bajtove za medij koji je bio samo "stub". */
export async function setMediaBytes(id, encryptedBytes) {
  const db = await openDB();
  const tx = db.transaction(S_MEDIA, 'readwrite');
  const done = txP(tx);
  const store = tx.objectStore(S_MEDIA);
  const rec = await reqP(store.get(id));
  if (rec) store.put({ ...rec, bytes: encryptedBytes, missing: 0 });
  await done;
}

export async function markMediaUploaded(id, path) {
  const db = await openDB();
  const tx = db.transaction(S_MEDIA, 'readwrite');
  const done = txP(tx);
  const store = tx.objectStore(S_MEDIA);
  const rec = await reqP(store.get(id));
  if (rec) store.put({ ...rec, uploaded: true, path });
  await done;
}

/** Zapisi medija bez bajtova (nisu još preuzeti sa clouda). */
export async function listMissingMedia() {
  const db = await openDB();
  return reqP(db.transaction(S_MEDIA).objectStore(S_MEDIA).index('missing').getAll(IDBKeyRange.only(1)));
}

// ---------- Podrška za sinhronizaciju ----------

/**
 * Označi kao sinhronizovano SAMO ako se lokacija nije mijenjala tokom slanja
 * (inače bi izmjena korisnika bila tiho označena kao poslana).
 */
export async function markLocationSynced(id, expectedUpdatedAt) {
  const db = await openDB();
  const tx = db.transaction([S_LOC, S_DEL_MEDIA], 'readwrite');
  const done = txP(tx);
  const store = tx.objectStore(S_LOC);
  const rec = await reqP(store.get(String(id)));
  let ok = false;
  if (rec && rec.updatedAt === expectedUpdatedAt) {
    for (const p of rec.legacyPaths ?? []) tx.objectStore(S_DEL_MEDIA).put({ id: p, timestamp: Date.now() });
    const next = { ...rec, synced: true };
    delete next.legacyPaths;
    store.put(next);
    ok = true;
  }
  await done;
  return ok;
}

/**
 * Primjena zapisa sa clouda. Nikad ne prepisuje nesinhronizovanu lokalnu izmjenu
 * i ne vraća lokaciju čije je brisanje na čekanju.
 * @param media  [{id, locationId, mime, bytes|null, uploaded, path}]
 */
export async function applyCloudLocation(location, media, { synced = true, legacyPaths = null } = {}) {
  const id = String(location.id);
  const meta = await encryptJson(metaOf(location));

  const db = await openDB();
  const tx = db.transaction([S_LOC, S_MEDIA, S_DEL_LOC], 'readwrite');
  const done = txP(tx);
  const locStore = tx.objectStore(S_LOC);
  const mediaStore = tx.objectStore(S_MEDIA);

  const [existing, pendingDelete] = await Promise.all([
    reqP(locStore.get(id)),
    reqP(tx.objectStore(S_DEL_LOC).get(id))
  ]);

  if ((existing && existing.synced === false) || pendingDelete) {
    tx.abort();
    await done.catch(() => {});
    return false;
  }

  const oldMedia = await reqP(mediaStore.index('locationId').getAll(id));
  const keepIds = new Set(media.map((m) => m.id));
  for (const m of oldMedia) if (!keepIds.has(m.id)) mediaStore.delete(m.id);

  for (const m of media) {
    const old = oldMedia.find((o) => o.id === m.id);
    const bytes = m.bytes ?? old?.bytes ?? null;
    mediaStore.put({ ...m, bytes, missing: bytes ? 0 : 1 });
  }

  const record = {
    id,
    synced,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
    meta
  };
  if (legacyPaths?.length) record.legacyPaths = legacyPaths;
  locStore.put(record);

  await done;
  return true;
}

// ---------- Red čekanja za brisanje ----------

export async function getPendingDeletes() {
  const db = await openDB();
  const tx = db.transaction([S_DEL_LOC, S_DEL_MEDIA]);
  const [rows, paths] = await Promise.all([
    reqP(tx.objectStore(S_DEL_LOC).getAll()),
    reqP(tx.objectStore(S_DEL_MEDIA).getAll())
  ]);
  return { rowIds: rows.map((r) => r.id), paths: paths.map((p) => p.id) };
}

export async function clearPendingRows(ids) {
  const db = await openDB();
  const tx = db.transaction(S_DEL_LOC, 'readwrite');
  const done = txP(tx);
  ids.forEach((id) => tx.objectStore(S_DEL_LOC).delete(id));
  await done;
}

export async function clearPendingPaths(paths) {
  const db = await openDB();
  const tx = db.transaction(S_DEL_MEDIA, 'readwrite');
  const done = txP(tx);
  paths.forEach((p) => tx.objectStore(S_DEL_MEDIA).delete(p));
  await done;
}

// ---------- Brisanje svega (odjava / drugi korisnik) ----------

export async function wipeDatabase() {
  const db = await openDB();
  const names = [S_LOC, S_MEDIA, S_DEL_LOC, S_DEL_MEDIA];
  const tx = db.transaction(names, 'readwrite');
  const done = txP(tx);
  names.forEach((n) => tx.objectStore(n).clear());
  await done;
}

export async function hasAnyLocalData() {
  return (await countLocations()) > 0;
}

// ---------- Migracija zapisa iz stare verzije (v2) ----------

/**
 * Stari zapisi su imali naslov/koordinate u plain tekstu i medije kao base64 unutar zapisa.
 *  - nesinhronizovani: pretvaraju se u novi šifrovani format (inače bi se izgubili)
 *  - sinhronizovani: brišu se lokalno; cloud ih ima i sinhronizacija ih ponovo preuzima
 * Poziva se nakon otključavanja. Vraća broj migriranih zapisa.
 */
export async function migrateLegacyLocal() {
  if (!hasActiveKey()) return 0;
  const db = await openDB();
  const records = await reqP(db.transaction(S_LOC).objectStore(S_LOC).getAll());
  const legacy = records.filter((r) => !r.meta);
  if (legacy.length === 0) return 0;

  let migrated = 0;
  for (const old of legacy) {
    if (old.synced) {
      await removeLocalOnly(old.id);
      continue;
    }

    const id = String(old.id);
    const addMedia = [];
    const images = [];
    for (const dataUrl of old.images ?? []) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
      const blob = dataUrlToBlob(dataUrl);
      const mid = crypto.randomUUID();
      addMedia.push({ id: mid, locationId: id, mime: blob.type, blob });
      images.push(mid);
    }
    let audio = null;
    if (typeof old.audio === 'string' && old.audio.startsWith('data:')) {
      const blob = dataUrlToBlob(old.audio);
      audio = crypto.randomUUID();
      addMedia.push({ id: audio, locationId: id, mime: blob.type, blob });
    }
    const documents = [];
    for (const doc of old.documents ?? []) {
      if (typeof doc?.data !== 'string' || !doc.data.startsWith('data:')) continue;
      const blob = dataUrlToBlob(doc.data);
      const mid = crypto.randomUUID();
      addMedia.push({ id: mid, locationId: id, mime: blob.type, blob });
      documents.push({ id: mid, name: doc.name || 'dokument' });
    }

    const ts = old.timestamp || new Date().toISOString();
    await putLocation({
      id,
      title: old.title || 'Bez naslova',
      description: old.description || '',
      lat: Number(old.lat),
      lng: Number(old.lng),
      accuracy: null,
      createdAt: ts,
      updatedAt: ts,
      images,
      audio,
      documents
    }, { addMedia });
    migrated++;
  }
  return migrated;
}
