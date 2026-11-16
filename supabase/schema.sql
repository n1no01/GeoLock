-- =====================================================================
-- GeoLock — Supabase šema, RLS politike i privatni storage
-- Pokrenuti u Supabase Dashboard -> SQL Editor. Skripta je idempotentna (sigurno je pokrenuti više puta).
--
-- VAŽNO: anon ključ u aplikaciji je javan. Cjelokupna zaštita podataka počiva na ovim politikama:
-- svaki korisnik smije čitati/pisati ISKLJUČIVO svoje redove i svoje fajlove.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabela locations (svi osjetljivi podaci su AES-GCM šifrati; server vidi samo "v1:..." tekst)
-- ---------------------------------------------------------------------
create table if not exists public.locations (
  id             text primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  title          text,
  description    text,
  lat            text,
  lng            text,
  images_urls    text[]  default '{}',
  audio_url      text,
  documents_data jsonb   default '[]'::jsonb,
  meta           text,
  timestamp      timestamptz default now()
);

-- Nadogradnja postojeće tabele iz verzije 1.0
alter table public.locations add column if not exists meta text;

-- Stara verzija je koristila Date.now() kao id (možda bigint); nova koristi UUID.
do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'locations' and column_name = 'id') <> 'text' then
    alter table public.locations alter column id type text using id::text;
  end if;
end $$;

create index if not exists locations_user_id_idx on public.locations (user_id);

alter table public.locations enable row level security;

drop policy if exists "locations_select_own" on public.locations;
drop policy if exists "locations_insert_own" on public.locations;
drop policy if exists "locations_update_own" on public.locations;
drop policy if exists "locations_delete_own" on public.locations;

create policy "locations_select_own" on public.locations
  for select to authenticated using (user_id = (select auth.uid()));
create policy "locations_insert_own" on public.locations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "locations_update_own" on public.locations
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "locations_delete_own" on public.locations
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 2. Tabela user_keys: omotani (wrapped) ključ za šifrovanje
--    Server nikad ne vidi sam ključ — samo ga čuva šifrovanog lozinkom korisnika
--    i recovery ključem. Omogućava prijavu sa drugih uređaja i promjenu lozinke.
-- ---------------------------------------------------------------------
create table if not exists public.user_keys (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  salt                 text    not null,
  iterations           integer not null,
  wrapped_dek          text    not null,
  recovery_wrapped_dek text    not null,
  updated_at           timestamptz not null default now()
);

alter table public.user_keys enable row level security;

drop policy if exists "user_keys_select_own" on public.user_keys;
drop policy if exists "user_keys_insert_own" on public.user_keys;
drop policy if exists "user_keys_update_own" on public.user_keys;
drop policy if exists "user_keys_delete_own" on public.user_keys;

create policy "user_keys_select_own" on public.user_keys
  for select to authenticated using (user_id = (select auth.uid()));
create policy "user_keys_insert_own" on public.user_keys
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "user_keys_update_own" on public.user_keys
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "user_keys_delete_own" on public.user_keys
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 3. Storage: PRIVATNI bucket + politike po korisničkom folderu
--    Putanje su  <user_id>/<location_id>/<media_id>.enc  (stara verzija: <user_id>/<location_id>/<tip>/<fajl>.enc)
--    Aplikacija više ne koristi javne URL-ove, već autentifikovano preuzimanje.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('location-images', 'location-images', false)
on conflict (id) do update set public = false;

drop policy if exists "geolock_objects_select_own" on storage.objects;
drop policy if exists "geolock_objects_insert_own" on storage.objects;
drop policy if exists "geolock_objects_update_own" on storage.objects;
drop policy if exists "geolock_objects_delete_own" on storage.objects;

create policy "geolock_objects_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'location-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "geolock_objects_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'location-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "geolock_objects_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'location-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'location-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "geolock_objects_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'location-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------
-- 4. Provjera: provjerite u Dashboard -> Authentication -> Policies da ne postoje stare,
--    šire politike (npr. "public read" na bucketu location-images) koje bi poništile gornje.
-- ---------------------------------------------------------------------
