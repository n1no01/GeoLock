// Rad sa medijima na strani UI-a: kompresija, privremeni URL-ovi, preuzimanje.

import { getMediaBlob } from './db.js';
import { ensureMediaDownloaded } from './sync.js';

export const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB po dokumentu
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024; // ulazna slika prije kompresije

// ---------- Privremeni (object) URL-ovi ----------
// Dešifrovani Blob živi u memoriji dok god je URL aktivan, pa broj URL-ova ograničavamo.

const MAX_CACHED_URLS = 80;
const urlCache = new Map(); // mediaId -> url (redoslijed umetanja = LRU)

/** Dešifrovani Blob; ako medij još nije preuzet sa clouda, preuzmi ga prvo. */
export async function getMediaBlobEnsured(mediaId) {
  let blob = await getMediaBlob(mediaId);
  if (!blob) {
    await ensureMediaDownloaded(mediaId);
    blob = await getMediaBlob(mediaId);
  }
  return blob;
}

export async function getMediaUrl(mediaId) {
  if (urlCache.has(mediaId)) {
    const url = urlCache.get(mediaId);
    urlCache.delete(mediaId); // osvježi "svježinu"
    urlCache.set(mediaId, url);
    return url;
  }
  const blob = await getMediaBlobEnsured(mediaId);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  urlCache.set(mediaId, url);
  while (urlCache.size > MAX_CACHED_URLS) {
    const [oldId, oldUrl] = urlCache.entries().next().value;
    URL.revokeObjectURL(oldUrl);
    urlCache.delete(oldId);
  }
  return url;
}

/** Pozvati pri zaključavanju/odjavi: dešifrovani sadržaj ne smije ostati u memoriji. */
export function revokeAllMediaUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// ---------- Ulaz ----------

/** Smanji sliku (max širina) i vrati JPEG Blob. */
export async function compressImage(file, maxWidth = 1600, quality = 0.7) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`Slika "${file.name}" je prevelika.`);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file); // poštuje EXIF orijentaciju
  } catch {
    throw new Error(`Format slike "${file.name}" nije podržan.`);
  }

  const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error(`Slika "${file.name}" nije mogla biti obrađena.`);
  return blob;
}

export function assertDocumentSize(file) {
  if (file.size > MAX_DOC_BYTES) {
    throw new Error(`Dokument "${file.name}" je veći od ${MAX_DOC_BYTES / 1024 / 1024} MB.`);
  }
}

// ---------- Izlaz ----------

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
