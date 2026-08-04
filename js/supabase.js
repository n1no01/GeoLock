import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://odaiplalvjteqepkklhk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kYWlwbGFsdmp0ZXFlcGtrbGhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTE0MTcsImV4cCI6MjEwMTQyNzQxN30.xm2vQFCTlHAY2FFzi7lYojWDbOsJlvHAedm4Pgf56Zg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Auth Funkcije
export async function signUpUser(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signInUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOutUser() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}