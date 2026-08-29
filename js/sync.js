import { supabase, getCurrentUser } from './supabase.js';
import { getLocations, saveLocation, mergeLocations } from './db.js';
import { encryptText, encryptMediaBase64, getSecretKey } from './crypto.js';
import { showToast } from './ui.js';

// Prebacivanje uploada u Cloud Storage
async function uploadMediaToStorage(userId, locationId, mediaBase64, folder = 'images') {
  if (!mediaBase64) return null;

  const blob = encryptMediaBase64(mediaBase64);
  if (!blob) return null;

  const fileName = `${userId}/${locationId}/${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.enc`;

  const { data, error } = await supabase.storage
    .from('location_media')
    .upload(fileName, blob, {
      contentType: 'text/plain',
      upsert: true
    });

  if (error) {
    console.error(`Greška pri uploadu ${folder}:`, error);
    return null;
  }

  const { data: publicUrlData } = supabase.storage
    .from('location_media')
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

    for (const loc of unsynced) {
      // 1. Upload slika
      let imageUrls = [];
      if (loc.images && loc.images.length > 0) {
        for (const imgBase64 of loc.images) {
          if (imgBase64.startsWith('http')) {
            imageUrls.push(imgBase64);
          } else {
            const url = await uploadMediaToStorage(user.id, loc.id, imgBase64, 'images');
            if (url) imageUrls.push(url);
          }
        }
      }

      // 2. Upload audio zapisa
      let audioUrl = null;
      if (loc.audio) {
        if (loc.audio.startsWith('http')) {
          audioUrl = loc.audio;
        } else {
          audioUrl = await uploadMediaToStorage(user.id, loc.id, loc.audio, 'audio');
        }
      }

      // 3. Upload dokumenata
      let docsData = [];
      if (loc.documents && loc.documents.length > 0) {
        for (const doc of loc.documents) {
          if (doc.data.startsWith('http')) {
            docsData.push(doc);
          } else {
            const docUrl = await uploadMediaToStorage(user.id, loc.id, doc.data, 'documents');
            if (docUrl) {
              const encName = encryptText(doc.name);
              docsData.push({ name: encName, data: docUrl });
            }
          }
        }
      }

      // Enkripcija tekstualnih podataka
      const encTitle = encryptText(loc.title);
      const encDesc = encryptText(loc.description);
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
        console.error("Greška pri slanju na Supabase:", error);
      } else {
        await saveLocation({ ...loc, synced: true });
      }
    }

    await downloadLocationsFromCloud();
    showToast("Sinhronizacija uspješno završena!", "success");
  } catch (e) {
    console.error("Sinhronizacija neuspješna:", e);
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
      console.error("Greška pri preuzimanju sa Supabase-a:", error);
      return;
    }

    if (data) {
      await mergeLocations(data);
    }
  } catch (e) {
    console.error("Greška pri preuzimanju sa clouda:", e);
  }
}