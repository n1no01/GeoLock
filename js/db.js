import { supabase, getCurrentUser } from './supabase.js';

const DB_KEY = 'saved_locations';

export function getLocations() {
  return JSON.parse(localStorage.getItem(DB_KEY) || '[]');
}

export function saveLocation(location) {
  const locations = getLocations();
  // Označavamo da novi unos po defaultu nije sinhronizovan sa cloudom
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
  // 1. Ukloni odmah iz lokalne memorije (localStorage)
  let locations = getLocations();
  locations = locations.filter(l => String(l.id) !== String(id));
  localStorage.setItem(DB_KEY, JSON.stringify(locations));

  // 2. Ako ima mreže i korisnik je prijavljen, obriši i iz Supabase baze
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

export function mergeLocations(cloudLocations) {
  const localLocations = getLocations();
  const map = new Map();

  // Prvo dodamo lokalne lokacije u mapu
  localLocations.forEach(loc => map.set(String(loc.id), loc));

  // Zatim dodamo ili prepišemo cloud lokacijama
  cloudLocations.forEach(cloudLoc => {
    map.set(String(cloudLoc.id), {
      id: String(cloudLoc.id),
      lat: cloudLoc.lat,
      lng: cloudLoc.lng,
      title: cloudLoc.title,
      description: cloudLoc.description,
      audio: cloudLoc.audio_url,
      images: cloudLoc.images_urls || [],
      synced: true,
      timestamp: cloudLoc.timestamp
    });
  });

  const merged = Array.from(map.values());
  localStorage.setItem(DB_KEY, JSON.stringify(merged));
  return merged;
}