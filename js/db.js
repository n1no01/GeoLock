import { supabase, getCurrentUser } from './supabase.js';
import { decryptText, decryptMediaFromUrl } from './crypto.js';

const DB_NAME = 'GeoLockDB';
const DB_VERSION = 2; // Povećan verzijski broj zbog nove tabele deleted_locations
const STORE_NAME = 'locations';
const DELETED_STORE_NAME = 'deleted_locations';

// Inicijalizacija i nadogradnja IndexedDB baze
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Kreiranje glavne tabele za lokacije
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }

      // Kreiranje tabele za praćenje offline obrisanih lokacija
      if (!db.objectStoreNames.contains(DELETED_STORE_NAME)) {
        db.createObjectStore(DELETED_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 1. Dovedi sve lokalne lokacije iz IndexedDB
export async function getLocations() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("Greška pri čitanju iz IndexedDB:", e);
    return [];
  }
}

// 2. Sačuvaj novu lokaciju
export async function saveLocation(location) {
  location.synced = location.synced || false;
  location.id = String(location.id);

  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(location);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    console.error("Greška pri spremanju lokacije u IndexedDB:", e);
  }

  return await getLocations();
}

// 3. Ažuriraj postojeću lokaciju
export async function updateLocation(id, updatedData) {
  try {
    const db = await openDB();
    const locations = await getLocations();
    const existing = locations.find(l => String(l.id) === String(id));

    if (existing) {
      const updated = { 
        ...existing, 
        ...updatedData, 
        id: String(id),
        synced: updatedData.synced !== undefined ? updatedData.synced : false 
      };

      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put(updated);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }
  } catch (e) {
    console.error("Greška pri ažuriranju u IndexedDB:", e);
  }

  return await getLocations();
}

// 4. Obriši lokaciju (lokalno + sync na cloud)
export async function deleteLocationFromDb(id) {
  const stringId = String(id);

  try {
    const db = await openDB();
    
    // Obriši iz glavne tabele i dodaj u tabelu obrisanih
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME, DELETED_STORE_NAME], 'readwrite');
      const locStore = transaction.objectStore(STORE_NAME);
      const delStore = transaction.objectStore(DELETED_STORE_NAME);

      locStore.delete(stringId);
      delStore.put({ id: stringId, timestamp: Date.now() });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    console.error("Greška pri lokalnom brisanju iz IndexedDB:", e);
  }

  // Ako smo online, odmah sinhronizuj brisanje
  if (navigator.onLine) {
    await syncPendingDeletions();
  }

  return await getLocations();
}

// Pomoćna funkcija: Sinhronizacija obrisanih lokacija prema Supabase cloudu
export async function syncPendingDeletions() {
  if (!navigator.onLine) return;

  try {
    const db = await openDB();
    const pendingDeletes = await new Promise((resolve, reject) => {
      const transaction = db.transaction(DELETED_STORE_NAME, 'readonly');
      const store = transaction.objectStore(DELETED_STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    if (pendingDeletes.length === 0) return;

    const user = await getCurrentUser();
    if (!user) return;

    for (const item of pendingDeletes) {
      const { error } = await supabase
        .from('locations')
        .delete()
        .eq('id', item.id)
        .eq('user_id', user.id);

      // Ako je uspješno obrisano sa Supabase-a, ukloni iz lokalne deleted tabele
      if (!error) {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(DELETED_STORE_NAME, 'readwrite');
          const store = transaction.objectStore(DELETED_STORE_NAME);
          store.delete(item.id);

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
    }
  } catch (err) {
    console.error("Greška pri sinhronizaciji obrisanih lokacija:", err);
  }
}

// 5. Sinhronizuj lokacije sa clouda u IndexedDB
export async function mergeLocations(cloudLocations) {
  // Prvo očisti sve obrisane stavke koje su čekale mrežu
  await syncPendingDeletions();

  const db = await openDB();

  // Dovedi trenutnu listu ponovo nakon čišćenja obrisanih
  const localLocations = await getLocations();
  
  // Dovedi pretostale ID-eve koji su još uvijek u deleted_locations (ako neki ne uspije na Supabase-u)
  const pendingDeletes = await new Promise((resolve) => {
    const transaction = db.transaction(DELETED_STORE_NAME, 'readonly');
    const store = transaction.objectStore(DELETED_STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []).map(d => String(d.id)));
    req.onerror = () => resolve([]);
  });

  const map = new Map();

  // Prvo u mapu uvrsti sve ne-sinhronizovane lokalne izmjene
  localLocations.forEach(loc => map.set(String(loc.id), loc));

  for (const cloudLoc of cloudLocations) {
    const locId = String(cloudLoc.id);

    // Ako je stavka u deleted listi, preskoči je!
    if (pendingDeletes.includes(locId)) {
      continue;
    }

    const localItem = map.get(locId);

    // Ako imamo lokalnu izmjenu koja NIJE sinhronizovana, ne prebrisuj je sa clouda
    if (localItem && localItem.synced === false) {
      continue;
    }

    const decLatRaw = decryptText(cloudLoc.lat);
    const decLngRaw = decryptText(cloudLoc.lng);

    let parsedLat = parseFloat(decLatRaw);
    let parsedLng = parseFloat(decLngRaw);

    if (isNaN(parsedLat)) parsedLat = parseFloat(cloudLoc.lat);
    if (isNaN(parsedLng)) parsedLng = parseFloat(cloudLoc.lng);

    // Dekripcija slika
    let decryptedImages = [];
    if (cloudLoc.images_urls && cloudLoc.images_urls.length > 0) {
      try {
        decryptedImages = await Promise.all(
          cloudLoc.images_urls.map(imgUrl => decryptMediaFromUrl(imgUrl))
        );
      } catch (err) {
        console.error("Greška pri dekripciji slika sa clouda:", err);
      }
    }

    // Dekripcija audio zapisa
    let decryptedAudio = null;
    if (cloudLoc.audio_url) {
      try {
        decryptedAudio = await decryptMediaFromUrl(cloudLoc.audio_url);
      } catch (err) {
        console.error("Greška pri dekripciji zvuka sa clouda:", err);
      }
    }

    // Dekripcija priloženih dokumenata (i sadržaja i naziva fajla)
    let decryptedDocs = [];
    if (cloudLoc.documents_data && cloudLoc.documents_data.length > 0) {
      try {
        decryptedDocs = await Promise.all(
          cloudLoc.documents_data.map(async doc => {
            const decData = await decryptMediaFromUrl(doc.data);
            const decName = decryptText(doc.name) || doc.name;
            return { name: decName, data: decData };
          })
        );
      } catch (err) {
        console.error("Greška pri dekripciji dokumenata sa clouda:", err);
      }
    }

    map.set(locId, {
      id: locId,
      lat: isNaN(parsedLat) ? 0 : parsedLat,
      lng: isNaN(parsedLng) ? 0 : parsedLng,
      title: decryptText(cloudLoc.title) || 'Neoznačeno',
      description: decryptText(cloudLoc.description) || '',
      audio: decryptedAudio,
      images: decryptedImages,
      documents: decryptedDocs,
      synced: true,
      timestamp: cloudLoc.timestamp
    });
  }

  const merged = Array.from(map.values());

  // Pouzdano snimanje spojenih unosa u IndexedDB
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      store.clear();
      merged.forEach(item => store.put(item));

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    console.error("Greška pri spremanju spojenih lokacija u IndexedDB:", e);
  }

  return merged;
}