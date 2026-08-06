import { getLocations } from './db.js';

let map = null;
let markersGroup = null;
let previewMarker = null;
let gpsCircle = null;

let streetTiles = null;
let satelliteTiles = null;
let isSatellite = false;

export function initMap(onMapClickCallback) {
  // 🗺️ Standardni sloj (OpenStreetMap)
  streetTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  });

  // 🛰️ Satelitski sloj (Esri World Imagery)
  satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: 'Tiles © Esri'
  });

  // Inicijalizacija mape sa standardnim slojem
  map = L.map('map', {
    center: [44.0, 17.8],
    zoom: 7,
    layers: [streetTiles]
  });

  // 🎛️ Kreiranje custom Toggle dugmeta identičnog izgleda kao standardna Leaflet kontrola slojeva
  addMapToggleControl();

  markersGroup = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    if (typeof onMapClickCallback === 'function') {
      onMapClickCallback(lat, lng);
    }
    previewLocation(lat, lng);
  });

  updateMapMarkers();
}

// 🔘 Leaflet Toggle dugme identičnog izgleda kao fabričko `L.control.layers`
function addMapToggleControl() {
  const ToggleControl = L.Control.extend({
    options: { position: 'topright' },

    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-control-layers leaflet-bar');
      const link = L.DomUtil.create('a', 'leaflet-control-layers-toggle', container);
      
      link.href = '#';
      link.title = 'Prebaci sloj mape';

      // Onemogućava da klik na dugme postavi marker na mapu ispod
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(link, 'click', (e) => {
        L.DomEvent.preventDefault(e);

        if (isSatellite) {
          map.removeLayer(satelliteTiles);
          map.addLayer(streetTiles);
          isSatellite = false;
        } else {
          map.removeLayer(streetTiles);
          map.addLayer(satelliteTiles);
          isSatellite = true;
        }
      });

      return container;
    }
  });

  map.addControl(new ToggleControl());
}

export function updateMapMarkers() {
  if (!map || !markersGroup) return;

  markersGroup.clearLayers();
  const locations = getLocations();

  locations.forEach(loc => {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);

    // 🛡️ Sigurnosna provjera validnosti koordinata
    if (!isNaN(lat) && !isNaN(lng) && lat !== null && lng !== null) {
      const marker = L.marker([lat, lng]);
      marker.bindPopup(`
        <b>${loc.title || 'Bez naslova'}</b><br>
        ${loc.description || ''}<br><br>
        <button onclick="openModal('${loc.id}')" class="btn" style="padding:2px 6px; font-size:11px;">Detalji</button>
      `);
      markersGroup.addLayer(marker);
    }
  });
}

export function centerMap(lat, lng, zoom = 15) {
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);

  if (map && !isNaN(parsedLat) && !isNaN(parsedLng)) {
    map.setView([parsedLat, parsedLng], zoom);
  }
}

export function previewLocation(lat, lng) {
  if (!map) return;

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);

  if (isNaN(parsedLat) || isNaN(parsedLng)) return;

  if (previewMarker) {
    previewMarker.setLatLng([parsedLat, parsedLng]);
  } else {
    previewMarker = L.marker([parsedLat, parsedLng], { opacity: 0.7 }).addTo(map);
  }

  map.panTo([parsedLat, parsedLng]);
}

// 📍 Prikaz kruga preciznosti za GPS lokaciju
export function addGpsCircle(lat, lng, accuracy) {
  if (!map) return;

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);

  if (isNaN(parsedLat) || isNaN(parsedLng)) return;

  if (gpsCircle) {
    map.removeLayer(gpsCircle);
  }

  gpsCircle = L.circle([parsedLat, parsedLng], {
    radius: accuracy || 10,
    color: '#2563eb',
    fillColor: '#3b82f6',
    fillOpacity: 0.2
  }).addTo(map);
}

export function invalidateMapSize() {
  if (map) {
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  }
}