import { supabase, getCurrentUser } from './supabase.js';
import { getLocations, saveLocation, mergeLocations } from './db.js';
import { encryptText, encryptMediaBase64, getSecretKey } from './crypto.js';
import { showToast } from './ui.js';

function isEncryptedFormat(str) {
  if (!str) return false;
  return typeof str === 'string' && (str.startsWith('U2FsdGVkX1') || (str.length > 100 && !str.includes(' ')));
}

async function uploadMediaToStorage(userId, locationId, mediaBase64, folder = 'images') {
  if (!mediaBase64) return null;

  // Ako je već prebačeno na cloud storage (URL), vraćamo ga direktno
  if (typeof mediaBase64 === 'string' && mediaBase64.startsWith('http')) {
    return mediaBase64;
  }

  const blob = encryptMediaBase64(mediaBase64);
  if (!blob) {
    console.error(`[SYNC ERROR] Enkripcija medija nije uspjela za folder: ${folder}`);
    return null;
  }

  const fileName = `${userId}/${locationId}/${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.enc`;

  const { data, error } = await supabase.storage
    .from('location-images')
    .upload(fileName, blob, {
      contentType: 'application/octet-stream',
      upsert: true
    });

  if (error) {
    console.error(`[STORAGE ERROR] Neuspješan upload (${folder}):`, error);
    return null;
  }

  const { data: publicUrlData } = supabase.storage
    .from('location-images')
    .getPublicUrl(fileName);

  return publicUrlData.publicUrl;
}

export async function syncLocationsWithCloud() {
  if (!navigator.onLine) {
    showToast("Nemate internet konekciju. Lokacije ostaju u lokalu.", "info");
    return;
  }

  if (!getSecretKey()) {
    showToast("Ključ za enkripciju nije dostupan. Odjavite se i prijavite lozinkom.", "error");
    return;
  }

  const user = await getCurrentUser();
  if (!user) {
    showToast("Morate biti prijavljeni za sinhronizaciju.", "error");
    return;
  }

  showToast("Sinhronizacija u toku...", "info");

  try {
    const locations = await getLocations();
    const unsynced = locations.filter(l => !l.synced);

    if (unsynced.length === 0) {
      await downloadLocationsFromCloud();
      showToast("Sve lokacije su već sinhronizovane.", "success");
      return;
    }

    let hasErrors = false;

    for (const loc of unsynced) {
      console.log(`[SYNC] Pokušaj sinhronizacije za lokaciju ID: ${loc.id}`);
      let uploadFailed = false;

      // 1. Upload slika
      let imageUrls = [];
      if (loc.images && loc.images.length > 0) {
        for (const imgBase64 of loc.images) {
          const url = await uploadMediaToStorage(user.id, loc.id, imgBase64, 'images');
          if (url) {
            imageUrls.push(url);
          } else {
            console.warn(`[SYNC WARNING] Slika za lokaciju ${loc.id} nije prenesena.`);
            uploadFailed = true;
          }
        }
      }

      // 2. Upload audio zapisa
      let audioUrl = null;
      if (loc.audio) {
        audioUrl = await uploadMediaToStorage(user.id, loc.id, loc.audio, 'audio');
        if (!audioUrl && !loc.audio.startsWith('http')) {
          console.warn(`[SYNC WARNING] Audio za lokaciju ${loc.id} nije prenesen.`);
          uploadFailed = true;
        }
      }

      // 3. Upload dokumenata
      let docsData = [];
      if (loc.documents && loc.documents.length > 0) {
        for (const doc of loc.documents) {
          const docUrl = await uploadMediaToStorage(user.id, loc.id, doc.data, 'documents');
          if (docUrl) {
            const encName = isEncryptedFormat(doc.name) ? doc.name : encryptText(doc.name);
            docsData.push({ name: encName, data: docUrl });
          } else {
            console.warn(`[SYNC WARNING] Dokument ${doc.name} za lokaciju ${loc.id} nije prenesen.`);
            uploadFailed = true;
          }
        }
      }

      if (uploadFailed) {
        hasErrors = true;
        continue; // Preskačemo upis u bazu za ovu lokaciju dok se medij ne popravi
      }

      // Enkripcija tekstualnih podataka
      const encTitle = encryptText(loc.title || 'Bez naslova');
      const encDesc = encryptText(loc.description || '');
      const encLat = encryptText(String(loc.lat));
      const encLng = encryptText(String(loc.lng));

      const payload = {
        id: String(loc.id),
        user_id: user.id,
        title: encTitle,
        description: encDesc,
        lat: encLat,
        lng: encLng,
        images_urls: imageUrls,
        audio_url: audioUrl,
        documents_data: docsData,
        timestamp: loc.timestamp || new Date().toISOString()
      };

      const { error } = await supabase
        .from('locations')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.error(`[DATABASE ERROR] Greška pri upsert-u u tabelu 'locations' za ID ${loc.id}:`, error);
        hasErrors = true;
      } else {
        console.log(`[SYNC SUCCESS] Lokacija ID ${loc.id} uspjeno sinhronizovana.`);
        await saveLocation({ ...loc, synced: true });
      }
    }

    await downloadLocationsFromCloud();

    if (hasErrors) {
      showToast("Sinhronizacija djelomično završena uz greške. Provjerite konzolu.", "error");
    } else {
      showToast("Sinhronizacija uspješno završena!", "success");
    }

  } catch (e) {
    console.error("[FATAL SYNC ERROR]:", e);
    showToast("Greška pri sinhronizaciji.", "error");
  }
}

export async function downloadLocationsFromCloud() {
  if (!navigator.onLine) return;

  if (!getSecretKey()) {
    console.warn("Preuzimanje preskočeno: Nema enkripcijskog ključa.");
    return;
  }

  const user = await getCurrentUser();
  if (!user) return;

  try {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('user_id', user.id);

    if (error) {
      console.error("[DOWNLOAD ERROR] Greška pri preuzimanju sa Supabase-a:", error);
      return;
    }

    if (data && data.length > 0) {
      await mergeLocations(data);
    }
  } catch (e) {
    console.error("[DOWNLOAD FATAL ERROR]:", e);
  }
}