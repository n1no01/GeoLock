import { initMap, previewLocation, clearPreview } from './map.js';
import { getCurrentLocation, getLastFix, fixMatches, clearLastFix } from './gps.js';
import { toggleRecording, getCurrentAudio, resetAudioState } from './audio.js';
import { exportGeoJSON, exportCSV } from './export.js';
import { onAuthStateChange } from './supabase.js';
import { syncLocationsWithCloud, DATA_CHANGED_EVENT } from './sync.js';
import { putLocation } from './db.js';
import { hasActiveKey } from './crypto.js';
import { compressImage, assertDocumentSize } from './media.js';
import { bindCoordinateInputs } from './coords.js';
import { isValidLatLng, uuid } from './utils.js';
import { showToast } from './toast.js';
import { initModals, switchTab, renderListView, openDetails, refreshViews } from './ui.js';
import { initEdit } from './edit.js';
import { initAuth, checkAuthStatus, isAuthBusy, isUnlocked, handlePasswordRecovery } from './auth.js';

const $ = (id) => document.getElementById(id);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Dodavanje lokacije ----------

async function handleAddSubmit(e) {
  e.preventDefault();

  if (!hasActiveKey()) {
    showToast('Aplikacija je zaključana. Otključajte je za spremanje.', 'error');
    await checkAuthStatus();
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const lat = parseFloat($('lat').value);
  const lng = parseFloat($('lng').value);
  const title = $('title').value.trim();

  if (!isValidLatLng(lat, lng)) {
    showToast('Koordinate nisu ispravne (Lat −90…90, Lng −180…180).', 'error');
    return;
  }
  if (!title) {
    showToast('Naziv je obavezan.', 'error');
    return;
  }

  submitBtn.disabled = true;
  try {
    const id = uuid();
    const now = new Date().toISOString();
    const addMedia = [];
    const images = [];
    const documents = [];
    let audio = null;

    for (const file of $('imageInput').files) {
      const blob = await compressImage(file);
      const mediaId = uuid();
      addMedia.push({ id: mediaId, locationId: id, mime: 'image/jpeg', blob });
      images.push(mediaId);
    }
    for (const file of $('documentInput').files) {
      assertDocumentSize(file);
      const mediaId = uuid();
      addMedia.push({ id: mediaId, locationId: id, mime: file.type || 'application/octet-stream', blob: file });
      documents.push({ id: mediaId, name: file.name });
    }
    const recorded = getCurrentAudio();
    if (recorded) {
      audio = uuid();
      addMedia.push({ id: audio, locationId: id, mime: recorded.mime, blob: recorded.blob });
    }

    // Preciznost se bilježi samo ako koordinate još odgovaraju GPS očitanju (nisu ručno mijenjane)
    const fix = getLastFix();
    const accuracy = fix && fixMatches(lat, lng) ? fix.accuracy : null;

    // Greška (npr. QuotaExceededError) se propagira i prikazuje — nema više lažnog "sačuvano!"
    await putLocation({
      id, title, description: $('description').value, lat, lng, accuracy,
      createdAt: now, updatedAt: now, images, audio, documents
    }, { addMedia });

    $('locationForm').reset();
    $('gpsStatus').textContent = '';
    resetAudioState();
    clearLastFix();
    clearPreview();

    showToast('Lokacija sačuvana lokalno!', 'success');
    await refreshViews();
    syncLocationsWithCloud({ silent: true }).catch((err) => console.error(err));
  } catch (err) {
    console.error('Greška pri spremanju lokacije:', err);
    showToast(err?.name === 'QuotaExceededError'
      ? 'Nema dovoljno slobodnog prostora na uređaju. Lokacija NIJE sačuvana.'
      : `Lokacija nije sačuvana: ${err?.message || 'nepoznata greška'}`, 'error', 6000);
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------- Inicijalizacija ----------

async function init() {
  initModals();
  initEdit();

  // Karta
  const { refreshMgrs } = bindCoordinateInputs({
    latEl: $('lat'),
    lngEl: $('lng'),
    mgrsEl: $('mgrsInput'),
    onChange: () => {
      const lat = parseFloat($('lat').value);
      const lng = parseFloat($('lng').value);
      if (isValidLatLng(lat, lng)) previewLocation(lat, lng);
    }
  });

  await initMap({
    onPick: (lat, lng) => {
      $('lat').value = lat.toFixed(6);
      $('lng').value = lng.toFixed(6);
      refreshMgrs();
    },
    onDetails: (id) => openDetails(id)
  });

  // Tabovi
  $('tabMapBtn').addEventListener('click', () => switchTab('map-view'));
  $('tabListBtn').addEventListener('click', () => switchTab('list-view'));

  // GPS: greška se prikazuje u statusu; ne smije ostati neuhvaćen rejection
  $('gpsBtn').addEventListener('click', async () => {
    try {
      await getCurrentLocation({
        onUpdate: (fix) => {
          refreshMgrs();
          previewLocation(fix.lat, fix.lng);
        }
      });
    } catch (err) {
      if (err?.message !== 'cancelled') console.warn('GPS:', err);
    }
  });

  $('recordBtn').addEventListener('click', toggleRecording);
  $('exportGeoJsonBtn').addEventListener('click', exportGeoJSON);
  $('exportCsvBtn').addEventListener('click', exportCSV);
  $('locationForm').addEventListener('submit', handleAddSubmit);

  const rerenderList = debounce(renderListView, 200);
  $('searchInput').addEventListener('input', rerenderList);
  $('sortSelect').addEventListener('change', renderListView);

  // Nakon sinhronizacije (preuzimanje sa drugog uređaja, medija i sl.) osvježi prikaz
  window.addEventListener(DATA_CHANGED_EVENT, () => { refreshViews(); });

  // Veza: sinhronizacija kad se vrati internet
  window.addEventListener('online', () => {
    if (isUnlocked()) syncLocationsWithCloud({ silent: true, force: false }).catch(() => {});
  });

  // Supabase događaji (callback je već odgođen u supabase.js)
  onAuthStateChange(async (event) => {
    if (event === 'PASSWORD_RECOVERY') {
      await handlePasswordRecovery();
    } else if (event === 'SIGNED_OUT') {
      await checkAuthStatus();
    } else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      if (!isAuthBusy()) await checkAuthStatus();
    } else if (event === 'TOKEN_REFRESHED' && isUnlocked()) {
      syncLocationsWithCloud({ silent: true, force: false }).catch(() => {});
    }
  });

  await initAuth();
}

init().catch((err) => {
  console.error('Pokretanje aplikacije nije uspjelo:', err);
  showToast('Greška pri pokretanju aplikacije. Osvježite stranicu.', 'error', 8000);
});
