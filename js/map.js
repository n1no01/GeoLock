import { getLocations } from './db.js';

let map;
const markers = [];
let tempMarker = null;

export function initMap(onMapClickCallback) {
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' });
  const esriSatelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' });

  map = L.map('map', { center: [44.15, 17.85], zoom: 8, layers: [osmLayer] });
  L.control.layers({ "Karta": osmLayer, "Satelit": esriSatelliteLayer }).addTo(map);

  map.on('click', e => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    // Pomjeri privremeni marker pri kliku bilo gdje na mapu
    previewLocation(lat, lng);

    if (onMapClickCallback) onMapClickCallback(lat, lng);
  });

  updateMapMarkers();
  return map;
}

// Funkcija za pomjeranje privremenog markera (reaktivni pregled pri kucanju ili kliku)
export function previewLocation(lat, lng) {
  if (!map || isNaN(lat) || isNaN(lng)) return;

  const latLng = [lat, lng];

  if (tempMarker) {
    tempMarker.setLatLng(latLng);
  } else {
    // Kreiramo marker koji se može prevlačiti prstom/mišem po mapi
    tempMarker = L.marker(latLng, { draggable: true }).addTo(map);

    // Kada korisnik završi prevlačenje markera, ažuriraj polja u formi
    tempMarker.on('dragend', (event) => {
      const position = event.target.getLatLng();
      const latInput = document.getElementById('lat');
      const lngInput = document.getElementById('lng');

      if (latInput && lngInput) {
        latInput.value = position.lat.toFixed(6);
        lngInput.value = position.lng.toFixed(6);
      }
    });
  }

  // Blago pomjeri mapu na novu poziciju
  map.panTo(latLng);
}

export function updateMapMarkers() {
  markers.forEach(m => map.removeLayer(m));
  markers.length = 0;

  const locations = getLocations();
  locations.forEach(loc => {
    const m = L.marker([loc.lat, loc.lng]).addTo(map);
    let popup = `<b>${loc.title}</b><br>${(loc.description || '').substring(0, 80)}`;
    if (loc.audio) popup += `<br><small>🎙️ Glasovna bilješka priložena</small>`;
    if (loc.images && loc.images.length > 0) popup += `<br><img src="${loc.images[0]}" style="width:100%; max-width:120px; margin-top:5px;">`;
    m.bindPopup(popup);
    markers.push(m);
  });
}

export function centerMap(lat, lng, zoom = 15) {
  map.setView([lat, lng], zoom);
}

export function addGpsCircle(lat, lng, accuracy) {
  L.circle([lat, lng], { radius: accuracy, color: '#059669', fillOpacity: 0.15 }).addTo(map);
}

export function invalidateMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 100);
}