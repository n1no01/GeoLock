import { supabase, getCurrentUser } from './supabase.js';
import { getLocations, updateLocation, mergeLocations } from './db.js';
import { updateMapMarkers } from './map.js';

// Pretvaranje Base64 u Blob za upload
function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64.split(',')[1]);
  const byteArrays = [];
  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}

// Upload fajla u Storage
async function uploadFile(base64Data, bucket, path) {
  if (!base64Data || base64Data.startsWith('http')) return base64Data; // Ako je već public URL

  const mimeType = base64Data.split(';')[0].split(':')[1] || 'image/jpeg';
  const blob = base64ToBlob(base64Data, mimeType);
  const ext = mimeType.split('/')[1] || 'jpg';
  const filePath = `${path}_${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage.from(bucket).upload(filePath, blob, {
    contentType: mimeType,
    upsert: true
  });

  if (error) {
    console.error(`Greška pri uploadu u storage bucket "${bucket}":`, error);
    throw new Error(`Storage upload [${bucket}]: ` + error.message);
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return urlData.publicUrl;
}

// Preuzimanje svih lokacija sa clouda za prijavljenog korisnika
export async function downloadLocationsFromCloud() {
  if (!navigator.onLine) return;

  const user = await getCurrentUser();
  if (!user) return;

  try {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('user_id', user.id);

    if (error) {
      console.error("Greška pri preuzimanju sa clouda:", error);
      return;
    }

    if (data && data.length > 0) {
      mergeLocations(data);
      if (typeof updateMapMarkers === 'function') {
        updateMapMarkers();
      }
    }
  } catch (err) {
    console.error("Greška pri preuzimanju lokacija:", err);
  }
}

// Glavna sinhronizacija (Upload + Download)
export async function syncLocationsWithCloud() {
  if (!navigator.onLine) return;

  const user = await getCurrentUser();
  if (!user) {
    console.warn("Sinhronizacija preskočena: Korisnik nije prijavljen.");
    return;
  }

  // 1. Prvo preuzmi sve postojeće lokacije iz baze (Dvosmjerna sinhronizacija)
  await downloadLocationsFromCloud();

  const locations = getLocations();
  const unsynced = locations.filter(l => !l.synced);

  if (unsynced.length === 0) return;

  console.log(`Započinjem sinhronizaciju za ${unsynced.length} nesinhronizovanih lokacija...`);

  for (const loc of unsynced) {
    try {
      // 2. Upload slika u Storage
      const imageUrls = [];
      if (loc.images && loc.images.length > 0) {
        for (let i = 0; i < loc.images.length; i++) {
          const url = await uploadFile(loc.images[i], 'location-images', `${user.id}/${loc.id}_img_${i}`);
          imageUrls.push(url);
        }
      }

      // 3. Upload zvuka u Storage
      let audioUrl = null;
      if (loc.audio) {
        audioUrl = await uploadFile(loc.audio, 'location-audio', `${user.id}/${loc.id}_audio`);
      }

      // 4. Upsert u PostgreSQL bazu
      const { error: dbError } = await supabase.from('locations').upsert({
        id: loc.id,
        user_id: user.id,
        lat: loc.lat,
        lng: loc.lng,
        title: loc.title,
        description: loc.description,
        audio_url: audioUrl,
        images_urls: imageUrls,
        timestamp: loc.timestamp
      });

      if (dbError) {
        console.error("Greška pri unosu u PostgreSQL tabelu:", dbError);
        throw new Error("Baza greška: " + dbError.message);
      }

      // 5. Označi lokalno da je sačuvano
      updateLocation(loc.id, { 
        synced: true, 
        images: imageUrls, 
        audio: audioUrl 
      });

      console.log(`Lokacija "${loc.title}" uspješno sinhronizovana!`);

    } catch (err) {
      console.error(`Greška pri sinhronizaciji lokacije ${loc.id}:`, err);
      alert(`Greška pri sinhronizaciji "${loc.title}":\n` + err.message);
      break; // Prekida petlju ako dođe do greške radi dijagnostike
    }
  }
}

// Automatski okidač pri spajanju na internet
window.addEventListener('online', syncLocationsWithCloud);