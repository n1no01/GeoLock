# GeoLock

Offline-first PWA za terensku evidenciju lokacija: GPS i karta, MGRS koordinate, fotografije,
glasovne bilješke, dokumenti i DOCX/CSV/GeoJSON izvoz. Svi osjetljivi podaci se šifruju **na uređaju**
prije spremanja i prije slanja u cloud (Supabase), pa server nikad ne vidi naslove, opise, koordinate ni priloge.

## Pokretanje

```bash
npm install
npm run dev        # razvoj
npm run build      # produkcijski build u dist/
npm run lint       # ESLint
npm test           # jedinični testovi (Vitest)
```

Zahtijeva Node ≥ 20.19.

### Konfiguracija

Kopirajte `.env.example` u `.env` i postavite vlastiti Supabase projekat
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Ako se izostave, koriste se zadane vrijednosti iz
`js/supabase.js`. Anon ključ je javan po dizajnu — zaštitu daju RLS politike.

### Postavljanje Supabase backenda (obavezno)

U **SQL Editoru** pokrenite [`supabase/schema.sql`](supabase/schema.sql). Skripta je idempotentna i:

- kreira/nadograđuje tabele `locations` (nova kolona `meta`, `id` postaje `text`) i `user_keys`,
- uključuje **RLS** s politikama „samo vlastiti redovi“,
- postavlja bucket `location-images` na **privatan** i dodaje storage politike po korisničkom folderu.

Nakon pokretanja provjerite da ne postoje starije, šire politike (npr. javno čitanje bucketa)
koje bi poništile nove. Bez ove skripte sinhronizacija neće raditi.

## Model šifrovanja

| Element | Rješenje |
|---|---|
| Šifra podataka | AES-256-GCM (WebCrypto), nasumični 12-bajtni IV, format `v1:<base64>` |
| Ključ za podatke (DEK) | Nasumičan; **nikad se ne zapisuje u localStorage**, živi samo u memoriji dok je aplikacija otključana |
| Zaštita DEK-a | Omotan ključem iz lozinke (PBKDF2-SHA256, 600 000 iteracija, nasumični salt) |
| Recovery | Pri prvoj prijavi generiše se recovery ključ (32 bajta, Base32). Drugi omot DEK-a |
| Promjena lozinke | Samo se ponovo omota isti DEK — podaci ostaju čitljivi |
| Lokalna baza | IndexedDB zapisi i mediji su šifrovani u mirovanju |
| Biometrija | WebAuthn **PRF** ekstenzija: ključ za omatanje izvodi sam autentifikator nakon biometrijske provjere. Ako uređaj ne podržava PRF, biometrija se ne nudi |
| Cloud | Server čuva samo šifrate i omotane ključeve (`user_keys`); mediji u privatnom bucketu |

**Posljedice koje treba znati**

- Nakon osvježavanja stranice aplikacija je zaključana dok se ne unese lozinka (ili biometrija), jer ključ nije u storage-u. Aplikacija se automatski zaključava i nakon 15 min u pozadini.
- **Bez lozinke i recovery ključa podaci se ne mogu povratiti.** To je cijena end-to-end enkripcije.
- Odjava ne briše lokalne podatke, ali oni ostaju šifrovani. Prijava drugim računom na istom uređaju traži potvrdu i briše lokalne podatke prethodnog računa.

### Migracija sa verzije 1.0

Pri prvoj prijavi nove verzije lozinkom:

1. ključevi koje je stara verzija držala u plain tekstu (`terenska_secret_key`, `bio_vault_key`, …) se brišu iz localStorage-a;
2. nesinhronizovani lokalni zapisi se pretvaraju u šifrovani format (ne gube se);
3. zapisi u cloudu šifrovani starim algoritmom (CryptoJS) se dešifruju, ponovo šifruju novim formatom i šalju natrag; stari fajlovi u storage-u se brišu.

Stari biometrijski unos ne radi (nije bio siguran) — ponovo ga omogućite u ⚙️ Sigurnost.

## Struktura

```
js/
  app.js        ulazna tačka, forma za unos
  auth.js       prijava / otključavanje / recovery / zaključavanje / odjava
  crypto.js     WebCrypto primitivi, DEK wrapping, podrška za stari format
  keyring.js    DEK: kreiranje, otključavanje, recovery, promjena lozinke
  biometrics.js WebAuthn PRF
  db.js         šifrovani IndexedDB (lokacije + mediji kao Blob)
  sync.js       sinhronizacija (mutex, stabilne putanje, brisanje fajlova)
  edit.js       izmjena lokacije (jedina implementacija)
  ui.js         lista, detalji, modali, dijalozi
  map.js        Leaflet + klasteri
  gps.js        watchPosition do ciljane preciznosti
  audio.js, export.js, media.js, coords.js, utils.js, toast.js
supabase/schema.sql   šema + RLS + storage politike
test/                 Vitest testovi (kripto, baza, pomoćne funkcije)
```

## Testovi

`npm test` pokriva kriptografiju (uključujući otkrivanje izmjene šifrata i wrapping ključeva),
lokalnu bazu (šifrovanje u mirovanju, regresija: izmjena lokacije ne briše priloge, zaštita od
prepisivanja nesinhronizovanih izmjena, migracija) i pomoćne funkcije (CSV injection, MGRS…).


```bash
npm i --no-save playwright && npx playwright install chromium
npm run build 
```

## Offline karte

Pločice se keširaju (service worker) do 500 po sloju. Masovno unaprijed preuzimanje OpenStreetMap pločica
krši njihovu [tile politiku](https://operations.osmfoundation.org/policies/tiles/); za ozbiljan offline rad
koristite vlastiti ili komercijalni tile izvor.

## Licenca

ISC
