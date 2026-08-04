import { supabase, getCurrentUser } from './supabase.js';
import { getLocations, updateLocation, mergeLocations } from './db.js';
import { updateMapMarkers } from './map.js';
import { encryptText, encryptMediaBase64 } from './crypto.js';

// Upload enkriptovanog medijskog fajla u Storage
async function uploadEncryptedFile(base64Data, bucket, path) {
  if (!base64Data || base64Data.startsWith('http')) return base64Data;

  const encryptedBlob = encryptMediaBase64(base64Data);
  if (!encryptedBlob) throw new Error("Neuspješna enkripcija medijske datoteke.");

  const filePath = `${path}_${Date.now()}.enc`;

  const { data, error } = await supabase.storage.from(bucket).upload(filePath, encryptedBlob, {
    contentType: 'text/plain',
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
      await mergeLocations(data);
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

  console.log(`Započinjem Zero-Knowledge enkripciju i sinhronizaciju za ${unsynced.length} nesinhronizovanih lokacija...`);

  for (const loc of unsynced) {
    try {
      // 2. Upload enkriptovanih slika
      const imageUrls = [];
      if (loc.images && loc.images.length > 0) {
        for (let i = 0; i < loc.images.length; i++) {
          const url = await uploadEncryptedFile(loc.images[i], 'location-images', `${user.id}/${loc.id}_img_${i}`);
          imageUrls.push(url);
        }
      }

      // 3. Upload enkriptovanog zvuka
      let audioUrl = null;
      if (loc.audio) {
        audioUrl = await uploadEncryptedFile(loc.audio, 'location-audio', `${user.id}/${loc.id}_audio`);
      }

      // 4. Enkripcija svih tekstualnih polja i koordinata pri slanju
      const encryptedLat = encryptText(loc.lat);
      const encryptedLng = encryptText(loc.lng);
      const encryptedTitle = encryptText(loc.title);
      const encryptedDescription = encryptText(loc.description);

      // 5. Upsert u PostgreSQL bazu (sa enkriptovanim poljima)
      const { error: dbError } = await supabase.from('locations').upsert({
        id: loc.id,
        user_id: user.id,
        lat: encryptedLat,             // Šifrovana latituda
        lng: encryptedLng,             // Šifrovana longituda
        title: encryptedTitle,         // Šifrovani naslov
        description: encryptedDescription, // Šifrovani opis
        audio_url: audioUrl,           // Šifrovani URL zvuka
        images_urls: imageUrls,        // Šifrovani URL-ovi slika
        timestamp: loc.timestamp
      });

      if (dbError) {
        console.error("Greška pri unosu u PostgreSQL tabelu:", dbError);
        throw new Error("Baza greška: " + dbError.message);
      }

      // 6. Označi lokalno da je sačuvano
      updateLocation(loc.id, { 
        synced: true, 
        images: imageUrls, 
        audio: audioUrl 
      });

      console.log(`Lokacija "${loc.title}" kompletno enkriptovana i sinhronizovana!`);

    } catch (err) {
      console.error(`Greška pri sinhronizaciji lokacije ${loc.id}:`, err);
      alert(`Greška pri sinhronizaciji "${loc.title}":\n` + err.message);
      break;
    }
  }
}

// Automatski okidač pri spajanju na internet
window.addEventListener('online', syncLocationsWithCloud);