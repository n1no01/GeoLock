import CryptoJS from 'crypto-js';

const KEY_STORAGE_NAME = 'terenska_secret_key';
const DEFAULT_SYSTEM_KEY = 'TerenskaEvidencija_Default_AES_Key_2026';

export function setSecretKey(key) {
  if (key && key.trim().length > 0) {
    localStorage.setItem(KEY_STORAGE_NAME, key.trim());
  }
}

export function getSecretKey() {
  const customKey = localStorage.getItem(KEY_STORAGE_NAME);
  return customKey && customKey.trim().length > 0 ? customKey : DEFAULT_SYSTEM_KEY;
}

// 🔐 ENKRIPCIJA I DEKRIPCIJA TEKSTA
export function encryptText(text) {
  if (text === null || text === undefined || text === '') return text;
  const key = getSecretKey();
  try {
    return CryptoJS.AES.encrypt(String(text), key).toString();
  } catch (err) {
    console.error("Greška pri enkripciji teksta:", err);
    return String(text);
  }
}

export function decryptText(ciphertext) {
  if (!ciphertext) return ciphertext;
  const key = getSecretKey();
  try {
    const bytes = CryptoJS.AES.decrypt(String(ciphertext), key);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted || ciphertext;
  } catch (err) {
    console.warn("Nije moguće dekriptovati tekst sa trenutnim ključem.");
    return ciphertext;
  }
}

// 🔐 ENKRIPCIJA I DEKRIPCIJA MEDIJA (SLIKE I AUDIO BASE64 / BLOB)
export function encryptMediaBase64(base64Data) {
  if (!base64Data || !base64Data.startsWith('data:')) return base64Data;
  const key = getSecretKey();
  try {
    // Šifrujemo kompletan Base64 string u AES-256
    const encrypted = CryptoJS.AES.encrypt(base64Data, key).toString();
    // Vraćamo kao tekstualni Blob spreman za upload u Storage
    return new Blob([encrypted], { type: 'text/plain' });
  } catch (err) {
    console.error("Greška pri enkripciji medija:", err);
    return null;
  }
}

export async function decryptMediaFromUrl(url) {
  if (!url || !url.startsWith('http')) return url;
  const key = getSecretKey();
  try {
    // Preuzimamo šifrovani fajl iz Storage-a
    const response = await fetch(url);
    const encryptedText = await response.text();

    // Ako nije šifrovan (npr. stari URL), vrati izvorni URL
    if (!encryptedText.startsWith('U2FsdGVkX1')) {
      return url;
    }

    // Dešifrujemo u izvorni Base64 Data URL
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    const decryptedBase64 = bytes.toString(CryptoJS.enc.Utf8);
    return decryptedBase64 || url;
  } catch (err) {
    console.warn("Greška pri dešifrovanju medija sa URL-a:", err);
    return url;
  }
}