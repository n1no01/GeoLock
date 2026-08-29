import { initMap, updateMapMarkers, centerMap, previewLocation } from './map.js';
import { getCurrentLocation } from './gps.js';
import { toggleRecording, getCurrentAudio, resetAudioState } from './audio.js';
import { exportGeoJSON, exportCSV, exportSingleLocationToDocx } from './export.js';
import { getCurrentUser, onAuthStateChange, signUpUser, signInUser, signOutUser } from './supabase.js';
import { syncLocationsWithCloud } from './sync.js';
import { saveLocation, updateLocation, getLocations } from './db.js';
import { isBiometricsAvailable, registerBiometrics } from './biometrics.js';
import { deriveKeyFromCredentials } from './crypto.js';
import * as mgrs from 'mgrs';

import { switchTab, renderListView, openModal, closeModal, openImageFull, showToast, updateCounts } from './ui.js';
import { checkAuthStatus, initAuthListeners, handleLogout } from './auth.js';

let currentEditingImages = [];
let currentEditingDocs = [];
let isSignUpMode = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Inicijalizacija mape i povezivanje sa Lat/Lng/MGRS poljima
  initMap((lat, lng) => {
    const latInput = document.getElementById('lat');
    const lngInput = document.getElementById('lng');
    if (latInput && lngInput) {
      latInput.value = lat.toFixed(6);
      lngInput.value = lng.toFixed(6);
      updateMgrsFromLatLng();
    }
  });

  // Inicijalizacija biometrijskih i auth listenera iz auth.js
  initAuthListeners();

  setupEventListeners();
  setupMgrsListeners();
  await updateCounts();
  await checkAuthStatus();

  if (typeof onAuthStateChange === 'function') {
    onAuthStateChange(async (event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
        await checkAuthStatus();
      }
    });
  }
});

// Pomoćna funkcija za MGRS na glavnoj formi
function updateMgrsFromLatLng() {
  const latInput = document.getElementById('lat');
  const lngInput = document.getElementById('lng');
  const mgrsInput = document.getElementById('mgrsInput');
  if (!latInput || !lngInput || !mgrsInput) return;

  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    try {
      mgrsInput.value = mgrs.forward([lng, lat], 5);
    } catch (e) {
      console.warn('MGRS Conversion error:', e);
    }
  } else {
    mgrsInput.value = '';
  }
}

// Pomoćna funkcija za MGRS na modal forme za izmjenu
function updateEditMgrsFromLatLng() {
  const latInput = document.getElementById('editLat');
  const lngInput = document.getElementById('editLng');
  const mgrsInput = document.getElementById('editMgrsInput');
  if (!latInput || !lngInput || !mgrsInput) return;

  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    try {
      mgrsInput.value = mgrs.forward([lng, lat], 5);
    } catch (e) {
      console.warn('MGRS Edit Conversion error:', e);
    }
  } else {
    mgrsInput.value = '';
  }
}

function setupEventListeners() {
  // Tab navigacija
  const tabMapBtn = document.getElementById('tabMapBtn');
  const tabListBtn = document.getElementById('tabListBtn');
  if (tabMapBtn) tabMapBtn.addEventListener('click', () => switchTab('map-view'));
  if (tabListBtn) tabListBtn.addEventListener('click', () => switchTab('list-view'));

  // GPS dugme
  const gpsBtn = document.getElementById('gpsBtn');
  if (gpsBtn) {
    gpsBtn.addEventListener('click', async () => {
      await getCurrentLocation();
      updatePreviewFromInputs();
      updateMgrsFromLatLng();
    });
  }

  // Snimanje zvuka
  const recordBtn = document.getElementById('recordBtn');
  if (recordBtn) {
    recordBtn.addEventListener('click', toggleRecording);
  }

  // Ručni unos Lat/Lng sa pregledom na mapi
  const latInput = document.getElementById('lat');
  const lngInput = document.getElementById('lng');
  const updatePreviewFromInputs = () => {
    if (!latInput || !lngInput) return;
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (!isNaN(lat) && !isNaN(lng)) previewLocation(lat, lng);
  };

  if (latInput && lngInput) {
    latInput.addEventListener('input', updatePreviewFromInputs);
    lngInput.addEventListener('input', updatePreviewFromInputs);
  }

  // Eksport dugmad
  const exportGeoBtn = document.getElementById('exportGeoJsonBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportGeoBtn) exportGeoBtn.addEventListener('click', exportGeoJSON);
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportCSV);

  // Forme
  const locForm = document.getElementById('locationForm');
  const editForm = document.getElementById('editForm');
  if (locForm) locForm.addEventListener('submit', handleAddFormSubmit);
  if (editForm) editForm.addEventListener('submit', handleEditFormSubmit);

  // Pretraga i sortiranje
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  if (searchInput) searchInput.addEventListener('input', renderListView);
  if (sortSelect) sortSelect.addEventListener('change', renderListView);

  // Prebacivanje između Prijava / Registracija moda
  const toggleAuthLink = document.getElementById('toggleAuthMode');
  if (toggleAuthLink) {
    toggleAuthLink.addEventListener('click', (e) => {
      e.preventDefault();
      isSignUpMode = !isSignUpMode;
      document.getElementById('authTitle').innerText = isSignUpMode ? 'Registracija' : 'Korisnička Prijava';
      document.getElementById('authSubmitBtn').innerText = isSignUpMode ? 'Registruj se' : 'Prijavi se';
      document.getElementById('toggleAuthMode').innerText = isSignUpMode ? 'Već imate račun? Prijavite se' : 'Nemate račun? Registrujte se';
    });
  }

  // Submit Auth forme
  const authForm = document.getElementById('authForm');
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('authEmail').value;
      const password = document.getElementById('authPassword').value;
      const rememberMe = document.getElementById('rememberMe')?.checked ?? true;

      try {
        if (isSignUpMode) {
          await deriveKeyFromCredentials(email, password);
          await signUpUser(email, password);
          showToast('Registracija uspješna! Provjerite email.', 'success');
        } else {
          await deriveKeyFromCredentials(email, password);
          await signInUser(email, password, rememberMe);
          
          showToast('Prijavljeni ste!', 'success');
          if (await isBiometricsAvailable() && localStorage.getItem('biometrics_enabled') !== 'true') {
            if (confirm("Želite li aktivirati biometrijsku prijavu?")) await registerBiometrics();
          }
          
          await syncLocationsWithCloud();
          await updateMapMarkers();
          await renderListView();
        }
        closeModal('authModal');
        await checkAuthStatus();
      } catch (err) {
        showToast('Greška: ' + err.message, 'error');
      }
    });
  }
}

// Konverzija fajla u Base64 format
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve({ name: file.name, data: reader.result, size: file.size });
    reader.onerror = error => reject(error);
  });
}

// Kompresija slika putem Canvas-a
function compressImage(file, maxWidth = 1600, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width, height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
    };
  });
}

async function handleAddFormSubmit(e) {
  e.preventDefault();
  
  // Provjera: Korisnik je prijavljen ako postoji Supabase user ILI aktivna biometrijska sesija
  const user = await getCurrentUser();
  const isBioAuth = localStorage.getItem('bio_session_active') === 'true';

  if (!user && !isBioAuth) {
    showToast('Morate biti prijavljeni!', 'error');
    await checkAuthStatus();
    return;
  }

  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  
  const files = document.getElementById('imageInput').files;
  const images = await Promise.all(Array.from(files).map(file => compressImage(file)));

  const docInput = document.getElementById('documentInput');
  const docFiles = docInput ? docInput.files : [];
  const documents = await Promise.all(Array.from(docFiles).map(file => fileToBase64(file)));

  await saveLocation({
    id: Date.now().toString(),
    lat, lng, title, description,
    audio: getCurrentAudio(),
    images,
    documents,
    synced: false,
    timestamp: new Date().toISOString()
  });

  resetAudioState();
  document.getElementById('locationForm').reset();
  if (docInput) docInput.value = '';
  const gpsStatus = document.getElementById('gpsStatus');
  if (gpsStatus) gpsStatus.innerText = '';
  
  showToast('Lokacija i prilozi sačuvani lokalno!', 'success');

  // Sinhronizaciju pokušaj samo ako postoji stvarna Supabase sesija i internet konekcija
  if (user && navigator.onLine) {
    try {
      await syncLocationsWithCloud();
    } catch (err) {
      console.warn("Sinhronizacija pri dodavanju preskočena:", err);
    }
  }

  await updateMapMarkers();
  await renderListView();
}

// Otvaranje modala za izmjenu
async function openEditModal(id) {
  const locations = await getLocations();
  const loc = locations.find(l => String(l.id) === String(id));
  if (!loc) return;

  document.getElementById('editId').value = loc.id;
  document.getElementById('editLat').value = loc.lat;
  document.getElementById('editLng').value = loc.lng;
  document.getElementById('editTitle').value = loc.title;
  document.getElementById('editDescription').value = loc.description || '';
  
  updateEditMgrsFromLatLng();

  currentEditingImages = loc.images ? [...loc.images] : [];
  renderEditGallery();

  currentEditingDocs = loc.documents ? [...loc.documents] : [];
  renderEditDocs();

  openModal('editModal');
}

// Prikaz postojećih slika u modalima za izmjenu
function renderEditGallery() {
  const gallery = document.getElementById('editExistingGallery');
  if (!gallery) return;
  gallery.innerHTML = '';
  currentEditingImages.forEach((img, index) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.innerHTML = `<img src="${img}"><button type="button" class="delete-img-btn">&times;</button>`;
    item.querySelector('.delete-img-btn').addEventListener('click', () => {
      currentEditingImages.splice(index, 1);
      renderEditGallery();
    });
    gallery.appendChild(item);
  });
}

// Prikaz postojećih dokumenata u modalima za izmjenu
function renderEditDocs() {
  const docsContainer = document.getElementById('editExistingDocs');
  if (!docsContainer) return;
  docsContainer.innerHTML = '';

  if (currentEditingDocs.length === 0) {
    docsContainer.innerHTML = '<span style="font-size:11px; color:#94a3b8;">Nema priloženih dokumenata.</span>';
    return;
  }

  currentEditingDocs.forEach((doc, index) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; margin-bottom:4px;';
    item.innerHTML = `
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%;">📄 ${doc.name}</span>
      <button type="button" class="btn btn-danger" style="font-size:10px; padding:2px 6px;">&times;</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      currentEditingDocs.splice(index, 1);
      renderEditDocs();
    });
    docsContainer.appendChild(item);
  });
}

// Obrada čuvanja izmjena lokacije
async function handleEditFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const lat = parseFloat(document.getElementById('editLat').value);
  const lng = parseFloat(document.getElementById('editLng').value);
  const title = document.getElementById('editTitle').value;
  const description = document.getElementById('editDescription').value;
  
  const files = document.getElementById('editNewImages').files;
  const newImages = await Promise.all(Array.from(files).map(file => compressImage(file)));

  const newDocInput = document.getElementById('editNewDocs');
  const newDocFiles = newDocInput ? newDocInput.files : [];
  const newDocs = await Promise.all(Array.from(newDocFiles).map(file => fileToBase64(file)));

  try {
    await updateLocation(id, { 
      lat, 
      lng, 
      title, 
      description, 
      images: [...currentEditingImages, ...newImages], 
      documents: [...currentEditingDocs, ...newDocs],
      synced: false,
      timestamp: new Date().toISOString()
    });

    closeModal('editModal');
    if (newDocInput) newDocInput.value = '';
    const editNewImages = document.getElementById('editNewImages');
    if (editNewImages) editNewImages.value = '';

    showToast('Izmjena sačuvana!', 'success');

    if (navigator.onLine) {
      try {
        await syncLocationsWithCloud();
      } catch (err) {
        console.warn("Sinhronizacija pri izmjeni preskočena:", err);
      }
    }

    await updateMapMarkers();
    await renderListView();

  } catch (err) {
    console.error("Greška pri izmjeni lokacije:", err);
    showToast("Greška pri spašavanju izmjena.", "error");
  }
}

// Dvosmjerno osluškivanje MGRS unosa i Lat/Lng pretvaranje
function setupMgrsListeners() {
  const latInput = document.getElementById('lat');
  const lngInput = document.getElementById('lng');
  const mgrsInput = document.getElementById('mgrsInput');

  if (latInput && lngInput && mgrsInput) {
    latInput.addEventListener('input', updateMgrsFromLatLng);
    lngInput.addEventListener('input', updateMgrsFromLatLng);

    mgrsInput.addEventListener('input', () => {
      const val = mgrsInput.value.trim();
      if (val.length >= 3) {
        try {
          const lngLat = mgrs.toPoint(val);
          latInput.value = lngLat[1].toFixed(6);
          lngInput.value = lngLat[0].toFixed(6);
          previewLocation(lngLat[1], lngLat[0]);
        } catch (e) {}
      }
    });
  }

  const editLatInput = document.getElementById('editLat');
  const editLngInput = document.getElementById('editLng');
  const editMgrsInput = document.getElementById('editMgrsInput');

  if (editLatInput && editLngInput && editMgrsInput) {
    editLatInput.addEventListener('input', updateEditMgrsFromLatLng);
    editLngInput.addEventListener('input', updateEditMgrsFromLatLng);

    editMgrsInput.addEventListener('input', () => {
      const val = editMgrsInput.value.trim();
      if (val.length >= 3) {
        try {
          const lngLat = mgrs.toPoint(val);
          editLatInput.value = lngLat[1].toFixed(6);
          editLngInput.value = lngLat[0].toFixed(6);
        } catch (e) {}
      }
    });
  }
}

// Globalne funkcije za HTML inline event handlere
window.switchTab = switchTab;
window.getCurrentLocation = getCurrentLocation;
window.toggleRecording = toggleRecording;
window.openModal = openModal;
window.closeModal = closeModal;
window.openEditModal = openEditModal;
window.openImageFull = openImageFull;
window.exportGeoJSON = exportGeoJSON;
window.exportCSV = exportCSV;
window.exportSingleLocationToDocx = exportSingleLocationToDocx;
window.centerMap = centerMap;