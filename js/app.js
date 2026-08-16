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
import { checkAuthStatus, initAuthListeners } from './auth.js';

let currentEditingImages = [];
let currentEditingDocs = [];
let isSignUpMode = false;

document.addEventListener('DOMContentLoaded', async () => {
  initMap((lat, lng) => {
    const latInput = document.getElementById('lat');
    const lngInput = document.getElementById('lng');
    if (latInput && lngInput) {
      latInput.value = lat.toFixed(6);
      lngInput.value = lng.toFixed(6);
      updateMgrsFromLatLng();
    }
  });

  // Inicijalizacija biometrijskih listenera iz auth.js
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

  const recordBtn = document.getElementById('recordBtn');
  if (recordBtn) {
    recordBtn.addEventListener('click', toggleRecording);
  }

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

  document.getElementById('exportGeoJsonBtn').addEventListener('click', exportGeoJSON);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
  document.getElementById('locationForm').addEventListener('submit', handleAddFormSubmit);
  document.getElementById('editForm').addEventListener('submit', handleEditFormSubmit);

  document.getElementById('searchInput').addEventListener('input', renderListView);
  document.getElementById('sortSelect').addEventListener('change', renderListView);

  // Standardni Auth (Sign In / Sign Out)
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
        document.getElementById('authModal').classList.remove('open');
        await checkAuthStatus();
      } catch (err) {
        showToast('Greška: ' + err.message, 'error');
      }
    });
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve({ name: file.name, data: reader.result, size: file.size });
    reader.onerror = error => reject(error);
  });
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
  document.getElementById('gpsStatus').innerText = '';
  showToast('Lokacija i prilozi sačuvani lokalno!', 'success');

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
  
  updateEditMgrsFromLatLng();

  currentEditingImages = loc.images ? [...loc.images] : [];
  renderEditGallery();

  currentEditingDocs = loc.documents ? [...loc.documents] : [];
  renderEditDocs();

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
    item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px;';
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
    showToast('Izmjena sačuvana!', 'success');

    await syncLocationsWithCloud();
    await updateMapMarkers();
    await renderListView();

  } catch (err) {
    console.error("Greška pri izmjeni lokacije:", err);
    showToast("Greška pri spašavanju izmjena.", "error");
  }
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

// Globalne funkcije za HTML atribute
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