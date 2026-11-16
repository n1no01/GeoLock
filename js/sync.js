// Sinhronizacija IndexedDB <-> Supabase.
//
// Pravila:
//  - u svakom trenutku radi najviše jedna sinhronizacija (mutex); zahtjev koji stigne tokom rada
//    samo zakazuje jedan dodatni prolaz
//  - mediji se šalju JEDNOM (stabilna putanja uid/lokacija/mediaId.enc) i ne ponavljaju pri izmjenama
//  - obrisani zapisi i uklonjeni mediji se brišu i iz storage-a
//  - nikad se ne prepisuje nesinhronizovana lokalna izmjena
//  - mediji se preuzimaju lijeno / u pozadini i preskaču se oni koje već imamo

import { supabase, getCurrentUser, STORAGE_BUCKET } from './supabase.js';
import {
  getUnsyncedLocations, listMediaForLocation, markMediaUploaded, markLocationSynced,
  getPendingDeletes, clearPendingRows, clearPendingPaths, listSyncState, applyCloudLocation,
  removeLocalOnly, listMissingMedia, setMediaBytes, getMediaRecord
} from './db.js';
import {
  encryptText, encryptJson, decryptJson, decryptAnyText, hasActiveKey, isEncryptedV1,
  decryptLegacyText, encryptBytes, DecryptionError
} from './crypto.js';
import { showToast, setSyncStatus } from './toast.js';
import { uuid, dataUrlToBlob } from './utils.js';

export const DATA_CHANGED_EVENT = 'geolock:data-changed';
const MIN_AUTO_INTERVAL_MS = 30_000;
const PAGE_SIZE = 500;

let inFlight = null;
let rerunRequested = false;
let lastFinishedAt = 0;

// ---------- Pomoćno ----------

const bucket = () => supabase.storage.from(STORAGE_BUCKET);

/** Putanja iz zapisa: nova verzija čuva putanju, stara je čuvala javni URL. */
export function storagePathFromRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (!/^https?:/i.test(ref)) return ref;
  const marker = `/${STORAGE_BUCKET}/`;
  const idx = ref.indexOf(marker);
  if (idx < 0) return null;
  return decodeURIComponent(ref.slice(idx + marker.length).split('?')[0]);
}

const mediaIdFromPath = (path) => path.split('/').pop().replace(/\.enc$/, '');

/** Postgres vraća timestamptz u drugom formatu nego što je poslan, pa se poredi trenutak, ne tekst. */
const sameInstant = (a, b) => {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
};

function notifyDataChanged() {
  window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
}

// ---------- Javni API ----------

/**
 * @param silent  ne prikazuj toast osim za greške
 * @param force   false = preskoči ako je nedavno završena sinhronizacija (za automatske okidače)
 */
export function syncLocationsWithCloud({ silent = false, force = true } = {}) {
  if (inFlight) {
    rerunRequested = true; // izmjena stigla tokom sinhronizacije -> još jedan prolaz
    return inFlight;
  }
  if (!force && Date.now() - lastFinishedAt < MIN_AUTO_INTERVAL_MS) {
    return Promise.resolve({ skipped: true });
  }

  inFlight = (async () => {
    let result;
    try {
      do {
        rerunRequested = false;
        result = await runSync(silent);
      } while (rerunRequested && !result.offline && !result.locked && !result.noUser);
    } finally {
      inFlight = null;
      lastFinishedAt = Date.now();
    }
    return result;
  })();
  return inFlight;
}

async function runSync(silent) {
  if (!navigator.onLine) {
    if (!silent) showToast('Nemate internet konekciju. Lokacije ostaju lokalno.', 'info');
    return { offline: true };
  }
  if (!hasActiveKey()) return { locked: true };

  const user = await getCurrentUser();
  if (!user) {
    setSyncStatus('🔒 Lokalno (prijavite se za cloud)');
    if (!silent) showToast('Za sinhronizaciju se prijavite lozinkom.', 'info');
    return { noUser: true };
  }

  setSyncStatus('⏳ Sinhronizacija…');
  const stats = { uploaded: 0, downloaded: 0, removed: 0, errors: 0, skipped: 0, legacy: 0 };

  try {
    await processPendingRowDeletes(user, stats);
    await uploadUnsynced(user, stats);
    await processPendingStorageDeletes(stats);
    await downloadFromCloud(user, stats);
  } catch (err) {
    console.error('[SYNC] Kritična greška:', err);
    stats.errors++;
  }

  const time = new Date().toLocaleTimeString('bs', { hour: '2-digit', minute: '2-digit' });
  if (stats.errors > 0) {
    setSyncStatus('⚠️ Sinhronizacija nepotpuna');
    showToast('Sinhronizacija je završena uz greške. Pokušaću ponovo kasnije.', 'error');
  } else {
    setSyncStatus(`☁️ Sinhronizovano ${time}`);
    if (stats.skipped > 0) {
      showToast(`${stats.skipped} zapis(a) nije moguće dešifrovati. Za stare zapise prijavite se lozinkom.`, 'info', 5000);
    } else if (!silent) {
      showToast('Sinhronizacija uspješno završena!', 'success');
    }
  }

  if (stats.uploaded || stats.downloaded || stats.removed) notifyDataChanged();

  // Stari zapisi su konvertovani lokalno i čekaju upload u novom formatu
  if (stats.legacy > 0 && stats.errors === 0) rerunRequested = true;

  // Mediji se povlače u pozadini; greške ovdje ne ruše sinhronizaciju
  prefetchMedia().catch((err) => console.warn('[SYNC] Preuzimanje medija:', err));
  return stats;
}

// ---------- Brisanja ----------

async function processPendingRowDeletes(user, stats) {
  const { rowIds } = await getPendingDeletes();
  for (const id of rowIds) {
    const { error } = await supabase.from('locations').delete().eq('id', id).eq('user_id', user.id);
    if (error) {
      console.error('[SYNC] Brisanje reda nije uspjelo:', error);
      stats.errors++;
    } else {
      await clearPendingRows([id]);
    }
  }
}

async function processPendingStorageDeletes(stats) {
  const { paths } = await getPendingDeletes();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await bucket().remove(chunk);
    if (error) {
      console.error('[SYNC] Brisanje fajlova nije uspjelo:', error);
      stats.errors++;
    } else {
      await clearPendingPaths(chunk);
    }
  }
}

// ---------- Upload ----------

async function uploadUnsynced(user, stats) {
  const unsynced = await getUnsyncedLocations();

  for (const loc of unsynced) {
    try {
      const mediaRecords = await listMediaForLocation(loc.id);
      const byId = new Map(mediaRecords.map((m) => [m.id, m]));

      // 1) Samo mediji koji još nisu na cloudu
      for (const m of mediaRecords) {
        if (m.uploaded) continue;
        if (!m.bytes) throw new Error(`Medij ${m.id} nema podataka.`);
        const path = `${user.id}/${loc.id}/${m.id}.enc`;
        const { error } = await bucket().upload(path, new Blob([m.bytes], { type: 'application/octet-stream' }), {
          contentType: 'application/octet-stream',
          upsert: true
        });
        if (error) throw error;
        await markMediaUploaded(m.id, path);
        m.uploaded = true;
        m.path = path;
      }

      const pathOf = (mediaId) => {
        const p = byId.get(mediaId)?.path;
        if (!p) throw new Error(`Nedostaje putanja za medij ${mediaId}`);
        return p;
      };

      // 2) Šifrovani red u bazi
      const payload = {
        id: String(loc.id),
        user_id: user.id,
        title: await encryptText(loc.title || 'Bez naslova'),
        description: await encryptText(loc.description || ''),
        lat: await encryptText(String(loc.lat)),
        lng: await encryptText(String(loc.lng)),
        images_urls: loc.images.map(pathOf),
        audio_url: loc.audio ? pathOf(loc.audio) : null,
        documents_data: await Promise.all(loc.documents.map(async (d) => ({
          name: await encryptText(d.name),
          data: pathOf(d.id)
        }))),
        meta: await encryptJson({
          accuracy: loc.accuracy,
          createdAt: loc.createdAt,
          updatedAt: loc.updatedAt,
          mimes: Object.fromEntries(mediaRecords.map((m) => [m.id, m.mime]))
        }),
        timestamp: loc.updatedAt
      };

      const { error } = await supabase.from('locations').upsert(payload, { onConflict: 'id' });
      if (error) throw error;

      await markLocationSynced(loc.id, loc.updatedAt);
      stats.uploaded++;
    } catch (err) {
      console.error(`[SYNC] Lokacija ${loc.id} nije poslana:`, err);
      stats.errors++;
    }
  }
}

// ---------- Download ----------

async function fetchAllRows(userId) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function downloadFromCloud(user, stats) {
  const rows = await fetchAllRows(user.id); // greška -> ništa se lokalno ne briše
  const { rowIds } = await getPendingDeletes();
  const pendingRows = new Set(rowIds);
  const localState = new Map((await listSyncState()).map((s) => [s.id, s]));
  const cloudIds = new Set(rows.map((r) => String(r.id)));

  for (const row of rows) {
    const id = String(row.id);
    if (pendingRows.has(id)) continue;

    const local = localState.get(id);
    if (local && !local.synced) continue; // lokalna izmjena ima prednost dok se ne pošalje
    if (local && sameInstant(local.updatedAt, row.timestamp) && isEncryptedV1(row.lat)) continue; // nepromijenjeno

    try {
      const parsed = await parseCloudRow(row, user);
      const applied = await applyCloudLocation(parsed.location, parsed.media, {
        synced: !parsed.legacyPaths,
        legacyPaths: parsed.legacyPaths
      });
      if (applied) {
        stats.downloaded++;
        if (parsed.legacyPaths) stats.legacy++;
      }
    } catch (err) {
      if (err instanceof DecryptionError) {
        stats.skipped++;
      } else {
        console.error(`[SYNC] Zapis ${id} nije obrađen:`, err);
        stats.errors++;
      }
    }
  }

  // Propagacija brisanja sa drugih uređaja: sinhronizovan lokalni zapis kojeg više nema na cloudu je obrisan.
  // (Greška pri dohvatu je već prekinula funkciju iznad, pa se ovdje nikad ne brišu podaci zbog mrežnog problema.)
  for (const [id, state] of localState) {
    if (state.synced && !cloudIds.has(id) && !pendingRows.has(id)) {
      await removeLocalOnly(id);
      stats.removed++;
    }
  }
}

async function parseCloudRow(row, user) {
  const id = String(row.id);
  const isNewFormat = isEncryptedV1(row.lat);

  const [title, description, latRaw, lngRaw] = await Promise.all(
    ['title', 'description', 'lat', 'lng'].map((k) => decryptAnyText(row[k]))
  );
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new DecryptionError();

  const meta = row.meta ? await decryptJson(row.meta) : {};
  const location = {
    id,
    title: title || 'Neoznačeno',
    description: description || '',
    lat,
    lng,
    accuracy: meta.accuracy ?? null,
    createdAt: meta.createdAt || row.timestamp,
    updatedAt: meta.updatedAt || row.timestamp,
    images: [],
    audio: null,
    documents: []
  };
  const docs = Array.isArray(row.documents_data) ? row.documents_data : [];

  // --- Novi format: samo "stubovi", bajtovi se preuzimaju kasnije ---
  if (isNewFormat) {
    const mimes = meta.mimes || {};
    const media = [];
    const stub = (path) => {
      const mediaId = mediaIdFromPath(path);
      media.push({
        id: mediaId, locationId: id, mime: mimes[mediaId] || 'application/octet-stream',
        bytes: null, uploaded: true, path
      });
      return mediaId;
    };
    for (const ref of row.images_urls ?? []) {
      const p = storagePathFromRef(ref);
      if (p) location.images.push(stub(p));
    }
    const audioPath = storagePathFromRef(row.audio_url);
    if (audioPath) location.audio = stub(audioPath);
    for (const d of docs) {
      const p = storagePathFromRef(d.data);
      if (p) location.documents.push({ id: stub(p), name: await decryptAnyText(d.name) || 'dokument' });
    }
    return { location, media, legacyPaths: null };
  }

  // --- Stari format: preuzmi, dešifruj CryptoJS-om, ponovo šifruj novim formatom ---
  const media = [];
  const legacyPaths = [];
  const convert = async (ref) => {
    const path = storagePathFromRef(ref);
    if (!path) return null;
    const { data, error } = await bucket().download(path);
    if (error) throw error;
    const text = await data.text();
    const plain = text.startsWith('U2FsdGVkX1') ? await decryptLegacyText(text) : text;
    const blob = plain.startsWith('data:') ? dataUrlToBlob(plain) : null;
    if (!blob) throw new DecryptionError('Neprepoznat stari format medija.');
    const mediaId = uuid();
    media.push({
      id: mediaId, locationId: id, mime: blob.type,
      bytes: await encryptBytes(new Uint8Array(await blob.arrayBuffer())),
      uploaded: false, path: null
    });
    legacyPaths.push(path);
    return mediaId;
  };
  for (const ref of row.images_urls ?? []) {
    const mid = await convert(ref);
    if (mid) location.images.push(mid);
  }
  if (row.audio_url) location.audio = await convert(row.audio_url);
  for (const d of docs) {
    const mid = await convert(d.data);
    if (mid) location.documents.push({ id: mid, name: await decryptAnyText(d.name) || 'dokument' });
  }
  void user;
  return { location, media, legacyPaths };
}

// ---------- Mediji ----------

/** Preuzmi jedan medij (lijeno, kad ga korisnik otvori). */
export async function ensureMediaDownloaded(mediaId) {
  const rec = await getMediaRecord(mediaId);
  if (!rec) throw new Error('Medij ne postoji.');
  if (rec.bytes) return;
  if (!navigator.onLine) throw new Error('Medij još nije preuzet — potrebna je internet konekcija.');
  if (!rec.path) throw new Error('Medij nema putanju na cloudu.');

  const { data, error } = await bucket().download(rec.path);
  if (error) throw error;
  await setMediaBytes(mediaId, new Uint8Array(await data.arrayBuffer()));
}

async function prefetchMedia() {
  if (!navigator.onLine || navigator.connection?.saveData) return;
  const missing = await listMissingMedia();
  if (missing.length === 0) return;

  const queue = [...missing];
  const worker = async () => {
    while (queue.length > 0) {
      const rec = queue.shift();
      try {
        await ensureMediaDownloaded(rec.id);
      } catch (err) {
        console.warn(`[SYNC] Medij ${rec.id} nije preuzet:`, err);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  notifyDataChanged();
}

// ---------- Brisanje svih cloud podataka (samo za "počni iznova") ----------

export async function wipeCloudData(userId) {
  const { error } = await supabase.from('locations').delete().eq('user_id', userId);
  if (error) throw new Error(`Brisanje zapisa nije uspjelo: ${error.message}`);

  // Storage nema "obriši folder": rekurzivno izlistaj (stara verzija je koristila userId/lokacija/tip/fajl)
  const collect = async (prefix) => {
    const { data, error: listError } = await bucket().list(prefix, { limit: 1000 });
    if (listError) throw listError;
    const files = [];
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`;
      if (item.id === null) files.push(...await collect(path)); // folder
      else files.push(path);
    }
    return files;
  };

  const paths = await collect(userId);
  for (let i = 0; i < paths.length; i += 100) {
    const { error: rmError } = await bucket().remove(paths.slice(i, i + 100));
    if (rmError) throw rmError;
  }
}
