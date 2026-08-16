import { supabase, getCurrentUser } from './supabase.js';
import { getLocations, updateLocation, mergeLocations, syncPendingDeletions } from './db.js';
import { updateMapMarkers } from './map.js';
import { encryptText, encryptMediaBase64 } from './crypto.js';

// Upload enkriptovanog medijskog/dokumentacijskog fajla u Storage
async function uploadEncryptedFile(base64Data, bucket, path) {
  if (!base64Data || base64Data.startsWith('http')) return base64Data;

  const encryptedBlob = encryptMediaBase64(base64Data);
  if (!encryptedBlob) throw new Error("Neuspješna enkripcija datoteke.");

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

  try {
    const user = await getCurrentUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('user_id', user.id);

    if (error) {
      console.error("Greška pri preuzimanju sa clouda:", error);
      return;
    }

    // ISPRVALJENO: Pozivamo mergeLocations ČAK I AKO JE data prazan niz (data = [])
    // da bi IndexedDB izbrisao sve lokalne stavke koje su obrisane na cloudu
    await mergeLocations(data || []);

    if (typeof updateMapMarkers === 'function') {
      updateMapMarkers();
    }
  } catch (err) {
    console.warn("Offline ili mrežna greška pri preuzimanju lokacija:", err.message);
  }
}

// Glavna sinhronizacija (Upload + Download)
export async function syncLocationsWithCloud() {
  if (!navigator.onLine) {
    console.log("Aplikacija je offline. Sinhronizacija se odgađa.");
    return;
  }

  try {
    const user = await getCurrentUser();
    if (!user) {
      console.warn("Sinhronizacija preskočena: Nema prijavljenog korisnika u sesiji.");
      return;
    }

    // 0. PRVO obriši sa clouda sve lokacije koje su obrisane dok je uređaj bio offline!
    await syncPendingDeletions();

    // 1. Dvosmjerna sinhronizacija - Šaljemo nesinhronizovane lokalne podatke
    const locations = await getLocations();
    const unsynced = locations.filter(l => !l.synced);

    if (unsynced.length > 0) {
      console.log(`Započinjem Zero-Knowledge enkripciju i sinhronizaciju za ${unsynced.length} nesinhronizovanih lokacija...`);

      for (const loc of unsynced) {
        try {
          // 2. Upload enkriptovanih slika
          let imageUrls = [];
          if (loc.images && loc.images.length > 0) {
            imageUrls = await Promise.all(
              loc.images.map((img, i) => 
                uploadEncryptedFile(img, 'location-images', `${user.id}/${loc.id}_img_${i}`)
              )
            );
          }

          // 3. Upload enkriptovanog zvuka
          let audioUrl = null;
          if (loc.audio) {
            audioUrl = await uploadEncryptedFile(loc.audio, 'location-audio', `${user.id}/${loc.id}_audio`);
          }

          // 4. Upload enkriptovanih dokumenata
          let docUrls = [];
          if (loc.documents && loc.documents.length > 0) {
            docUrls = await Promise.all(
              loc.documents.map(async (doc, i) => {
                const uploadedUrl = await uploadEncryptedFile(
                  doc.data, 
                  'location-documents', 
                  `${user.id}/${loc.id}_doc_${i}`
                );

                const encryptedName = doc.data.startsWith('http') 
                  ? doc.name 
                  : encryptText(doc.name);

                return { 
                  name: encryptedName,
                  data: uploadedUrl 
                };
              })
            );
          }

          // 5. Enkripcija svih tekstualnih polja i koordinata
          const encryptedLat = encryptText(loc.lat);
          const encryptedLng = encryptText(loc.lng);
          const encryptedTitle = encryptText(loc.title);
          const encryptedDescription = encryptText(loc.description);

          // 6. Upsert u PostgreSQL bazu
          const { error: dbError } = await supabase.from('locations').upsert({
            id: String(loc.id),
            user_id: user.id,
            lat: encryptedLat,
            lng: encryptedLng,
            title: encryptedTitle,
            description: encryptedDescription,
            audio_url: audioUrl,
            images_urls: imageUrls,
            documents_data: docUrls,
            timestamp: loc.timestamp || new Date().toISOString()
          });

          if (dbError) {
            console.error("Greška pri unosu u PostgreSQL tabelu:", dbError);
            throw new Error("Baza greška: " + dbError.message);
          }

          // 7. Označi lokalno da je sačuvano u IndexedDB
          await updateLocation(loc.id, { 
            synced: true
          });

          console.log(`Lokacija "${loc.title}" i priloženi dokumenti kompletno enkriptovani i sinhronizovani!`);

        } catch (err) {
          console.error(`Greška pri sinhronizaciji lokacije ${loc.id}:`, err);
          break; 
        }
      }
    }

    // 8. Preuzimanje osveženog stanja sa clouda
    await downloadLocationsFromCloud();

  } catch (globalErr) {
    console.error("Neočekivana greška u syncLocationsWithCloud:", globalErr);
  }
}

// Automatski okidači
window.addEventListener('online', () => {
  console.log("🌐 Konekcija uspostavljena. Pokrećem automatsku sinhronizaciju...");
  syncLocationsWithCloud();
});