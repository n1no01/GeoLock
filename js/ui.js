import { getLocations, deleteLocationFromDb, updateLocation } from './db.js';
import { centerMap, invalidateMapSize, updateMapMarkers } from './map.js';
import { exportSingleLocationToDocx } from './export.js';
import { syncLocationsWithCloud } from './sync.js';
import * as mgrs from 'mgrs';

let currentEditingImages = [];
let currentEditingDocs = [];

// Pomoćne funkcije za multimediju
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve({ name: file.name, data: reader.result, size: file.size });
    reader.onerror = error => reject(error);
  });
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

function getDocIcon(filename) {
  if (!filename) return '📎';
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  return '📎';
}

function safeGetMgrs(latRaw, lngRaw) {
  try {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0)) {
      return mgrs.forward([lng, lat], 5);
    }
  } catch (e) {
    console.warn('MGRS konverzija greška:', latRaw, lngRaw);
  }
  return null;
}

export function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  if (tabId === 'map-view') {
    const mapBtn = document.getElementById('tabMapBtn');
    if (mapBtn) mapBtn.classList.add('active');
    invalidateMapSize();
  } else {
    const listBtn = document.getElementById('tabListBtn');
    if (listBtn) listBtn.classList.add('active');
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
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');

  const search = searchInput ? searchInput.value.toLowerCase() : '';
  const sortBy = sortSelect ? sortSelect.value : 'newest';

  const locations = await getLocations();

  let filtered = locations.filter(l => 
    (l.title || '').toLowerCase().includes(search) || 
    (l.description || '').toLowerCase().includes(search)
  );

  filtered.sort((a, b) => {
    if (sortBy === 'title_asc') return (a.title || '').localeCompare(b.title || '');
    if (sortBy === 'oldest') return new Date(a.timestamp) - new Date(b.timestamp);
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  filtered.forEach(loc => {
    const card = document.createElement('div');
    card.className = 'card';
    card.addEventListener('click', () => openModal(loc.id));

    const hasImg = loc.images && loc.images.length > 0;
    const hasDocs = loc.documents && loc.documents.length > 0;
    const isSynced = loc.synced;
    const mgrsText = safeGetMgrs(loc.lat, loc.lng);

    card.innerHTML = `
      ${hasImg ? `<img src="${loc.images[0]}" class="card-thumb" alt="Slika">` : ''}
      <div class="card-body">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="card-title"></div>
          <span title="${isSynced ? 'Sinhronizovano' : 'Lokalno'}" style="font-size:12px;">
            ${isSynced ? '☁️' : '💾'}
          </span>
        </div>
        <div class="card-coords">${loc.lat}, ${loc.lng}</div>
        ${mgrsText ? `<div class="card-coords" style="color: #0284c7; font-weight: 600; margin-top: -4px; margin-bottom: 8px;">MGRS: ${mgrsText}</div>` : ''}
        <div class="card-desc"></div>
      </div>
      <div class="card-footer">
        <span style="font-size:11px; color:#64748b;">
          📷 ${hasImg ? loc.images.length : 0} 
          ${hasDocs ? ` | 📄 ${loc.documents.length}` : ''} 
          ${loc.audio ? ' | 🎙️ Audio' : ''}
        </span>
        <button type="button" class="btn btn-secondary" style="font-size:10px; padding:3px 6px;">Detalji &rarr;</button>
      </div>
    `;

    card.querySelector('.card-title').textContent = loc.title || 'Bez naslova';
    card.querySelector('.card-desc').textContent = loc.description || 'Nema pisanog opisa.';

    grid.appendChild(card);
  });

  await updateCounts();
}

export async function openModal(id) {
  const locations = await getLocations();
  const loc = locations.find(l => String(l.id) === String(id));
  if (!loc) return;

  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = loc.title || 'Detalji lokacije';

  const mgrsText = safeGetMgrs(loc.lat, loc.lng);
  const modalMgrsText = mgrsText ? ` | MGRS: ${mgrsText}` : '';

  const coordsEl = document.getElementById('modalCoords');
  if (coordsEl) coordsEl.textContent = `Koordinate: ${loc.lat}, ${loc.lng}${modalMgrsText}`;

  const descEl = document.getElementById('modalDesc');
  if (descEl) descEl.textContent = loc.description || 'Nema pisanog opisa.';

  const audioContainer = document.getElementById('modalAudioContainer');
  const audioPlayer = document.getElementById('modalAudioPlayer');
  if (audioContainer && audioPlayer) {
    if (loc.audio) {
      audioPlayer.src = loc.audio;
      audioContainer.style.display = 'block';
    } else {
      audioPlayer.src = '';
      audioContainer.style.display = 'none';
    }
  }

  const docsContainer = document.getElementById('modalDocsContainer');
  if (docsContainer) {
    docsContainer.innerHTML = '';
    if (loc.documents && loc.documents.length > 0) {
      const header = document.createElement('h4');
      header.style.cssText = 'margin:12px 0 8px 0; font-size:13px; color:#475569; font-weight:600;';
      header.textContent = '📄 Priloženi dokumenti:';
      docsContainer.appendChild(header);

      loc.documents.forEach(doc => {
        const docCard = document.createElement('div');
        docCard.className = 'doc-card';

        const iconDiv = document.createElement('div');
        iconDiv.className = 'doc-icon';
        iconDiv.textContent = getDocIcon(doc.name);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'doc-info';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'doc-name';
        nameSpan.title = doc.name;
        nameSpan.textContent = doc.name;

        infoDiv.appendChild(nameSpan);

        const downloadLink = document.createElement('a');
        downloadLink.href = doc.data;
        downloadLink.download = doc.name;
        downloadLink.className = 'doc-download-btn';
        downloadLink.innerHTML = `<span>Preuzmi</span>`;

        docCard.appendChild(iconDiv);
        docCard.appendChild(infoDiv);
        docCard.appendChild(downloadLink);
        docsContainer.appendChild(docCard);
      });
    }
  }

  const gallery = document.getElementById('modalGallery');
  const countEl = document.getElementById('modalImageCount');
  if (gallery) {
    gallery.innerHTML = '';
    if (loc.images && loc.images.length > 0) {
      if (countEl) countEl.innerText = loc.images.length;
      loc.images.forEach(img => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        const imgEl = document.createElement('img');
        imgEl.src = img;
        imgEl.addEventListener('click', () => openImageFull(img));
        item.appendChild(imgEl);
        gallery.appendChild(item);
      });
    } else {
      if (countEl) countEl.innerText = '0';
      gallery.innerHTML = '<p style="color:#94a3b8; font-size:12px;">Nema slika.</p>';
    }
  }

  const docxBtn = document.getElementById('modalDocxBtn');
  if (docxBtn) docxBtn.onclick = () => exportSingleLocationToDocx(loc.id);

  // DIREKTAN POZIV ZA EDIT MODAL (BEZ WINDOW OBJEKTA)
  const editBtn = document.getElementById('modalEditBtn');
  if (editBtn) {
    editBtn.onclick = () => {
      closeModal('detailsModal');
      openEditModal(loc.id);
    };
  }

  const mapBtn = document.getElementById('modalMapBtn');
  if (mapBtn) {
    mapBtn.onclick = () => {
      closeModal('detailsModal');
      switchTab('map-view');
      centerMap(loc.lat, loc.lng);
    };
  }

  const deleteBtn = document.getElementById('modalDeleteBtn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (confirm('Obrišite lokaciju?')) {
        await deleteLocationFromDb(loc.id);
        await updateMapMarkers();
        await renderListView();
        closeModal('detailsModal');
      }
    };
  }

  const detailsModal = document.getElementById('detailsModal');
  if (detailsModal) detailsModal.classList.add('open');
}

// LOGIKA ZA EDIT MODAL PREBAČENA U UI.JS
export async function openEditModal(id) {
  const locations = await getLocations();
  const loc = locations.find(l => String(l.id) === String(id));
  if (!loc) return;

  const editId = document.getElementById('editId');
  const editLat = document.getElementById('editLat');
  const editLng = document.getElementById('editLng');
  const editTitle = document.getElementById('editTitle');
  const editDesc = document.getElementById('editDescription');

  if (editId) editId.value = loc.id;
  if (editLat) editLat.value = loc.lat;
  if (editLng) editLng.value = loc.lng;
  if (editTitle) editTitle.value = loc.title;
  if (editDesc) editDesc.value = loc.description || '';

  const editMgrsInput = document.getElementById('editMgrsInput');
  if (editMgrsInput) {
    const mgrsVal = safeGetMgrs(loc.lat, loc.lng);
    editMgrsInput.value = mgrsVal || '';
  }

  currentEditingImages = loc.images ? [...loc.images] : [];
  renderEditGallery();

  currentEditingDocs = loc.documents ? [...loc.documents] : [];
  renderEditDocs();

  openModalElement('editModal');
}

export function renderEditGallery() {
  const gallery = document.getElementById('editExistingGallery');
  if (!gallery) return;
  gallery.innerHTML = '';
  currentEditingImages.forEach((img, index) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    
    const imgEl = document.createElement('img');
    imgEl.src = img;
    
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'delete-img-btn';
    delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', () => {
      currentEditingImages.splice(index, 1);
      renderEditGallery();
    });

    item.appendChild(imgEl);
    item.appendChild(delBtn);
    gallery.appendChild(item);
  });
}

export function renderEditDocs() {
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
    
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%;';
    nameSpan.textContent = `📄 ${doc.name}`;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.style.cssText = 'font-size:10px; padding:2px 6px;';
    delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', () => {
      currentEditingDocs.splice(index, 1);
      renderEditDocs();
    });

    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    docsContainer.appendChild(item);
  });
}

export async function handleEditFormSubmit(e) {
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
      try { await syncLocationsWithCloud(); } catch (err) {}
    }

    await updateMapMarkers();
    await renderListView();

  } catch (err) {
    console.error("Greška pri izmjeni lokacije:", err);
    showToast("Greška pri spašavanju izmjena.", "error");
  }
}

function openModalElement(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}

export function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
  if (id === 'detailsModal') {
    const player = document.getElementById('modalAudioPlayer');
    if (player) player.pause();
  }
}

export function openImageFull(src) {
  const newWin = window.open();
  if (newWin) {
    newWin.document.write(`
      <!DOCTYPE html>
      <html>
        <head><title>Pregled slike</title></head>
        <body style="margin:0; background:#000; display:flex; justify-content:center; align-items:center; height:100vh;">
          <img src="${src}" style="max-width:100%; max-height:100vh; object-fit:contain;">
        </body>
      </html>
    `);
    newWin.document.close();
  }
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

window.openEditModal = openEditModal;
window.closeModal = closeModal;