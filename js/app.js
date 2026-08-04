import { getLocations, saveLocation, updateLocation, deleteLocationFromDb } from './db.js';
import { initMap, updateMapMarkers, centerMap, invalidateMapSize, previewLocation } from './map.js';
import { getCurrentLocation } from './gps.js';
import { toggleRecording, getCurrentAudio, resetAudioState } from './audio.js';
import { exportGeoJSON, exportCSV } from './export.js';
import { signUpUser, signInUser, signOutUser, getCurrentUser, onAuthStateChange } from './supabase.js';
import { syncLocationsWithCloud } from './sync.js';
import { setSecretKey, getSecretKey } from './crypto.js';
import { registerBiometrics, authenticateWithBiometrics, isBiometricsAvailable } from './biometrics.js';

let currentEditingImages = [];
let isSignUpMode = false;

// Inicijalizacija pri učitavanju stranice
document.addEventListener('DOMContentLoaded', async () => {
  initMap((lat, lng) => {
    document.getElementById('lat').value = lat.toFixed(6);
    document.getElementById('lng').value = lng.toFixed(6);
  });

  setupEventListeners();
  updateCounts();
  registerServiceWorker();

  // 1. Provjera postojeće sačuvane sesije pri učitavanju (Zapamti me)
  await checkAuthStatus();

  // 2. Osluškivač promjene stanja autentifikacije (automatska prijava/odjava/osvježavanje tokena)
  if (typeof onAuthStateChange === 'function') {
    onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        await checkAuthStatus();
      } else if (event === 'SIGNED_OUT') {
        await checkAuthStatus();
      }
    });
  }
});

function setupEventListeners() {
  // Tabovi
  document.getElementById('tabMapBtn').addEventListener('click', () => switchTab('map-view'));
  document.getElementById('tabListBtn').addEventListener('click', () => switchTab('list-view'));

  // GPS i Snimanje
  const gpsBtn = document.getElementById('gpsBtn');
  if (gpsBtn) {
    gpsBtn.addEventListener('click', async () => {
      await getCurrentLocation();
      updatePreviewFromInputs();
    });
  }
  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  // Osluškivanje ručnog unosa koordinata (reaktivni pregled na mapi)
  const latInput = document.getElementById('lat');
  const lngInput = document.getElementById('lng');

  const updatePreviewFromInputs = () => {
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (!isNaN(lat) && !isNaN(lng)) {
      previewLocation(lat, lng);
    }
  };

  if (latInput && lngInput) {
    latInput.addEventListener('input', updatePreviewFromInputs);
    lngInput.addEventListener('input', updatePreviewFromInputs);
  }

  // Export
  document.getElementById('exportGeoJsonBtn').addEventListener('click', exportGeoJSON);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);

  // Forme za unose
  document.getElementById('locationForm').addEventListener('submit', handleAddFormSubmit);
  document.getElementById('editForm').addEventListener('submit', handleEditFormSubmit);

  // Pretraga i sortiranje
  document.getElementById('searchInput').addEventListener('input', renderListView);
  document.getElementById('sortSelect').addEventListener('change', renderListView);

  // Biometrijska autentifikacija (TouchID / FaceID / Fingerprint)
  const bioBtn = document.getElementById('biometricsBtn');
  if (bioBtn) {
    bioBtn.addEventListener('click', async () => {
      const isAvailable = await isBiometricsAvailable();
      if (!isAvailable) {
        alert("Vaš uređaj ne podržava ili nema podešen otisak prsta / prepoznavanje lica.");
        return;
      }

      const isBioEnabled = localStorage.getItem('biometrics_enabled') === 'true';

      if (!isBioEnabled) {
        await registerBiometrics();
      } else {
        const success = await authenticateWithBiometrics();
        if (success) {
          alert("Identitet potvrđen biometrijom! 🔓 Podaci otključani.");
        }
      }
    });
  }

  // Autentifikacija (Auth Modal)
  const authBtn = document.getElementById('authBtn');
  if (authBtn) {
    authBtn.addEventListener('click', async () => {
      const user = await getCurrentUser();
      if (user) {
        if (confirm('Želite li se odjaviti?')) {
          await signOutUser();
          await checkAuthStatus();
        }
      } else {
        // Napuni polje sačuvanim ključem pri otvaranju modala
        const encInput = document.getElementById('encryptionKeyInput');
        if (encInput) encInput.value = getSecretKey();
        document.getElementById('authModal').classList.add('open');
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
      const encKey = document.getElementById('encryptionKeyInput')?.value;

      if (encKey) {
        setSecretKey(encKey);
      }

      try {
        if (isSignUpMode) {
          await signUpUser(email, password);
          alert('Registracija uspješna! Provjerite email za potvrdu.');
        } else {
          await signInUser(email, password);
          alert('Prijavljeni ste!');
          await syncLocationsWithCloud();
          updateMapMarkers();
          renderListView();
        }
        document.getElementById('authModal').classList.remove('open');
        await checkAuthStatus();
      } catch (err) {
        alert('Greška: ' + err.message);
      }
    });
  }
}

async function checkAuthStatus() {
  try {
    const user = await getCurrentUser();
    const authBtn = document.getElementById('authBtn');
    const syncStatus = document.getElementById('syncStatus');

    if (user) {
      if (authBtn) authBtn.innerText = 'Odjava (' + user.email.split('@')[0] + ')';
      if (syncStatus) syncStatus.innerText = '☁️ Povezano';
      
      // Pokreće dvosmjernu sinhronizaciju i odmah osvježava prikaz mapi i liste
      await syncLocationsWithCloud();
      updateMapMarkers();
      renderListView();
    } else {
      if (authBtn) authBtn.innerText = 'Prijava';
      if (syncStatus) syncStatus.innerText = '🔒 Lokalni rad';
      updateMapMarkers();
      renderListView();
    }
  } catch (err) {
    console.warn("Supabase auth nije konfigurisan ili nema mreže:", err);
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  
  document.getElementById(tabId).classList.add('active');
  
  if (tabId === 'map-view') {
    document.getElementById('tabMapBtn').classList.add('active');
    invalidateMapSize();
  } else {
    document.getElementById('tabListBtn').classList.add('active');
    renderListView();
  }
}

async function handleAddFormSubmit(e) {
  e.preventDefault();
  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const files = document.getElementById('imageInput').files;

  // Kompresija slika prije spremanja i slanja
  const imagePromises = Array.from(files).map(file => compressImage(file));
  const images = await Promise.all(imagePromises);

  saveLocation({ 
    id: Date.now().toString(), 
    lat, lng, title, description, 
    audio: getCurrentAudio(),
    images, 
    synced: false,
    timestamp: new Date().toISOString() 
  });

  resetAudioState();
  updateMapMarkers();
  document.getElementById('locationForm').reset();
  document.getElementById('gpsStatus').innerText = '';
  updateCounts();
  alert('Lokacija sačuvana!');

  // Pokušaj automatske sinhronizacije na cloud ako ima mreže
  await syncLocationsWithCloud();
  updateMapMarkers();
  renderListView();
}

function renderListView() {
  const grid = document.getElementById('gridContainer');
  if (!grid) return;
  
  grid.innerHTML = '';
  const search = document.getElementById('searchInput').value.toLowerCase();
  const sortBy = document.getElementById('sortSelect').value;
  const locations = getLocations();

  let filtered = locations.filter(l => (l.title || '').toLowerCase().includes(search) || (l.description || '').toLowerCase().includes(search));
  filtered.sort((a, b) => {
    if (sortBy === 'title_asc') return a.title.localeCompare(b.title);
    if (sortBy === 'oldest') return new Date(a.timestamp) - new Date(b.timestamp);
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  filtered.forEach(loc => {
    const card = document.createElement('div');
    card.className = 'card';
    card.addEventListener('click', () => openModal(loc.id));
    
    const hasImg = loc.images && loc.images.length > 0;
    const isSynced = loc.synced;

    card.innerHTML = `
      ${hasImg ? `<img src="${loc.images[0]}" class="card-thumb">` : ''}
      <div class="card-body">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="card-title">${loc.title}</div>
          <span title="${isSynced ? 'Sinhronizovano na cloud' : 'Čuva se samo u lokalu'}" style="font-size:12px;">
            ${isSynced ? '☁️' : '💾'}
          </span>
        </div>
        <div class="card-coords">${loc.lat}, ${loc.lng}</div>
        <div class="card-desc">${loc.description || 'Nema pisanog opisa.'}</div>
      </div>
      <div class="card-footer">
        <span style="font-size:11px; color:#64748b;">📷 ${hasImg ? loc.images.length : 0} ${loc.audio ? ' | 🎙️ Audio' : ''}</span>
        <button type="button" class="btn btn-secondary" style="font-size:10px; padding:3px 6px;">Detalji &rarr;</button>
      </div>
    `;
    grid.appendChild(card);
  });
  updateCounts();
}

function openModal(id) {
  const locations = getLocations();
  const loc = locations.find(l => String(l.id) === String(id)); 
  if (!loc) return;

  document.getElementById('modalTitle').innerText = loc.title;
  document.getElementById('modalCoords').innerText = `Koordinate: ${loc.lat}, ${loc.lng}`;
  document.getElementById('modalDesc').innerText = loc.description || 'Nema pisanog opisa.';
  
  const audioContainer = document.getElementById('modalAudioContainer');
  const audioPlayer = document.getElementById('modalAudioPlayer');
  if (loc.audio) {
    audioPlayer.src = loc.audio;
    audioContainer.style.display = 'block';
  } else {
    audioPlayer.src = '';
    audioContainer.style.display = 'none';
  }

  const gallery = document.getElementById('modalGallery'); 
  gallery.innerHTML = '';
  if (loc.images && loc.images.length > 0) {
    document.getElementById('modalImageCount').innerText = loc.images.length;
    loc.images.forEach(img => {
      const item = document.createElement('div'); 
      item.className = 'gallery-item';
      item.innerHTML = `<img src="${img}">`;
      item.querySelector('img').addEventListener('click', () => openImageFull(img));
      gallery.appendChild(item);
    });
  } else {
    document.getElementById('modalImageCount').innerText = '0';
    gallery.innerHTML = '<p style="color:#94a3b8; font-size:12px;">Nema slika.</p>';
  }

  document.getElementById('modalEditBtn').onclick = () => { closeModal('detailsModal'); openEditModal(loc.id); };
  document.getElementById('modalMapBtn').onclick = () => { closeModal('detailsModal'); switchTab('map-view'); centerMap(loc.lat, loc.lng); };
  document.getElementById('modalDeleteBtn').onclick = async () => { 
    if (confirm('Obrišite lokaciju?')) { 
      await deleteLocationFromDb(loc.id); 
      updateMapMarkers(); 
      renderListView(); 
      closeModal('detailsModal'); 
    } 
  };

  document.getElementById('detailsModal').classList.add('open');
}

function openEditModal(id) {
  const locations = getLocations();
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
    const item = document.createElement('div'); item.className = 'gallery-item';
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

  // Kompresija novih slika pri uređivanju
  const newImages = await Promise.all(Array.from(files).map(file => compressImage(file)));

  updateLocation(id, { lat, lng, title, description, images: [...currentEditingImages, ...newImages], synced: false });
  updateMapMarkers(); 
  renderListView(); 
  closeModal('editModal'); 
  openModal(id);

  await syncLocationsWithCloud();
  updateMapMarkers();
  renderListView();
}

function closeModal(id) { 
  document.getElementById(id).classList.remove('open'); 
  if (id === 'detailsModal') {
    document.getElementById('modalAudioPlayer').pause();
  }
}

function openImageFull(src) { 
  window.open("").document.write(`<body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${src}" style="max-width:100%;max-height:100vh;"></body>`); 
}

function updateCounts() { 
  const el = document.getElementById('tab-count');
  if (el) el.innerText = getLocations().length; 
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

// Pomoćna funkcija za smanjenje i kompresiju slika
function compressImage(file, maxWidth = 1600, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Skaliranje rezolucije uz očuvanje omjera (aspect ratio)
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Kompresija u JPEG format sa 70% kvaliteta
        const compressedBase64 = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedBase64);
      };
    };
  });
}

// Povezivanje modularnih funkcija sa globalnim window objektom za HTML događaje
window.switchTab = switchTab;
window.getCurrentLocation = getCurrentLocation;
window.toggleRecording = toggleRecording;
window.openModal = openModal;
window.closeModal = closeModal;
window.openEditModal = openEditModal;
window.openImageFull = openImageFull;
window.exportGeoJSON = exportGeoJSON;
window.exportCSV = exportCSV;