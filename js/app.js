import { initMap, updateMapMarkers, centerMap, previewLocation } from './map.js';
import { getCurrentLocation } from './gps.js';
import { toggleRecording, getCurrentAudio, resetAudioState } from './audio.js';
import { exportGeoJSON, exportCSV } from './export.js';
import { getCurrentUser, onAuthStateChange, signUpUser, signInUser, signOutUser } from './supabase.js';
import { syncLocationsWithCloud } from './sync.js';
import { saveLocation, updateLocation, getLocations } from './db.js';
import { isBiometricsAvailable, registerBiometrics, authenticateWithBiometrics } from './biometrics.js';
import { deriveKeyFromCredentials } from './crypto.js';
import * as mgrs from 'mgrs';

import { switchTab, renderListView, openModal, closeModal, openImageFull, showToast, updateCounts } from './ui.js';
import { checkAuthStatus } from './auth.js';

let currentEditingImages = [];
let isSignUpMode = false;

document.addEventListener('DOMContentLoaded', async () => {
  initMap((lat, lng) => {
    document.getElementById('lat').value = lat.toFixed(6);
    document.getElementById('lng').value = lng.toFixed(6);
    updateMgrsFromLatLng();
  });

  setupEventListeners();
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

function setupEventListeners() {
  document.getElementById('tabMapBtn').addEventListener('click', () => switchTab('map-view'));
  document.getElementById('tabListBtn').addEventListener('click', () => switchTab('list-view'));

  const gpsBtn = document.getElementById('gpsBtn');
  if (gpsBtn) {
    gpsBtn.addEventListener('click', async () => {
      await getCurrentLocation();
      updatePreviewFromInputs();
      updateMgrsFromLatLng();
    });
  }

  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  const latInput = document.getElementById('lat');
  const lngInput = document.getElementById('lng');
  const updatePreviewFromInputs = () => {
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (!isNaN(lat) && !isNaN(lng)) previewLocation(lat, lng);
  };

  if (latInput && lngInput) {
    latInput.addEventListener('input', updatePreviewFromInputs);
    lngInput.addEventListener('input', updatePreviewFromInputs);
  }

  document.getElementById('exportGeoJsonBtn').addEventListener('click', exportGeoJSON);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
  document.getElementById('locationForm').addEventListener('submit', handleAddFormSubmit);
  document.getElementById('editForm').addEventListener('submit', handleEditFormSubmit);

  document.getElementById('searchInput').addEventListener('input', renderListView);
  document.getElementById('sortSelect').addEventListener('change', renderListView);

  // Auth i Biometrija eventi
  const enableBioHeaderBtn = document.getElementById('enableBioHeaderBtn');
  if (enableBioHeaderBtn) {
    enableBioHeaderBtn.addEventListener('click', async () => {
      if (!await isBiometricsAvailable()) {
        showToast("Uređaj ne podržava biometriju.", "error");
        return;
      }
      if (await registerBiometrics()) await checkAuthStatus();
    });
  }

  const bioBtn = document.getElementById('biometricsBtn');
  if (bioBtn) {
    bioBtn.addEventListener('click', async () => {
      if (await authenticateWithBiometrics()) {
        document.getElementById('authModal').classList.remove('open');
        await checkAuthStatus();
      }
    });
  }

  const authBtn = document.getElementById('authBtn');
  if (authBtn) {
    authBtn.addEventListener('click', async () => {
      if (await getCurrentUser()) {
        if (confirm('Želite li se odjaviti?')) {
          await signOutUser();
          await checkAuthStatus();
        }
      } else {
        await checkAuthStatus();
      }
    });
  }

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

  const authForm = document.getElementById('authForm');
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('authEmail').value;
      const password = document.getElementById('authPassword').value;
      const rememberMe = document.getElementById('rememberMe')?.checked ?? true;
      deriveKeyFromCredentials(email, password);

      try {
        if (isSignUpMode) {
          await signUpUser(email, password);
          showToast('Registracija uspješna! Provjerite email.', 'success');
        } else {
          await signInUser(email, password, rememberMe);
          showToast('Prijavljeni ste!', 'success');
          if (await isBiometricsAvailable() && localStorage.getItem('biometrics_enabled') !== 'true') {
            if (confirm("Želite li aktivirati biometrijsku prijavu?")) await registerBiometrics();
          }
          await syncLocationsWithCloud();
          await updateMapMarkers();
          await renderListView();
        }
        document.getElementById('authModal').classList.remove('open');
        await checkAuthStatus();
      } catch (err) {
        showToast('Greška: ' + err.message, 'error');
      }
    });
  }
}

async function handleAddFormSubmit(e) {
  e.preventDefault();
  if (!await getCurrentUser()) {
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

  await saveLocation({
    id: Date.now().toString(),
    lat, lng, title, description,
    audio: getCurrentAudio(),
    images,
    synced: false,
    timestamp: new Date().toISOString()
  });

  resetAudioState();
  document.getElementById('locationForm').reset();
  document.getElementById('gpsStatus').innerText = '';
  showToast('Lokacija sačuvana lokalno!', 'success');

  await syncLocationsWithCloud();
  await updateMapMarkers();
  await renderListView();
}

async function openEditModal(id) {
  const locations = await getLocations();
  const loc = locations.find(l => String(l.id) === String(id));
  if (!loc) return;

  document.getElementById('editId').value = loc.id;
  document.getElementById('editLat').value = loc.lat;
  document.getElementById('editLng').value = loc.lng;
  document.getElementById('editTitle').value = loc.title;
  document.getElementById('editDescription').value = loc.description || '';
  currentEditingImages = loc.images ? [...loc.images] : [];
  renderEditGallery();
  document.getElementById('editModal').classList.add('open');
}

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

async function handleEditFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const lat = parseFloat(document.getElementById('editLat').value);
  const lng = parseFloat(document.getElementById('editLng').value);
  const title = document.getElementById('editTitle').value;
  const description = document.getElementById('editDescription').value;
  const files = document.getElementById('editNewImages').files;
  const newImages = await Promise.all(Array.from(files).map(file => compressImage(file)));

  await updateLocation(id, { lat, lng, title, description, images: [...currentEditingImages, ...newImages], synced: false });
  await updateMapMarkers();
  await renderListView();
  closeModal('editModal');
  await openModal(id);
  await syncLocationsWithCloud();
  await updateMapMarkers();
  await renderListView();
}

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

// MGRS konverzija u formi
const latInput = document.getElementById('lat');
const lngInput = document.getElementById('lng');
const mgrsInput = document.getElementById('mgrsInput');

function updateMgrsFromLatLng() {
  if (!latInput || !lngInput || !mgrsInput) return;
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    try { mgrsInput.value = mgrs.forward([lng, lat], 5); } catch (e) {}
  }
}

function updateLatLngFromMgrs() {
  if (!latInput || !lngInput || !mgrsInput) return;
  const val = mgrsInput.value.trim();
  if (val.length > 5) {
    try {
      const lngLat = mgrs.toPoint(val);
      latInput.value = lngLat[1].toFixed(6);
      lngInput.value = lngLat[0].toFixed(6);
      previewLocation(lngLat[1], lngLat[0]);
    } catch (e) {}
  }
}

if (latInput && lngInput && mgrsInput) {
  latInput.addEventListener('input', updateMgrsFromLatLng);
  lngInput.addEventListener('input', updateMgrsFromLatLng);
  mgrsInput.addEventListener('input', updateLatLngFromMgrs);
}

// Globalne funkcije za HTML dugmad (onclick)
window.switchTab = switchTab;
window.getCurrentLocation = getCurrentLocation;
window.toggleRecording = toggleRecording;
window.openModal = openModal;
window.closeModal = closeModal;
window.openEditModal = openEditModal;
window.openImageFull = openImageFull;
window.exportGeoJSON = exportGeoJSON;
window.exportCSV = exportCSV;