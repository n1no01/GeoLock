// Prikaz: tabovi, lista, detalji, dijalozi, modali (fokus, Esc, tab-trap), lightbox.
// Nijedan korisnički podatak se ne ubacuje kroz innerHTML — samo textContent / atributi.

import { getLocation, getLocations, deleteLocation, countLocations } from './db.js';
import { centerMap, invalidateMapSize, updateMapMarkers } from './map.js';
import { exportSingleLocationToDocx } from './export.js';
import { syncLocationsWithCloud } from './sync.js';
import { getMediaUrl, getMediaBlobEnsured, downloadBlob } from './media.js';
import { showToast } from './toast.js';
import { hasActiveKey } from './crypto.js';
import { toMgrs } from './coords.js';
import { safeFileName } from './utils.js';

const $ = (id) => document.getElementById(id);

// ---------- Mali DOM helper ----------

function el(tag, { className, text, attrs, on } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (on) for (const [evt, fn] of Object.entries(on)) node.addEventListener(evt, fn);
  node.append(...children);
  return node;
}

// ---------- Modali: otvaranje, zatvaranje, fokus ----------

const modalStack = [];
const lastFocus = new WeakMap();
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModalElement(id) {
  const modal = $(id);
  if (!modal) return;
  lastFocus.set(modal, document.activeElement);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  if (!modalStack.includes(id)) modalStack.push(id);
  setTimeout(() => {
    const first = modal.querySelector('[autofocus]') || modal.querySelector(FOCUSABLE);
    first?.focus();
  }, 0);
}

export function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  const idx = modalStack.indexOf(id);
  if (idx >= 0) modalStack.splice(idx, 1);
  if (id === 'detailsModal') $('modalAudioPlayer')?.pause();
  if (id === 'lightboxModal') $('lightboxImg')?.removeAttribute('src');
  const prev = lastFocus.get(modal);
  if (prev && document.contains(prev) && modalStack.length === 0) prev.focus?.();
}

export function isModalOpen(id) {
  return $(id)?.classList.contains('open') ?? false;
}

/** Jednokratna inicijalizacija: dugmad za zatvaranje, klik na pozadinu, Esc, hvatanje Tab-a. */
export function initModals() {
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      closeModal(closeBtn.dataset.closeModal);
      return;
    }
    const backdrop = e.target.classList?.contains('modal-backdrop') ? e.target : null;
    if (backdrop && backdrop.dataset.persistent === undefined) {
      if (backdrop.id === 'dialogModal') {
        if (!$('dialogCancel').hidden) $('dialogCancel').click();
      } else {
        closeModal(backdrop.id);
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    const topId = modalStack[modalStack.length - 1];
    if (!topId) return;
    const modal = $(topId);

    if (e.key === 'Escape') {
      if (topId === 'dialogModal') {
        if (!$('dialogCancel').hidden) $('dialogCancel').click();
      } else if (modal.dataset.persistent === undefined) {
        closeModal(topId);
      }
      return;
    }

    if (e.key === 'Tab') {
      const focusable = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

// ---------- Dijalog (zamjena za alert / confirm / prompt) ----------

let dialogQueue = Promise.resolve();

/**
 * @returns Promise<{ok:boolean, value:string}>
 * Opcije: title, message, input{label,type,value,placeholder,autocomplete}, readonlyText (+ copy),
 *         requireCheck (tekst potvrde), okText, cancelText, showCancel, danger
 */
export function showDialog(opts) {
  const run = () => new Promise((resolve) => {
    const {
      title = '', message = '', input = null, readonlyText = null, requireCheck = null,
      okText = 'U redu', cancelText = 'Odustani', showCancel = true, danger = false
    } = opts;

    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogMessage').hidden = !message;

    const inputWrap = $('dialogInputWrap');
    const inputEl = $('dialogInput');
    inputWrap.hidden = !input;
    inputEl.value = '';
    if (input) {
      $('dialogInputLabel').textContent = input.label || '';
      inputEl.type = input.type || 'text';
      inputEl.value = input.value || '';
      inputEl.placeholder = input.placeholder || '';
      inputEl.autocomplete = input.autocomplete || 'off';
      inputEl.required = input.required !== false;
    } else {
      inputEl.required = false;
    }

    const readonlyWrap = $('dialogReadonlyWrap');
    readonlyWrap.hidden = !readonlyText;
    $('dialogReadonly').value = readonlyText || '';

    const checkWrap = $('dialogCheckWrap');
    const checkEl = $('dialogCheck');
    checkWrap.hidden = !requireCheck;
    checkEl.checked = false;
    $('dialogCheckLabel').textContent = requireCheck || '';

    const okBtn = $('dialogOk');
    const cancelBtn = $('dialogCancel');
    okBtn.textContent = okText;
    okBtn.className = `btn ${danger ? 'btn-danger' : ''}`.trim();
    okBtn.disabled = !!requireCheck;
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = !showCancel;

    const form = $('dialogForm');
    const copyBtn = $('dialogCopyBtn');

    const cleanup = () => {
      form.onsubmit = null;
      cancelBtn.onclick = null;
      copyBtn.onclick = null;
      checkEl.onchange = null;
    };
    const finish = (ok) => {
      const value = inputEl.value;
      cleanup();
      inputEl.value = '';
      $('dialogReadonly').value = '';
      closeModal('dialogModal');
      resolve({ ok, value });
    };

    form.onsubmit = (e) => { e.preventDefault(); if (!okBtn.disabled) finish(true); };
    cancelBtn.onclick = () => finish(false);
    checkEl.onchange = () => { okBtn.disabled = !checkEl.checked; };
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText($('dialogReadonly').value);
        showToast('Kopirano.', 'success', 1500);
      } catch {
        $('dialogReadonly').select();
      }
    };

    openModalElement('dialogModal');
    if (input) setTimeout(() => inputEl.focus(), 30);
  });

  dialogQueue = dialogQueue.then(run, run);
  return dialogQueue;
}

// ---------- Tabovi ----------

export function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach((n) => n.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((n) => {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });

  $(tabId)?.classList.add('active');
  const btn = tabId === 'map-view' ? $('tabMapBtn') : $('tabListBtn');
  btn?.classList.add('active');
  btn?.setAttribute('aria-selected', 'true');

  if (tabId === 'map-view') invalidateMapSize();
  else renderListView();
}

export async function updateCounts() {
  const counter = $('tab-count');
  if (counter) counter.textContent = hasActiveKey() ? String(await countLocations()) : '0';
}

// ---------- Lista ----------

let renderToken = 0;
let thumbObserver = null;

function getThumbObserver() {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        const img = entry.target;
        getMediaUrl(img.dataset.mediaId)
          .then((url) => { if (url) img.src = url; })
          .catch(() => { img.alt = 'Slika nije dostupna (offline?)'; });
      }
    }, { rootMargin: '200px' });
  }
  return thumbObserver;
}

function formatCoords(loc) {
  return Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? `${loc.lat}, ${loc.lng}` : '—';
}

export async function renderListView() {
  const grid = $('gridContainer');
  if (!grid) return;

  const token = ++renderToken;
  const search = ($('searchInput')?.value || '').toLowerCase();
  const sortBy = $('sortSelect')?.value || 'newest';

  const locations = await getLocations();
  if (token !== renderToken) return; // pristigao je noviji poziv

  const filtered = locations.filter((l) =>
    (l.title || '').toLowerCase().includes(search) || (l.description || '').toLowerCase().includes(search));

  filtered.sort((a, b) => {
    if (sortBy === 'title_asc') return (a.title || '').localeCompare(b.title || '', 'bs');
    const diff = new Date(a.createdAt) - new Date(b.createdAt);
    return sortBy === 'oldest' ? diff : -diff;
  });

  const cards = filtered.map((loc) => {
    const mgrsText = toMgrs(loc.lat, loc.lng);
    const card = el('div', { className: 'card', on: { click: () => openDetails(loc.id) } });

    if (loc.images.length > 0) {
      const thumb = el('img', { className: 'card-thumb', attrs: { alt: 'Fotografija lokacije', loading: 'lazy' } });
      thumb.dataset.mediaId = loc.images[0];
      getThumbObserver().observe(thumb);
      card.append(thumb);
    }

    const body = el('div', { className: 'card-body' },
      el('div', { className: 'card-row' },
        el('div', { className: 'card-title', text: loc.title || 'Bez naslova' }),
        el('span', {
          text: loc.synced ? '☁️' : '💾',
          attrs: { title: loc.synced ? 'Sinhronizovano' : 'Samo lokalno', role: 'img', 'aria-label': loc.synced ? 'Sinhronizovano' : 'Samo lokalno' }
        })),
      el('div', { className: 'card-coords', text: formatCoords(loc) }));
    if (mgrsText) body.append(el('div', { className: 'card-coords card-mgrs', text: `MGRS: ${mgrsText}` }));
    body.append(el('div', { className: 'card-desc', text: loc.description || 'Nema pisanog opisa.' }));

    const counts = `📷 ${loc.images.length}${loc.documents.length ? ` | 📄 ${loc.documents.length}` : ''}${loc.audio ? ' | 🎙️ Audio' : ''}`;
    const footer = el('div', { className: 'card-footer' },
      el('span', { className: 'card-counts', text: counts }),
      el('button', {
        className: 'btn btn-secondary btn-small',
        text: 'Detalji →',
        attrs: { type: 'button', 'aria-label': `Detalji: ${loc.title || 'Bez naslova'}` }
      }));

    card.append(body, footer);
    return card;
  });

  if (cards.length === 0) {
    grid.replaceChildren(el('p', { className: 'empty-state', text: locations.length ? 'Nema rezultata pretrage.' : 'Još nema sačuvanih lokacija.' }));
  } else {
    grid.replaceChildren(...cards);
  }
  await updateCounts();
}

/** Prazan prikaz dok je aplikacija zaključana. */
export function clearListView() {
  renderToken++;
  $('gridContainer')?.replaceChildren();
  const counter = $('tab-count');
  if (counter) counter.textContent = '0';
}

// ---------- Detalji ----------

export async function openDetails(id) {
  const loc = await getLocation(id);
  if (!loc) return;

  $('modalTitle').textContent = loc.title || 'Detalji lokacije';

  const mgrsText = toMgrs(loc.lat, loc.lng);
  const parts = [`Koordinate: ${formatCoords(loc)}`];
  if (mgrsText) parts.push(`MGRS: ${mgrsText}`);
  if (loc.accuracy) parts.push(`±${Math.round(loc.accuracy)} m`);
  $('modalCoords').textContent = parts.join(' | ');

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('bs') : '—');
  $('modalDates').textContent = `Zabilježeno: ${fmt(loc.createdAt)}${loc.updatedAt !== loc.createdAt ? ` · Izmijenjeno: ${fmt(loc.updatedAt)}` : ''}`;
  $('modalDesc').textContent = loc.description || 'Nema pisanog opisa.';

  // Audio
  const audioContainer = $('modalAudioContainer');
  const audioPlayer = $('modalAudioPlayer');
  audioPlayer.removeAttribute('src');
  audioContainer.hidden = true;
  if (loc.audio) {
    audioContainer.hidden = false;
    getMediaUrl(loc.audio)
      .then((url) => { if (url) audioPlayer.src = url; })
      .catch(() => showToast('Audio nije dostupan (potrebna je konekcija za preuzimanje).', 'error'));
  }

  // Dokumenti
  const docsContainer = $('modalDocsContainer');
  docsContainer.replaceChildren();
  if (loc.documents.length > 0) {
    docsContainer.append(el('h4', { className: 'section-title', text: '📄 Priloženi dokumenti:' }));
    for (const doc of loc.documents) {
      docsContainer.append(el('div', { className: 'doc-card' },
        el('div', { className: 'doc-icon', text: getDocIcon(doc.name), attrs: { 'aria-hidden': 'true' } }),
        el('div', { className: 'doc-info' }, el('span', { className: 'doc-name', text: doc.name, attrs: { title: doc.name } })),
        el('button', {
          className: 'doc-download-btn',
          text: 'Preuzmi',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              try {
                const blob = await getMediaBlobEnsured(doc.id);
                if (!blob) throw new Error('Dokument nije dostupan.');
                downloadBlob(blob, safeFileName(doc.name, 'dokument'));
              } catch (err) {
                showToast(err.message || 'Preuzimanje nije uspjelo.', 'error');
              }
            }
          }
        })));
    }
  }

  // Galerija
  const gallery = $('modalGallery');
  gallery.replaceChildren();
  $('modalImageCount').textContent = String(loc.images.length);
  if (loc.images.length === 0) {
    gallery.append(el('p', { className: 'muted', text: 'Nema slika.' }));
  } else {
    for (const mediaId of loc.images) {
      const img = el('img', { attrs: { alt: 'Fotografija s terena', tabindex: '0', role: 'button' } });
      getMediaUrl(mediaId)
        .then((url) => {
          if (!url) return;
          img.src = url;
          const open = () => openLightbox(url);
          img.addEventListener('click', open);
          img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        })
        .catch(() => { img.alt = 'Slika nije dostupna (offline?)'; });
      gallery.append(el('div', { className: 'gallery-item' }, img));
    }
  }

  // Akcije
  $('modalDocxBtn').onclick = () => exportSingleLocationToDocx(loc.id);
  $('modalEditBtn').onclick = () => {
    closeModal('detailsModal');
    editHandler(loc.id);
  };
  $('modalMapBtn').onclick = () => {
    closeModal('detailsModal');
    switchTab('map-view');
    centerMap(loc.lat, loc.lng);
  };
  $('modalDeleteBtn').onclick = () => confirmAndDelete(loc);

  openModalElement('detailsModal');
}

async function confirmAndDelete(loc) {
  const { ok } = await showDialog({
    title: 'Brisanje lokacije',
    message: `Trajno obrisati "${loc.title}" zajedno sa svim prilozima? Ova radnja se ne može poništiti.`,
    okText: 'Obriši',
    danger: true
  });
  if (!ok) return;

  try {
    await deleteLocation(loc.id);
  } catch (err) {
    console.error(err);
    showToast('Brisanje nije uspjelo.', 'error');
    return;
  }
  closeModal('detailsModal');
  await updateMapMarkers();
  await renderListView();
  showToast('Lokacija obrisana.', 'success');
  syncLocationsWithCloud({ silent: true }).catch(() => {});
}

// Edit modal živi u edit.js; registruje se ovdje da ui.js ne zavisi od njega (bez cikličnih importa).
let editHandler = () => {};
export function registerEditHandler(fn) { editHandler = fn; }

function getDocIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  return '📎';
}

// ---------- Lightbox (umjesto window.open + document.write) ----------

export function openLightbox(url) {
  $('lightboxImg').src = url;
  openModalElement('lightboxModal');
}

/** Osvježi mapu i listu (poziva se nakon svake promjene podataka). */
export async function refreshViews() {
  await Promise.all([updateMapMarkers(), renderListView()]);
}
