import { signUpUser, signInUser, signOutUser, getCurrentUser, supabase } from './supabase.js';
import { syncLocationsWithCloud } from './sync.js';
import { updateMapMarkers } from './map.js';
import { renderListView, showToast } from './ui.js';
import { registerBiometrics, authenticateWithBiometrics, isBiometricsAvailable } from './biometrics.js';
import { deriveKeyFromCredentials } from './crypto.js';

// Pomoćna varijabla za praćenje biometrijske sesije
let isBiometricAuthenticated = localStorage.getItem('bio_session_active') === 'true';

export async function checkAuthStatus() {
  let user = null;
  
  // Ako smo na mreži, provjeri Supabase usera
  if (navigator.onLine) {
    try {
      user = await getCurrentUser();
    } catch (err) {
      console.warn("Supabase auth offline/greška:", err);
    }
  }

  const authBtn = document.getElementById('authBtn');
  const syncStatus = document.getElementById('syncStatus');
  const bioHeaderContainer = document.getElementById('bioHeaderContainer');
  const enableBioHeaderBtn = document.getElementById('enableBioHeaderBtn');
  const authModal = document.getElementById('authModal');
  const mainContent = document.querySelector('main');

  const isAuthenticated = !!(user || isBiometricAuthenticated);

  if (isAuthenticated) {
    // 🟢 Korisnik je prijavljen (Supabase ili Offline Biometrija)
    if (authModal) authModal.classList.remove('open');
    if (mainContent) { 
      mainContent.style.pointerEvents = 'auto'; 
      mainContent.style.filter = 'none'; 
    }

    if (authBtn) authBtn.innerText = 'Odjava';
    if (syncStatus) syncStatus.innerText = (navigator.onLine && user) ? '☁️ Povezano na Cloud' : '🔒 Offline rad (Lokalno)';

    const bioAvailable = await isBiometricsAvailable();
    const isBioEnabled = localStorage.getItem('biometrics_enabled') === 'true';

    if (bioAvailable && bioHeaderContainer) {
      bioHeaderContainer.style.display = 'block';
      if (isBioEnabled && enableBioHeaderBtn) {
        enableBioHeaderBtn.style.display = 'none';
      } else if (enableBioHeaderBtn) {
        enableBioHeaderBtn.innerText = '👆 Omogući Biometriju';
        enableBioHeaderBtn.style.background = '#334155';
        enableBioHeaderBtn.disabled = false;
      }
    } else if (bioHeaderContainer) {
      bioHeaderContainer.style.display = 'none';
    }

    // Sinhronizuj samo ako imamo pravu Supabase sesiju na mreži
    if (navigator.onLine && user) {
      try {
        await syncLocationsWithCloud();
      } catch (e) {
        console.warn("Sinhronizacija preskočena/greška:", e);
      }
    }

    await updateMapMarkers();
    await renderListView();
  } else {
    // 🔴 Nema sesije
    const isBioEnabled = localStorage.getItem('biometrics_enabled') === 'true';
    const bioContainer = document.getElementById('bioFastLoginContainer');
    if (bioContainer) bioContainer.style.display = isBioEnabled ? 'block' : 'none';

    if (authBtn) authBtn.innerText = 'Prijava';
    if (syncStatus) syncStatus.innerText = '🔒 Prijava obavezna';
    if (bioHeaderContainer) bioHeaderContainer.style.display = 'none';

    if (authModal) authModal.classList.add('open');
    if (mainContent) { 
      mainContent.style.pointerEvents = 'none'; 
      mainContent.style.filter = 'blur(4px)'; 
    }

    await updateMapMarkers();
    await renderListView();
  }
}

// 🔓 Rukovalac za brzu biometrijsku prijavu
export async function handleBiometricLogin() {
  const success = await authenticateWithBiometrics();

  if (success) {
    isBiometricAuthenticated = true;
    localStorage.setItem('bio_session_active', 'true');

    // Ako ima interneta, pokušaj se tiho prijaviti na Supabase radi sinhronizacije
    const savedEmail = localStorage.getItem('bio_user_email');
    const savedPassword = localStorage.getItem('bio_user_pass');

    if (navigator.onLine && savedEmail && savedPassword) {
      try {
        await signInUser(savedEmail, savedPassword);
        await deriveKeyFromCredentials(savedEmail, savedPassword);
      } catch (err) {
        console.warn("Pozadinska Supabase prijava nije uspjela, nastavljam u offline načinu:", err);
      }
    }

    showToast("Biometrijska verifikacija uspješna! 🔓", "success");
    await checkAuthStatus();
  } else {
    showToast("Biometrijska verifikacija nije uspjela.", "error");
  }
}

// 🚪 Odjava
export async function handleLogout() {
  isBiometricAuthenticated = false;
  localStorage.removeItem('bio_session_active');
  
  if (navigator.onLine) {
    try {
      await signOutUser();
    } catch (e) {
      console.warn("Offline signOut:", e);
    }
  }

  await checkAuthStatus();
  showToast("Uspješno ste se odjavili.", "info");
}

// 📌 Registracija event listenera
export function initAuthListeners() {
  const authBtn = document.getElementById('authBtn');
  if (authBtn) {
    authBtn.addEventListener('click', async () => {
      const user = navigator.onLine ? await getCurrentUser() : null;
      if (isBiometricAuthenticated || user) {
        await handleLogout();
      } else {
        const authModal = document.getElementById('authModal');
        if (authModal) authModal.classList.add('open');
      }
    });
  }

  const enableBioBtn = document.getElementById('enableBioHeaderBtn');
  if (enableBioBtn) {
    enableBioBtn.addEventListener('click', async () => {
      const ok = await registerBiometrics();
      if (ok) {
        enableBioBtn.style.display = 'none';
        showToast("Biometrija uspješno aktivirana!", "success");
      }
    });
  }

  const bioFastLoginBtn = document.getElementById('bioFastLoginBtn');
  if (bioFastLoginBtn) {
    bioFastLoginBtn.addEventListener('click', handleBiometricLogin);
  }

  // 📡 Automatska sinhronizacija čim uređaj dobije internet
  window.addEventListener('online', async () => {
    showToast("Internet konekcija uspostavljena! Provjeravam sinhronizaciju...", "info");
    await checkAuthStatus();
  });
}