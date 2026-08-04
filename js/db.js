import { supabase, getCurrentUser } from './supabase.js';
import { decryptText, decryptMediaFromUrl } from './crypto.js';

const DB_KEY = 'saved_locations';

export function getLocations() {
  return JSON.parse(localStorage.getItem(DB_KEY) || '[]');
}

export function saveLocation(location) {
  const locations = getLocations();
  location.synced = location.synced || false; 
  locations.push(location);
  localStorage.setItem(DB_KEY, JSON.stringify(locations));
  return locations;
}

export function updateLocation(id, updatedData) {
  let locations = getLocations();
  const index = locations.findIndex(l => String(l.id) === String(id));
  if (index !== -1) {
    locations[index] = { ...locations[index], ...updatedData };
    localStorage.setItem(DB_KEY, JSON.stringify(locations));
  }
  return locations;
}

export async function deleteLocationFromDb(id) {
  let locations = getLocations();
  locations = locations.filter(l => String(l.id) !== String(id));
  localStorage.setItem(DB_KEY, JSON.stringify(locations));

  if (navigator.onLine) {
    try {
      const user = await getCurrentUser();
      if (user) {
        const { error } = await supabase
          .from('locations')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);

        if (error) {
          console.error("Greška pri brisanju sa Supabase clouda:", error);
        } else {
          console.log(`Lokacija ${id} uspješno uklonjena iz Supabase baze.`);
        }
      }
    } catch (err) {
      console.error("Greška pri komunikaciji sa bazom tokom brisanja:", err);
    }
  }

  return locations;
}

export async function mergeLocations(cloudLocations) {
  const localLocations = getLocations();
  const map = new Map();

  localLocations.forEach(loc => map.set(String(loc.id), loc));

  for (const cloudLoc of cloudLocations) {
    // 🔓 Dekripcija koordinata
    const decryptedLat = parseFloat(decryptText(cloudLoc.lat));
    const decryptedLng = parseFloat(decryptText(cloudLoc.lng));

    // 🔓 Dekripcija slika sa clouda
    const decryptedImages = [];
    if (cloudLoc.images_urls && cloudLoc.images_urls.length > 0) {
      for (const imgUrl of cloudLoc.images_urls) {
        const decImg = await decryptMediaFromUrl(imgUrl);
        decryptedImages.push(decImg);
      }
    }

    // 🔓 Dekripcija audio zapisa sa clouda
    let decryptedAudio = null;
    if (cloudLoc.audio_url) {
      decryptedAudio = await decryptMediaFromUrl(cloudLoc.audio_url);
    }

    map.set(String(cloudLoc.id), {
      id: String(cloudLoc.id),
      lat: isNaN(decryptedLat) ? cloudLoc.lat : decryptedLat,
      lng: isNaN(decryptedLng) ? cloudLoc.lng : decryptedLng,
      title: decryptText(cloudLoc.title),
      description: decryptText(cloudLoc.description),
      audio: decryptedAudio,
      images: decryptedImages,
      synced: true,
      timestamp: cloudLoc.timestamp
    });
  }

  const merged = Array.from(map.values());
  localStorage.setItem(DB_KEY, JSON.stringify(merged));
  return merged;
}