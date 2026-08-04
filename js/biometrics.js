import { setSecretKey, getSecretKey } from './crypto.js';

export async function isBiometricsAvailable() {
  if (window.PublicKeyCredential && 
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }
  return false;
}

// 1. Registracija biometrije NAKON uspješne prijave
export async function registerBiometrics() {
  const isAvailable = await isBiometricsAvailable();
  if (!isAvailable) {
    alert("Vaš uređaj ne podržava biometrijsku autentifikaciju.");
    return false;
  }

  try {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const userId = new Uint8Array(16);
    window.crypto.getRandomValues(userId);

    const publicKeyCredentialCreationOptions = {
      challenge: challenge,
      rp: { name: "Terenska Evidencija", id: window.location.hostname },
      user: {
        id: userId,
        name: "terenski_istrazitelj",
        displayName: "Terenski Istražitelj"
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required"
      },
      timeout: 60000
    };

    const credential = await navigator.credentials.create({
      publicKey: publicKeyCredentialCreationOptions
    });

    if (credential) {
      // Generisanje jedinstvenog biometrijskog ključa iz akreditiva
      const rawBioKey = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
      setSecretKey(rawBioKey);
      localStorage.setItem('biometrics_enabled', 'true');
      alert("Biometrijska prijava i enkripcija uspješno aktivirani! 🔐");
      return true;
    }
  } catch (err) {
    console.error("Greška pri biometrijskoj registraciji:", err);
    return false;
  }
}

// 2. Brza autentifikacija biometrijom pri ulasku
export async function authenticateWithBiometrics() {
  const isEnabled = localStorage.getItem('biometrics_enabled') === 'true';
  if (!isEnabled) {
    alert("Biometrija još nije aktivirana. Prijavite se prvo pomoću emaila i lozinke.");
    return false;
  }

  try {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const publicKeyCredentialRequestOptions = {
      challenge: challenge,
      userVerification: "required",
      timeout: 60000
    };

    const assertion = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions
    });

    if (assertion) {
      const rawBioKey = btoa(String.fromCharCode(...new Uint8Array(assertion.rawId)));
      setSecretKey(rawBioKey);
      console.log("Biometrijska verifikacija uspješna! Enkripcijski ključ otključan. 🔓");
      return true;
    }
  } catch (err) {
    console.warn("Biometrijska verifikacija otkazana ili neuspješna:", err);
    return false;
  }
}