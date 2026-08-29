import CryptoJS from 'crypto-js';

const KEY_STORAGE_NAME = 'terenska_secret_key';

// Generisanje jakog AES-256 ključa iz emaila i lozinke (PBKDF2)
export function deriveKeyFromCredentials(email, password) {
  if (!email || !password) return null;
  const salt = CryptoJS.SHA256(email.toLowerCase().trim()).toString();
  
  // Korištenje PBKDF2 sa 10.000 iteracija za sigurno izvođenje ključa
  const derivedKey = CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32,
    iterations: 10000
  }).toString();

  setSecretKey(derivedKey);
  return derivedKey;
}

export function setSecretKey(key) {
  if (key && key.trim().length > 0) {
    localStorage.setItem(KEY_STORAGE_NAME, key.trim());
  }
}

export function getSecretKey() {
  return localStorage.getItem(KEY_STORAGE_NAME) || '';
}

// 🔐 ENKRIPCIJA TEKSTA
export function encryptText(text) {
  if (text === null || text === undefined || text === '') return text;
  const key = getSecretKey();
  if (!key) return String(text); // Ako nema ključa, vraća izvorni tekst
  try {
    return CryptoJS.AES.encrypt(String(text), key).toString();
  } catch (err) {
    console.error("Greška pri enkripciji teksta:", err);
    return String(text);
  }
}

// 🔓 DEKRIPCIJA TEKSTA
export function decryptText(ciphertext) {
  if (!ciphertext) return ciphertext;
  const key = getSecretKey();
  if (!key) return ciphertext;
  try {
    const bytes = CryptoJS.AES.decrypt(String(ciphertext), key);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted || ciphertext;
  } catch (err) {
    console.warn("Nije moguće dekriptovati tekst sa trenutnim ključem.");
    return ciphertext;
  }
}

// 🔐 ENKRIPCIJA MEDIJA (SLIKE / AUDIO)
export function encryptMediaBase64(base64Data) {
  if (!base64Data || !base64Data.startsWith('data:')) return base64Data;
  const key = getSecretKey();
  if (!key) return null;
  try {
    const encrypted = CryptoJS.AES.encrypt(base64Data, key).toString();
    return new Blob([encrypted], { type: 'text/plain' });
  } catch (err) {
    console.error("Greška pri enkripciji medija:", err);
    return null;
  }
}

// 🔓 DEKRIPCIJA MEDIJA SA URL-a
export async function decryptMediaFromUrl(url) {
  if (!url || !url.startsWith('http')) return url;
  const key = getSecretKey();
  if (!key) return url;
  try {
    const response = await fetch(url);
    const encryptedText = await response.text();

    if (!encryptedText.startsWith('U2FsdGVkX1')) {
      return url;
    }

    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    const decryptedBase64 = bytes.toString(CryptoJS.enc.Utf8);
    return decryptedBase64 || url;
  } catch (err) {
    console.warn("Greška pri dešifrovanju medija sa URL-a:", err);
    return url;
  }
}