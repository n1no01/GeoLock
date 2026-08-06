import { supabase, getCurrentUser } from './supabase.js';
import { decryptText, decryptMediaFromUrl } from './crypto.js';

const DB_NAME = 'GeoLockDB';
const DB_VERSION = 1;
const STORE_NAME = 'locations';

// Inicijalizacija IndexedDB baze na telefonu
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 1. Dovedi sve lokacije iz IndexedDB
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

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
      const updated = { ...existing, ...updatedData, id: String(id) };
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(updated);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  } catch (e) {
    console.error("Greška pri ažuriranju u IndexedDB:", e);
  }

  return await getLocations();
}

// 4. Obriši lokaciju (lokalno + cloud ako ima mreže)
export async function deleteLocationFromDb(id) {
  const stringId = String(id);

  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(stringId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("Greška pri brisanju iz IndexedDB:", e);
  }

  if (navigator.onLine) {
    try {
      const user = await getCurrentUser();
      if (user) {
        await supabase
          .from('locations')
          .delete()
          .eq('id', stringId)
          .eq('user_id', user.id);
      }
    } catch (err) {
      console.warn("Brisanje sa clouda preskočeno zbog mreže:", err.message);
    }
  }

  return await getLocations();
}

// 5. Sinhronizuj lokacije sa clouda u IndexedDB
export async function mergeLocations(cloudLocations) {
  const localLocations = await getLocations();
  const map = new Map();

  // Prvo postavi sve lokalne neposlate izmjene
  localLocations.forEach(loc => map.set(String(loc.id), loc));

  for (const cloudLoc of cloudLocations) {
    const decLatRaw = decryptText(cloudLoc.lat);
    const decLngRaw = decryptText(cloudLoc.lng);

    let parsedLat = parseFloat(decLatRaw);
    let parsedLng = parseFloat(decLngRaw);

    if (isNaN(parsedLat)) parsedLat = parseFloat(cloudLoc.lat);
    if (isNaN(parsedLng)) parsedLng = parseFloat(cloudLoc.lng);

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

    let decryptedAudio = null;
    if (cloudLoc.audio_url) {
      try {
        decryptedAudio = await decryptMediaFromUrl(cloudLoc.audio_url);
      } catch (err) {
        console.error("Greška pri dekripciji zvuka sa clouda:", err);
      }
    }

    map.set(String(cloudLoc.id), {
      id: String(cloudLoc.id),
      lat: isNaN(parsedLat) ? 0 : parsedLat,
      lng: isNaN(parsedLng) ? 0 : parsedLng,
      title: decryptText(cloudLoc.title) || 'Neoznačeno',
      description: decryptText(cloudLoc.description) || '',
      audio: decryptedAudio,
      images: decryptedImages,
      synced: true,
      timestamp: cloudLoc.timestamp
    });
  }

  const merged = Array.from(map.values());

  // Sačuvaj sve u IndexedDB
  try {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // Očisti stare unose i upiši spojene
    store.clear();
    merged.forEach(item => store.put(item));
  } catch (e) {
    console.error("Greška pri spremanju spojenih lokacija u IndexedDB:", e);
  }

  return merged;
}