import { setSecretKey } from './crypto.js';

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

// Registracija biometrije i generisanje biometrijskog AES ključa
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
      // Generišemo jedinstveni biometrijski enkripcijski ključ iz ID-a biometrijskog akreditiva
      const rawBioKey = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
      setSecretKey(rawBioKey);

      localStorage.setItem('biometrics_enabled', 'true');
      alert("Biometrijski ključ za enkripciju je uspješno kreiran i aktiviran! 🔐");
      return true;
    }
  } catch (err) {
    console.error("Greška pri biometrijskoj registraciji:", err);
    alert("Biometrijska verifikacija nije uspjela ili je otkazana.");
    return false;
  }
}

// Otključavanje biometrijom i punjenje AES ključa u memoriju
export async function authenticateWithBiometrics() {
  const isEnabled = localStorage.getItem('biometrics_enabled') === 'true';
  if (!isEnabled) {
    return await registerBiometrics();
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