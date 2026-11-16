// Leaf modul (bez importa) — koristi ga svako ko treba obavijestiti korisnika,
// čime se izbjegavaju ciklične zavisnosti između ui.js i sync.js.

let hideTimer = null;

export function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;

  const icons = { info: 'ℹ️', success: '✅', error: '⚠️' };
  toast.replaceChildren();

  const icon = document.createElement('span');
  icon.textContent = icons[type] || '';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, ' ', text);

  toast.className = `toast-notification ${type} show`;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

export function setSyncStatus(text) {
  const el = document.getElementById('syncStatus');
  if (el) el.textContent = text;
}
