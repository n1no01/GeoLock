import { getSecretKey, setSecretKey } from './crypto.js';

// Pomoćne funkcije za konverziju ArrayBuffer <-> Base64
function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

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
      rp: { name: "GeoLock", id: window.location.hostname },
      user: {
        id: userId,
        name: "geolock_user",
        displayName: "GeoLock User"
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },  // ES256
        { alg: -257, type: "public-key" } // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform", // Isključivo ugrađeni čitač (otisak/Windows Hello)
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000
    };

    const credential = await navigator.credentials.create({
      publicKey: publicKeyCredentialCreationOptions
    });

    if (credential) {
      // 🔑 KLJUČNO: Sačuvamo Credential ID u Base64 formatu
      const credIdBase64 = arrayBufferToBase64(credential.rawId);
      localStorage.setItem('bio_cred_id', credIdBase64);
      localStorage.setItem('bio_vault_key', currentKey);
      localStorage.setItem('biometrics_enabled', 'true');
      
      alert("Otisak prsta / FaceID / Windows Hello uspješno povezan! 🔐");
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
  const credIdBase64 = localStorage.getItem('bio_cred_id');

  if (!isEnabled || !storedKey || !credIdBase64) {
    alert("Biometrija nije aktivirana na ovom uređaju. Prijavite se emailom i lozinkom.");
    return false;
  }

  try {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const rawId = base64ToArrayBuffer(credIdBase64);

    const publicKeyCredentialRequestOptions = {
      challenge: challenge,
      rpId: window.location.hostname,
      // 🔑 KLJUČNO: Ciljamo tačan registrovani biometrijski ključ (sprečava Google Password Manager)
      allowCredentials: [{
        id: rawId,
        type: 'public-key',
        transports: ['internal']
      }],
      userVerification: "required",
      timeout: 60000
    };

    const assertion = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions
    });

    if (assertion) {
      setSecretKey(storedKey);
      console.log("Biometrijska verifikacija uspješna! Enkripcijski ključ otključan. 🔓");
      return true;
    }
  } catch (err) {
    console.warn("Biometrijska verifikacija otkazana ili neuspješna:", err);
    return false;
  }
}