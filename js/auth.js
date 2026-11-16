// Tok prijave / otključavanja.
//
// Dva odvojena pojma:
//   - SESIJA (Supabase)  – dokazuje ko je korisnik prema cloudu; čuva je supabase-js.
//   - KLJUČ (DEK)        – otključava podatke; živi SAMO u memoriji.
// Nakon osvježavanja stranice sesija ostaje, ali je aplikacija zaključana dok se ne unese
// lozinka ili ne iskoristi biometrija.

import {
  signUpUser, signInUser, signOutUser, getCurrentUser, enforceSessionOnly, sendPasswordReset,
  updateUserPassword
} from './supabase.js';
import {
  hasActiveKey, setActiveKey, getActiveKey, setLegacyKey, clearKeys, deriveLegacyKey,
  purgeLegacyStorage, DecryptionError
} from './crypto.js';
import {
  unlockWithPassword, unlockWithRecovery, fetchCloudKeyring, loadLocalKeyring, clearLocalKeyring,
  rewrapPassword, regenerateRecoveryKey, verifyPassword, deleteCloudKeyring
} from './keyring.js';
import {
  isBiometricsAvailable, isBiometricsEnabled, registerBiometrics, unlockWithBiometrics, removeBiometrics
} from './biometrics.js';
import { listSyncState, wipeDatabase, migrateLegacyLocal } from './db.js';
import { syncLocationsWithCloud, wipeCloudData } from './sync.js';
import { revokeAllMediaUrls } from './media.js';
import { showToast, setSyncStatus } from './toast.js';
import { openModalElement, closeModal, showDialog, isModalOpen, refreshViews, clearListView } from './ui.js';
import { isEmail } from './utils.js';

const $ = (id) => document.getElementById(id);

const MIN_PASSWORD_LENGTH = 10;
const AUTO_LOCK_MS = 15 * 60 * 1000; // zaključavanje nakon 15 min u pozadini
const BIO_DECLINED_FLAG = 'geolock_bio_declined';
const OVERLAY_MODALS = ['detailsModal', 'editModal', 'lightboxModal', 'securityModal'];

let mode = 'login'; // 'login' | 'register' | 'unlock'
let busy = false;
let hiddenAt = null;

export function isAuthBusy() { return busy; }
export function isUnlocked() { return hasActiveKey(); }

// ---------- Poruke ----------

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (err instanceof DecryptionError) return msg;
  if (/invalid login credentials/i.test(msg)) return 'Pogrešan email ili lozinka.';
  if (/email not confirmed/i.test(msg)) return 'Email adresa nije potvrđena. Provjerite inbox.';
  if (/already registered|already been registered/i.test(msg)) return 'Račun s ovom email adresom već postoji.';
  if (/rate limit|too many/i.test(msg)) return 'Previše pokušaja. Pričekajte malo pa pokušajte ponovo.';
  if (/password should be|weak/i.test(msg)) return 'Lozinka je preslaba.';
  return msg || 'Došlo je do greške.';
}

const isNetworkError = (err) => !navigator.onLine
  || err?.name === 'AuthRetryableFetchError'
  || /failed to fetch|network|load failed/i.test(String(err?.message || ''));

function setBusy(value) {
  busy = value;
  const btn = $('authSubmitBtn');
  btn.disabled = value;
  if (value) btn.dataset.label = btn.textContent;
  btn.textContent = value ? 'Obrada…' : (btn.dataset.label || btn.textContent);
}

// ---------- Prikaz modala ----------

function setAuthMode(next, { email = '' } = {}) {
  mode = next;
  const isRegister = next === 'register';
  const isUnlock = next === 'unlock';

  $('authTitle').textContent = isUnlock ? 'Aplikacija je zaključana' : isRegister ? 'Registracija' : 'Korisnička prijava';
  $('authSubmitBtn').textContent = isUnlock ? 'Otključaj' : isRegister ? 'Registruj se' : 'Prijavi se';
  $('authSubmitBtn').dataset.label = $('authSubmitBtn').textContent;

  $('authEmailGroup').hidden = isUnlock;
  $('authEmail').required = !isUnlock;
  if (email) $('authEmail').value = email;

  $('authPassword').autocomplete = isRegister ? 'new-password' : 'current-password';
  $('authPassword').minLength = isRegister ? MIN_PASSWORD_LENGTH : 1;
  $('authPasswordHelp').hidden = !isRegister;

  $('rememberMeGroup').hidden = next !== 'login';
  $('toggleAuthMode').hidden = isUnlock;
  $('forgotPassword').hidden = isRegister;
  $('authSwitchAccount').hidden = !isUnlock;
  $('toggleAuthMode').textContent = isRegister ? 'Već imate račun? Prijavite se' : 'Nemate račun? Registrujte se';

  const hint = $('authHint');
  hint.hidden = !isUnlock;
  hint.textContent = isUnlock && email ? `Račun: ${email}` : '';

  $('authPassword').value = '';
}

async function refreshBioButton() {
  const show = mode !== 'register' && isBiometricsEnabled();
  $('bioFastLoginContainer').hidden = !show;
}

function showAuthModal(canClose) {
  const modal = $('authModal');
  if (canClose) delete modal.dataset.persistent;
  else modal.dataset.persistent = '';
  $('authCloseBtn').hidden = !canClose;
  refreshBioButton();
  if (!isModalOpen('authModal')) openModalElement('authModal');
}

function setLockedUi(locked) {
  const main = $('appMain');
  main.classList.toggle('locked', locked);
  main.inert = locked;
}

function updateHeader(user) {
  const unlocked = hasActiveKey();
  $('lockBtn').hidden = !unlocked;
  $('securityBtn').hidden = !unlocked;
  $('authBtn').textContent = user ? 'Odjava' : 'Prijava';
  $('authBtn').hidden = !unlocked && !user && isModalOpen('authModal');

  if (!unlocked) setSyncStatus('🔒 Zaključano');
  else if (!user) setSyncStatus('🔒 Lokalno (prijavite se za cloud)');
}

// ---------- Glavna provjera stanja ----------

export async function checkAuthStatus() {
  if (busy) return;
  const user = await getCurrentUser();

  if (hasActiveKey()) {
    setLockedUi(false);
    updateHeader(user);
    if (isModalOpen('authModal') && $('authModal').dataset.persistent !== undefined) closeModal('authModal');
    return;
  }

  // Zaključano
  for (const id of OVERLAY_MODALS) closeModal(id);
  revokeAllMediaUrls();
  clearListView();
  setLockedUi(true);
  updateHeader(user);
  await refreshViews(); // prazno dok je zaključano

  const local = loadLocalKeyring();
  const email = user?.email || local?.email || '';
  if (user || local) setAuthMode('unlock', { email });
  else setAuthMode('login');
  showAuthModal(false);
  setTimeout(() => $('authPassword').focus(), 50);
}

// ---------- Otključavanje ----------

async function guardAccountSwitch(user) {
  const local = loadLocalKeyring();
  if (!local || local.userId === user.id) return true;

  const unsynced = (await listSyncState()).filter((s) => !s.synced).length;
  const { ok } = await showDialog({
    title: 'Drugi račun na ovom uređaju',
    message: `Na ovom uređaju su lokalni podaci računa ${local.email}`
      + `${unsynced ? ` (uključujući ${unsynced} nesinhronizovanih lokacija)` : ''}.\n`
      + 'Prijava drugim računom trajno briše te lokalne podatke.',
    okText: 'Obriši i nastavi',
    danger: true
  });
  if (!ok) return false;

  await wipeDatabase();
  clearLocalKeyring();
  removeBiometrics();
  return true;
}

async function showRecoveryKeyDialog(recoveryKey, { first = true } = {}) {
  await showDialog({
    title: first ? 'Sačuvajte recovery ključ' : 'Vaš novi recovery ključ',
    message: 'Ovaj ključ je jedini način da povratite podatke ako zaboravite lozinku. '
      + 'Zapišite ga ili spremite u upravitelj lozinki. Neće biti prikazan ponovo.',
    readonlyText: recoveryKey,
    requireCheck: 'Sačuvao/la sam recovery ključ na sigurnom mjestu',
    okText: 'Nastavi',
    showCancel: false
  });
}

async function finishUnlock(dek, { email, password } = {}) {
  setActiveKey(dek);
  if (email && password) {
    // Za čitanje podataka koje je stara verzija aplikacije šifrovala drugim algoritmom
    try { setLegacyKey(await deriveLegacyKey(email, password)); } catch { /* nije kritično */ }
  }
  purgeLegacyStorage(); // ukloni ključeve koje je stara verzija držala u plain tekstu

  try {
    const migrated = await migrateLegacyLocal();
    if (migrated > 0) showToast(`${migrated} lokalnih zapisa je prebačeno u šifrovani format.`, 'success', 4000);
  } catch (err) {
    console.error('Migracija lokalnih zapisa nije uspjela:', err);
    showToast('Dio starih lokalnih zapisa nije mogao biti migriran.', 'error');
  }

  // Zatraži trajno skladište: bez ovoga preglednik smije obrisati IndexedDB kad ponestane prostora
  try { await navigator.storage?.persist?.(); } catch { /* ignoriši */ }

  $('authPassword').value = '';
  closeModal('authModal');
  setLockedUi(false);
  updateHeader(await getCurrentUser());
  await refreshViews();
  syncLocationsWithCloud({ silent: true }).catch((err) => console.error(err));
}

/** Lozinka je ispravna za Supabase, ali ne otključava keyring (lozinka resetovana ili promijenjena). */
async function runRecoveryFlow({ cloudRecord, user, email, password }) {
  const first = await showDialog({
    title: 'Potreban recovery ključ',
    message: 'Lozinka se razlikuje od one kojom su podaci šifrovani (npr. nakon resetovanja lozinke). '
      + 'Unesite recovery ključ koji ste dobili pri prvoj prijavi.',
    input: { label: 'Recovery ključ', placeholder: 'XXXX-XXXX-XXXX-…', autocomplete: 'off' },
    okText: 'Otključaj',
    cancelText: 'Nemam recovery ključ'
  });

  if (first.ok) {
    const { dek } = await unlockWithRecovery({
      recoveryText: first.value, cloudRecord, newPassword: password
    });
    await finishUnlock(dek, { email, password });
    showToast('Podaci su otključani recovery ključem.', 'success');
    return;
  }

  const reset = await showDialog({
    title: 'Početi iznova?',
    message: 'Bez recovery ključa postojeći šifrovani podaci u cloudu se ne mogu povratiti. '
      + 'Možete obrisati sve cloud podatke i početi s praznim računom.',
    requireCheck: 'Razumijem da će svi moji podaci u cloudu biti trajno obrisani',
    okText: 'Obriši cloud podatke',
    danger: true
  });
  if (!reset.ok) return;

  await wipeCloudData(user.id);
  await deleteCloudKeyring(user.id);
  await wipeDatabase();
  clearLocalKeyring();
  removeBiometrics();
  await completeUnlock({ email, password, user });
}

/** Zajednički dio: otključaj (ili kreiraj ključ), prikaži recovery ključ, nastavi. */
async function completeUnlock({ email, password, user }) {
  const result = await unlockWithPassword({ email, password, user });

  if (result.needsRecovery) {
    // Prije recovery toka provjeri da lozinka zaista važi za račun (inače je to samo tipfeler)
    try {
      await signInUser(email, password, $('rememberMe').checked);
    } catch (err) {
      if (isNetworkError(err)) throw err;
      throw new DecryptionError('Pogrešna lozinka.');
    }
    await runRecoveryFlow({ cloudRecord: result.cloudRecord, user, email, password });
    return;
  }

  if (result.created) await showRecoveryKeyDialog(result.recoveryKey);
  await finishUnlock(result.dek, { email, password });
  offerBiometrics(user);
}

async function offerBiometrics(user) {
  try {
    if (isBiometricsEnabled() || localStorage.getItem(BIO_DECLINED_FLAG)) return;
    if (!(await isBiometricsAvailable())) return;
    const { ok } = await showDialog({
      title: 'Brzo otključavanje',
      message: 'Želite li otključavati aplikaciju otiskom prsta ili licem umjesto lozinkom?',
      okText: 'Omogući',
      cancelText: 'Ne sada'
    });
    if (!ok) {
      localStorage.setItem(BIO_DECLINED_FLAG, '1');
      return;
    }
    const res = await registerBiometrics(user?.id ?? loadLocalKeyring()?.userId, user?.email || 'GeoLock korisnik');
    showToast(res.ok ? 'Biometrija je omogućena.' : res.reason, res.ok ? 'success' : 'error', 4500);
  } catch (err) {
    console.warn(err);
  }
}

// ---------- Obrasci ----------

async function doRegister(email, password) {
  if (!isEmail(email)) throw new Error('Unesite ispravnu email adresu.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Lozinka mora imati najmanje ${MIN_PASSWORD_LENGTH} znakova.`);
  }
  const data = await signUpUser(email, password);

  if (data.session && data.user) {
    // Potvrda emaila nije uključena: korisnik je odmah prijavljen
    if (!(await guardAccountSwitch(data.user))) return;
    await completeUnlock({ email, password, user: data.user });
    return;
  }
  showToast('Račun je kreiran. Potvrdite email adresu pa se prijavite.', 'success', 6000);
  setAuthMode('login', { email });
}

async function doLogin(email, password) {
  if (!isEmail(email)) throw new Error('Unesite ispravnu email adresu.');
  const remember = $('rememberMe').checked;

  let user = null;
  try {
    const data = await signInUser(email, password, remember);
    user = data.user;
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    // Offline: prijava samo prema lokalnom keyringu
    const result = await unlockWithPassword({ email, password, user: null });
    await finishUnlock(result.dek, { email, password });
    showToast('Radite offline. Sinhronizacija će se nastaviti kad se vrati konekcija.', 'info', 4500);
    return;
  }

  if (!(await guardAccountSwitch(user))) {
    await signOutUser().catch(() => {});
    return;
  }
  await completeUnlock({ email, password, user });
}

async function doUnlock(password) {
  const user = await getCurrentUser();
  const local = loadLocalKeyring();
  const email = user?.email || local?.email;
  if (!email) throw new Error('Nema računa za otključavanje. Prijavite se.');

  // Prvi put (nema lokalnog ključa): lozinka se mora poklapati sa Supabase lozinkom,
  // inače bi nastao ključ zaštićen pogrešnom lozinkom.
  if (!local && user && navigator.onLine) {
    try {
      await signInUser(email, password, $('rememberMe').checked);
    } catch (err) {
      if (!isNetworkError(err)) throw new DecryptionError('Pogrešna lozinka.');
    }
  }
  await completeUnlock({ email, password, user });
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;

  setBusy(true);
  try {
    if (mode === 'register') await doRegister(email, password);
    else if (mode === 'unlock') await doUnlock(password);
    else await doLogin(email, password);
  } catch (err) {
    console.warn('Auth greška:', err);
    showToast(friendlyError(err), 'error', 5000);
    $('authPassword').select();
  } finally {
    setBusy(false);
    await checkAuthStatus();
  }
}

async function handleBiometricUnlock() {
  if (busy) return;
  busy = true;
  try {
    const ok = await unlockWithBiometrics();
    if (!ok) {
      showToast('Biometrijsko otključavanje nije uspjelo. Unesite lozinku.', 'error');
      return;
    }
    await finishUnlock(getActiveKey());
  } finally {
    busy = false;
    await checkAuthStatus();
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const { ok, value } = await showDialog({
    title: 'Resetovanje lozinke',
    message: 'Poslat ćemo vam link za postavljanje nove lozinke. Podatke ćete moći otključati samo uz recovery ključ.',
    input: { label: 'Email adresa', type: 'email', value: $('authEmail').value, autocomplete: 'email' },
    okText: 'Pošalji link'
  });
  if (!ok) return;
  try {
    if (!isEmail(value)) throw new Error('Unesite ispravnu email adresu.');
    await sendPasswordReset(value.trim());
    showToast('Ako račun postoji, link je poslan na email.', 'success', 5000);
  } catch (err) {
    showToast(friendlyError(err), 'error');
  }
}

/** Korisnik je otvorio link iz emaila za reset lozinke (Supabase događaj PASSWORD_RECOVERY). */
export async function handlePasswordRecovery() {
  busy = true;
  try {
    const user = await getCurrentUser();
    if (!user) return;

    const pw = await showDialog({
      title: 'Nova lozinka',
      message: `Unesite novu lozinku (najmanje ${MIN_PASSWORD_LENGTH} znakova).`,
      input: { label: 'Nova lozinka', type: 'password', autocomplete: 'new-password' },
      okText: 'Postavi lozinku'
    });
    if (!pw.ok) return;
    if (pw.value.length < MIN_PASSWORD_LENGTH) {
      showToast(`Lozinka mora imati najmanje ${MIN_PASSWORD_LENGTH} znakova.`, 'error');
      return;
    }

    await updateUserPassword(pw.value);
    showToast('Lozinka je promijenjena.', 'success');

    const cloudRecord = await fetchCloudKeyring(user.id, user.email.toLowerCase());
    if (!cloudRecord) {
      await completeUnlock({ email: user.email, password: pw.value, user });
    } else {
      await runRecoveryFlow({ cloudRecord, user, email: user.email, password: pw.value });
    }
  } catch (err) {
    showToast(friendlyError(err), 'error', 5000);
  } finally {
    busy = false;
    await checkAuthStatus();
  }
}

// ---------- Zaključavanje / odjava ----------

export async function lockApp() {
  clearKeys();
  revokeAllMediaUrls();
  const lightbox = $('lightboxImg');
  lightbox?.removeAttribute('src');
  await checkAuthStatus();
}

export async function handleLogout() {
  try {
    if (navigator.onLine && hasActiveKey()) {
      // pokušaj poslati sve što čeka prije odjave
      await syncLocationsWithCloud({ silent: true }).catch(() => {});
    }
    const pending = (await listSyncState()).filter((s) => !s.synced).length;
    const { ok } = await showDialog({
      title: 'Odjava',
      message: pending > 0
        ? `${pending} lokacija još nije sinhronizovano. Ostat će šifrovane na ovom uređaju i biti poslane kad se ponovo prijavite.`
        : 'Odjavit ćete se sa ovog uređaja. Biometrijsko otključavanje će biti isključeno.',
      okText: 'Odjavi me'
    });
    if (!ok) return;

    removeBiometrics();
    await signOutUser();
    await lockApp();
    showToast('Odjavljeni ste.', 'info');
  } catch (err) {
    console.error(err);
    showToast('Odjava nije uspjela.', 'error');
  }
}

// ---------- Sigurnosne postavke ----------

async function openSecurityPanel() {
  const user = await getCurrentUser();
  const local = loadLocalKeyring();
  $('securityAccount').textContent = `Račun: ${user?.email || local?.email || '—'}${user ? '' : ' (samo lokalno)'}`;
  $('toggleBioBtn').textContent = isBiometricsEnabled() ? 'Isključi biometriju' : 'Omogući biometriju';
  $('newRecoveryBtn').disabled = !user;
  $('changePasswordBtn').disabled = !user;
  openModalElement('securityModal');
}

async function toggleBiometrics() {
  if (isBiometricsEnabled()) {
    removeBiometrics();
    showToast('Biometrija je isključena.', 'info');
  } else {
    const user = await getCurrentUser();
    const res = await registerBiometrics(user?.id ?? loadLocalKeyring()?.userId, user?.email || 'GeoLock korisnik');
    if (res.ok) localStorage.removeItem(BIO_DECLINED_FLAG);
    showToast(res.ok ? 'Biometrija je omogućena.' : res.reason, res.ok ? 'success' : 'error', 4500);
  }
  $('toggleBioBtn').textContent = isBiometricsEnabled() ? 'Isključi biometriju' : 'Omogući biometriju';
}

async function changePassword() {
  if (!navigator.onLine) {
    showToast('Za promjenu lozinke potrebna je internet konekcija.', 'error');
    return;
  }
  const current = await showDialog({
    title: 'Promjena lozinke',
    input: { label: 'Trenutna lozinka', type: 'password', autocomplete: 'current-password' },
    okText: 'Dalje'
  });
  if (!current.ok) return;
  if (!(await verifyPassword(current.value))) {
    showToast('Trenutna lozinka nije ispravna.', 'error');
    return;
  }

  const next = await showDialog({
    title: 'Nova lozinka',
    message: `Najmanje ${MIN_PASSWORD_LENGTH} znakova. Vaši podaci ostaju čitljivi i nakon promjene.`,
    input: { label: 'Nova lozinka', type: 'password', autocomplete: 'new-password' },
    okText: 'Promijeni'
  });
  if (!next.ok) return;
  if (next.value.length < MIN_PASSWORD_LENGTH) {
    showToast(`Lozinka mora imati najmanje ${MIN_PASSWORD_LENGTH} znakova.`, 'error');
    return;
  }

  try {
    await updateUserPassword(next.value);
    await rewrapPassword(next.value);
    showToast('Lozinka je promijenjena.', 'success');
  } catch (err) {
    console.error(err);
    showToast(`Promjena lozinke nije uspjela: ${friendlyError(err)}`, 'error', 6000);
  }
}

async function newRecoveryKey() {
  const { ok } = await showDialog({
    title: 'Novi recovery ključ',
    message: 'Stari recovery ključ prestaje važiti.',
    okText: 'Generiši'
  });
  if (!ok) return;
  try {
    await showRecoveryKeyDialog(await regenerateRecoveryKey(), { first: false });
  } catch (err) {
    showToast(friendlyError(err), 'error');
  }
}

// ---------- Inicijalizacija ----------

export async function initAuth() {
  await enforceSessionOnly(); // "Zapamti me" isključen -> odjava nakon zatvaranja preglednika

  $('authForm').addEventListener('submit', handleAuthSubmit);
  $('bioFastLoginBtn').addEventListener('click', handleBiometricUnlock);
  $('forgotPassword').addEventListener('click', handleForgotPassword);

  $('toggleAuthMode').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(mode === 'register' ? 'login' : 'register');
    refreshBioButton();
  });
  $('authSwitchAccount').addEventListener('click', async (e) => {
    e.preventDefault();
    await handleLogout();
  });

  $('authBtn').addEventListener('click', async () => {
    const user = await getCurrentUser();
    if (user) {
      await handleLogout();
    } else {
      setAuthMode('login', { email: loadLocalKeyring()?.email || '' });
      showAuthModal(hasActiveKey());
    }
  });

  $('lockBtn').addEventListener('click', lockApp);
  $('securityBtn').addEventListener('click', openSecurityPanel);
  $('toggleBioBtn').addEventListener('click', toggleBiometrics);
  $('changePasswordBtn').addEventListener('click', changePassword);
  $('newRecoveryBtn').addEventListener('click', newRecoveryKey);

  // Automatsko zaključavanje nakon dužeg boravka u pozadini
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      if (hasActiveKey() && away > AUTO_LOCK_MS) lockApp();
    }
  });

  await checkAuthStatus();
}
