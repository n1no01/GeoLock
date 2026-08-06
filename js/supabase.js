import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://odaiplalvjteqepkklhk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kYWlwbGFsdmp0ZXFlcGtrbGhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTE0MTcsImV4cCI6MjEwMTQyNzQxN30.xm2vQFCTlHAY2FFzi7lYojWDbOsJlvHAedm4Pgf56Zg';

// Inicijalizacija Supabase klijenta sa automatskim čuvanjem sesije
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true, // Čuva token lokalno za offline rad
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// Auth Funkcije
export async function signUpUser(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signInUser(email, password, rememberMe = true) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) throw error;

  // Ako korisnik NIJE označio "Zapamti me", postavljamo oznaku u sessionStorage
  if (!rememberMe) {
    sessionStorage.setItem('temporary_session', 'true');
  } else {
    sessionStorage.removeItem('temporary_session');
  }

  return data;
}

export async function signOutUser() {
  sessionStorage.removeItem('temporary_session');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  // Provera za privremene sesije ako je preglednik zatvoren
  if (sessionStorage.getItem('temporary_session') === null && localStorage.getItem('sb-odaiplalvjteqepkklhk-auth-token')) {
    const isTemp = sessionStorage.getItem('was_temp_login');
    if (isTemp) {
      await signOutUser();
      return null;
    }
  }

  // KLJUČNA IZMJENA: getSession() čita iz localStorage i radi 100% offline bez interneta!
  const { data: { session }, error } = await supabase.auth.getSession();
  
  if (error || !session) {
    return null;
  }

  return session.user;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}