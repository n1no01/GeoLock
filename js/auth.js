import { signUpUser, signInUser, signOutUser, getCurrentUser, supabase } from './supabase.js';
import { syncLocationsWithCloud } from './sync.js';
import { updateMapMarkers } from './map.js';
import { renderListView, showToast } from './ui.js';
import { registerBiometrics, authenticateWithBiometrics, isBiometricsAvailable } from './biometrics.js';
import { deriveKeyFromCredentials } from './crypto.js';

// Pomoćna varijabla za praćenje biometrijske sesije kad nema Supabase usera
let isBiometricAuthenticated = false;

export async function checkAuthStatus() {
  try {
    const user = await getCurrentUser();
    const authBtn = document.getElementById('authBtn');
    const syncStatus = document.getElementById('syncStatus');
    const bioHeaderContainer = document.getElementById('bioHeaderContainer');
    const enableBioHeaderBtn = document.getElementById('enableBioHeaderBtn');
    const authModal = document.getElementById('authModal');
    const mainContent = document.querySelector('main');

    if (user || isBiometricAuthenticated) {
      // 🟢 Korisnik je prijavljen (preko Supabase ili Biometrije)
      if (authModal) authModal.classList.remove('open');
      if (mainContent) { 
        mainContent.style.pointerEvents = 'auto'; 
        mainContent.style.filter = 'none'; 
      }

      if (authBtn) authBtn.innerText = 'Odjava';
      if (syncStatus) syncStatus.innerText = navigator.onLine ? '☁️ Povezano' : '🔒 Offline rad';

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

      await syncLocationsWithCloud();
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
  } catch (err) {
    console.warn("Auth provjera:", err);
  }
}

// 🔓 Rukovalac za brzu biometrijsku prijavu
export async function handleBiometricLogin() {
  const success = await authenticateWithBiometrics();

  if (success) {
    isBiometricAuthenticated = true;
    showToast("Biometrijska verifikacija uspješna! 🔓", "success");

    const authModal = document.getElementById('authModal');
    const mainContent = document.querySelector('main');
    const syncStatus = document.getElementById('syncStatus');
    const authBtn = document.getElementById('authBtn');

    // Otključaj UI odmah
    if (authModal) authModal.classList.remove('open');
    if (mainContent) { 
      mainContent.style.pointerEvents = 'auto'; 
      mainContent.style.filter = 'none'; 
    }

    if (authBtn) authBtn.innerText = 'Odjava';
    if (syncStatus) {
      syncStatus.innerText = navigator.onLine ? '☁️ Povezano' : '🔒 Offline rad';
    }

    // Osvježi mrežne podatke i prikaži mapu
    await syncLocationsWithCloud();
    await updateMapMarkers();
    await renderListView();
  } else {
    showToast("Biometrijska verifikacija nije uspjela.", "error");
  }
}

// 🚪 Odjava
export async function handleLogout() {
  isBiometricAuthenticated = false;
  await signOutUser();
  await checkAuthStatus();
  showToast("Uspješno ste se odjavili.", "info");
}

// 📌 Registracija event listenera pri inicijalizaciji aplikacije
export function initAuthListeners() {
  // Dugme u headeru (Prijava / Odjava)
  const authBtn = document.getElementById('authBtn');
  if (authBtn) {
    authBtn.addEventListener('click', async () => {
      const user = await getCurrentUser();
      if (user || isBiometricAuthenticated) {
        await handleLogout();
      } else {
        const authModal = document.getElementById('authModal');
        if (authModal) authModal.classList.add('open');
      }
    });
  }

  // Dugme za aktivaciju biometrije u headeru / postavkama
  const enableBioBtn = document.getElementById('enableBioHeaderBtn');
  if (enableBioBtn) {
    enableBioBtn.addEventListener('click', async () => {
      const ok = await registerBiometrics();
      if (ok) {
        enableBioBtn.style.display = 'none';
        showToast("Biometrija uspješno aktivirana za ovaj uređaj!", "success");
      }
    });
  }

  // Dugme za brzu biometrijsku prijavu na modal prozoru
  const bioFastLoginBtn = document.getElementById('bioFastLoginBtn');
  if (bioFastLoginBtn) {
    bioFastLoginBtn.addEventListener('click', handleBiometricLogin);
  }
}