import { getLocations, deleteLocationFromDb } from './db.js';
import { centerMap, invalidateMapSize, updateMapMarkers } from './map.js';
import { syncLocationsWithCloud } from './sync.js';
import * as mgrs from 'mgrs';

export function switchTab(tabId) {
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

export async function updateCounts() {
  const el = document.getElementById('tab-count');
  if (el) {
    const locations = await getLocations();
    el.innerText = locations.length;
  }
}

export async function renderListView() {
  const grid = document.getElementById('gridContainer');
  if (!grid) return;

  grid.innerHTML = '';
  const search = document.getElementById('searchInput').value.toLowerCase();
  const sortBy = document.getElementById('sortSelect').value;

  const locations = await getLocations();

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

    let mgrsText = '';
    try {
      const lat = parseFloat(loc.lat);
      const lng = parseFloat(loc.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        mgrsText = mgrs.forward([lng, lat], 5);
      }
    } catch (e) {
      mgrsText = '';
    }

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
        ${mgrsText ? `<div class="card-coords" style="color: #0284c7; font-weight: 600; margin-top: -4px; margin-bottom: 8px;">MGRS: ${mgrsText}</div>` : ''}
        <div class="card-desc">${loc.description || 'Nema pisanog opisa.'}</div>
      </div>
      <div class="card-footer">
        <span style="font-size:11px; color:#64748b;">📷 ${hasImg ? loc.images.length : 0} ${loc.audio ? ' | 🎙️ Audio' : ''}</span>
        <button type="button" class="btn btn-secondary" style="font-size:10px; padding:3px 6px;">Detalji &rarr;</button>
      </div>
    `;
    grid.appendChild(card);
  });
  await updateCounts();
}

export async function openModal(id) {
  const locations = await getLocations();
  const loc = locations.find(l => String(l.id) === String(id));
  if (!loc) return;

  document.getElementById('modalTitle').innerText = loc.title;
  
  let modalMgrsText = '';
  try {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);
    if (!isNaN(lat) && !isNaN(lng)) {
      modalMgrsText = ` | MGRS: ${mgrs.forward([lng, lat], 5)}`;
    }
  } catch(e) {}

  document.getElementById('modalCoords').innerText = `Koordinate: ${loc.lat}, ${loc.lng}${modalMgrsText}`;
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

  document.getElementById('modalEditBtn').onclick = () => { closeModal('detailsModal'); window.openEditModal(loc.id); };
  document.getElementById('modalMapBtn').onclick = () => { closeModal('detailsModal'); switchTab('map-view'); centerMap(loc.lat, loc.lng); };
  document.getElementById('modalDeleteBtn').onclick = async () => {
    if (confirm('Obrišite lokaciju?')) {
      await deleteLocationFromDb(loc.id);
      await updateMapMarkers();
      await renderListView();
      closeModal('detailsModal');
    }
  };

  document.getElementById('detailsModal').classList.add('open');
}

export function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'detailsModal') {
    const player = document.getElementById('modalAudioPlayer');
    if (player) player.pause();
  }
}

export function openImageFull(src) {
  window.open("").document.write(`<body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${src}" style="max-width:100%;max-height:100vh;"></body>`);
}

export function showToast(message, type = 'info', duration = 2500) {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;

  const icons = { info: 'ℹ️', success: '✅', error: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span> <span>${message}</span>`;
  toast.className = `toast-notification ${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}