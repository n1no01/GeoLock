// Izmjena postojeće lokacije. Ovo je JEDINA implementacija (ranije su postojale dvije kopije u
// app.js i ui.js sa odvojenim stanjem, zbog čega je svako čuvanje brisalo postojeće priloge).

import { getLocation, putLocation } from './db.js';
import {
  openModalElement, closeModal, registerEditHandler, refreshViews
} from './ui.js';
import { syncLocationsWithCloud } from './sync.js';
import { getMediaUrl, compressImage, assertDocumentSize } from './media.js';
import { bindCoordinateInputs, toMgrs } from './coords.js';
import { isValidLatLng, uuid } from './utils.js';
import { showToast } from './toast.js';

const $ = (id) => document.getElementById(id);

// Stanje izmjene — jedno mjesto, bez duplikata
let state = null; // { original, images:[mediaId], documents:[{id,name}], removedIds:Set }

export function initEdit() {
  registerEditHandler(openEditModal);

  bindCoordinateInputs({
    latEl: $('editLat'),
    lngEl: $('editLng'),
    mgrsEl: $('editMgrsInput')
  });

  $('editForm')?.addEventListener('submit', handleEditSubmit);
}

export async function openEditModal(id) {
  const loc = await getLocation(id);
  if (!loc) return;
  if (loc.undecryptable) {
    showToast('Zapis nije moguće urediti jer ga nije moguće dešifrovati.', 'error');
    return;
  }

  state = {
    original: loc,
    images: [...loc.images],
    documents: loc.documents.map((d) => ({ ...d })),
    removedIds: new Set()
  };

  $('editId').value = loc.id;
  $('editLat').value = loc.lat;
  $('editLng').value = loc.lng;
  $('editMgrsInput').value = toMgrs(loc.lat, loc.lng) ?? '';
  $('editTitle').value = loc.title;
  $('editDescription').value = loc.description || '';
  $('editNewImages').value = '';
  $('editNewDocs').value = '';

  renderGallery();
  renderDocs();
  openModalElement('editModal');
}

function renderGallery() {
  const gallery = $('editExistingGallery');
  gallery.replaceChildren();
  if (state.images.length === 0) {
    const p = document.createElement('span');
    p.className = 'muted';
    p.textContent = 'Nema slika.';
    gallery.append(p);
    return;
  }

  for (const mediaId of state.images) {
    const item = document.createElement('div');
    item.className = 'gallery-item';

    const img = document.createElement('img');
    img.alt = 'Postojeća fotografija';
    getMediaUrl(mediaId).then((url) => { if (url) img.src = url; }).catch(() => { img.alt = 'Slika nije dostupna'; });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-img-btn';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Ukloni fotografiju');
    del.addEventListener('click', () => {
      state.images = state.images.filter((id) => id !== mediaId);
      state.removedIds.add(mediaId);
      renderGallery();
    });

    item.append(img, del);
    gallery.append(item);
  }
}

function renderDocs() {
  const container = $('editExistingDocs');
  container.replaceChildren();
  if (state.documents.length === 0) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'Nema priloženih dokumenata.';
    container.append(span);
    return;
  }

  for (const doc of state.documents) {
    const row = document.createElement('div');
    row.className = 'edit-doc-row';

    const name = document.createElement('span');
    name.className = 'edit-doc-name';
    name.textContent = `📄 ${doc.name}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger btn-small';
    del.textContent = '×';
    del.setAttribute('aria-label', `Ukloni dokument ${doc.name}`);
    del.addEventListener('click', () => {
      state.documents = state.documents.filter((d) => d.id !== doc.id);
      state.removedIds.add(doc.id);
      renderDocs();
    });

    row.append(name, del);
    container.append(row);
  }
}

async function handleEditSubmit(e) {
  e.preventDefault();
  if (!state) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const lat = parseFloat($('editLat').value);
  const lng = parseFloat($('editLng').value);
  const title = $('editTitle').value.trim();

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
    const original = state.original;
    const locationId = original.id;
    const addMedia = [];
    const newImageIds = [];
    const newDocs = [];

    for (const file of $('editNewImages').files) {
      const blob = await compressImage(file);
      const id = uuid();
      addMedia.push({ id, locationId, mime: 'image/jpeg', blob });
      newImageIds.push(id);
    }
    for (const file of $('editNewDocs').files) {
      assertDocumentSize(file);
      const id = uuid();
      addMedia.push({ id, locationId, mime: file.type || 'application/octet-stream', blob: file });
      newDocs.push({ id, name: file.name });
    }

    const coordsChanged = lat !== original.lat || lng !== original.lng;

    await putLocation({
      id: locationId,
      title,
      description: $('editDescription').value,
      lat,
      lng,
      accuracy: coordsChanged ? null : original.accuracy,
      createdAt: original.createdAt, // vrijeme prvobitnog zapisa se čuva
      updatedAt: new Date().toISOString(),
      images: [...state.images, ...newImageIds],
      audio: original.audio,
      documents: [...state.documents, ...newDocs]
    }, { addMedia, removeMediaIds: [...state.removedIds] });

    closeModal('editModal');
    state = null;
    showToast('Izmjena sačuvana!', 'success');
    await refreshViews();
    syncLocationsWithCloud({ silent: true }).catch(() => {});
  } catch (err) {
    console.error('Greška pri izmjeni lokacije:', err);
    showToast(err?.name === 'QuotaExceededError'
      ? 'Nema dovoljno slobodnog prostora na uređaju.'
      : (err?.message || 'Greška pri spremanju izmjena.'), 'error');
  } finally {
    submitBtn.disabled = false;
  }
}
