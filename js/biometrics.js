import { getSecretKey, setSecretKey } from './crypto.js';

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

// Registracija biometrije na uređaju
export async function registerBiometrics() {
  const isAvailable = await isBiometricsAvailable();
  if (!isAvailable) {
    alert("Vaš uređaj ne podržava biometrijsku autentifikaciju.");
    return false;
  }

  const currentKey = getSecretKey();
  if (!currentKey) {
    alert("Prvo se prijavite pomoću emaila i lozinke kako bi se generisao enkripcijski ključ.");
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
      // Sačuvamo AES ključ u LocalStorage označen kao biometrijski zaštićen
      localStorage.setItem('bio_vault_key', currentKey);
      localStorage.setItem('biometrics_enabled', 'true');
      alert("Otisak prsta / FaceID uspješno povezan sa vašim nalogom na ovom uređaju! 🔐");
      return true;
    }
  } catch (err) {
    console.error("Greška pri biometrijskoj registraciji:", err);
    return false;
  }
}

// Autentifikacija biometrijom pri ulasku
export async function authenticateWithBiometrics() {
  const isEnabled = localStorage.getItem('biometrics_enabled') === 'true';
  const storedKey = localStorage.getItem('bio_vault_key');

  if (!isEnabled || !storedKey) {
    alert("Biometrija nije aktivirana na ovom uređaju. Prijavite se emailom i lozinkom.");
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
      // Otključavamo sačuvani AES ključ naloga
      setSecretKey(storedKey);
      console.log("Biometrijska verifikacija uspješna! Enkripcijski ključ otključan. 🔓");
      return true;
    }
  } catch (err) {
    console.warn("Biometrijska verifikacija otkazana ili neuspješna:", err);
    return false;
  }
}