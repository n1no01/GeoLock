import { createClient } from '@supabase/supabase-js';

// Vrijednosti se mogu postaviti kroz .env (VITE_*). Fallback su javne vrijednosti trenutnog
// projekta: anon ključ je namjerno javan, a pristup podacima štite RLS politike (supabase/schema.sql).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://odaiplalvjteqepkklhk.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kYWlwbGFsdmp0ZXFlcGtrbGhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTE0MTcsImV4cCI6MjEwMTQyNzQxN30.xm2vQFCTlHAY2FFzi7lYojWDbOsJlvHAedm4Pgf56Zg';

export const STORAGE_BUCKET = import.meta.env.VITE_STORAGE_BUCKET || 'location-images';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true, // sesija se čuva lokalno pa getSession() radi i offline
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// ---------- "Zapamti me" ----------
// localStorage flag preživljava zatvaranje preglednika, sessionStorage flag ne.
// Ako je flag prisutan a sessionStorage prazan, preglednik je zatvaran -> odjava.

const SESSION_ONLY_FLAG = 'geolock_session_only';
const SESSION_ALIVE_FLAG = 'geolock_session_alive';

export async function enforceSessionOnly() {
  if (localStorage.getItem(SESSION_ONLY_FLAG) === '1' && sessionStorage.getItem(SESSION_ALIVE_FLAG) !== '1') {
    localStorage.removeItem(SESSION_ONLY_FLAG);
    try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* offline je ok */ }
    return true;
  }
  return false;
}

// ---------- Auth ----------

export async function signUpUser(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw error;
  return data;
}

export async function signInUser(email, password, rememberMe = true) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  if (rememberMe) {
    localStorage.removeItem(SESSION_ONLY_FLAG);
  } else {
    localStorage.setItem(SESSION_ONLY_FLAG, '1');
  }
  sessionStorage.setItem(SESSION_ALIVE_FLAG, '1');
  return data;
}

/** scope: 'local' ne zahtijeva mrežu, pa odjava radi i offline. */
export async function signOutUser() {
  localStorage.removeItem(SESSION_ONLY_FLAG);
  sessionStorage.removeItem(SESSION_ALIVE_FLAG);
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

/** getSession() čita iz localStorage, pa radi i bez interneta. */
export async function getCurrentUser() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;
  return session.user;
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

export async function updateUserPassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/**
 * Callback se poziva asinhrono (setTimeout 0): supabase-js upozorava da pozivi
 * supabase metoda unutar samog callbacka mogu uzrokovati deadlock.
 */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => callback(event, session), 0);
  });
}
