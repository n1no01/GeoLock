import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './leaflet-global.js'; // mora prije markercluster-a
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { geocoder } from 'leaflet-control-geocoder';
import 'leaflet-control-geocoder/dist/Control.Geocoder.css';
import { getLocations } from './db.js';
import { isValidLatLng } from './utils.js';

// Pouzdan uvoz ikona za Vite
const markerIcon = new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href;
const markerIconRetina = new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href;
const markerShadow = new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href;

L.Marker.prototype.options.icon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIconRetina,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

let map = null;
let markersGroup = null;
let previewMarker = null;
let gpsCircle = null;
let streetTiles = null;
let satelliteTiles = null;
let isSatellite = false;
let pickCallback = null;
let detailsCallback = null;
let updateToken = 0;

/**
 * @param onPick     (lat, lng) kad korisnik klikne na mapu ili prevuče pin
 * @param onDetails  (locationId) kad korisnik klikne "Detalji" u popupu
 */
export function initMap({ onPick, onDetails } = {}) {
  pickCallback = onPick;
  detailsCallback = onDetails;

  streetTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true, // CORS odgovori (ne "opaque") -> ispravan offline keš bez prevelikog zauzeća kvote
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> suradnici'
  });

  satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    minZoom: 1,
    crossOrigin: true,
    attribution: 'Tiles © Esri',
    detectRetina: true
  });

  map = L.map('map', { center: [44.0, 17.8], zoom: 7, layers: [streetTiles] });

  geocoder({ defaultMarkGeocode: true, placeholder: 'Pretraži lokaciju ili adresu...' }).addTo(map);
  addMapToggleControl();

  // Klasteri: bez njih je mapa neupotrebljiva sa stotinama tačaka
  markersGroup = L.markerClusterGroup({ maxClusterRadius: 50, showCoverageOnHover: false }).addTo(map);

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    previewLocation(lat, lng);
    pickCallback?.(lat, lng);
  });

  return updateMapMarkers();
}

function addMapToggleControl() {
  const ToggleControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const container = L.DomUtil.create('div', 'leaflet-control-layers leaflet-bar');
      const link = L.DomUtil.create('a', 'leaflet-control-layers-toggle', container);
      link.href = '#';
      link.title = 'Prebaci sloj mape';
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', 'Prebaci između mape i satelitskog prikaza');

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(link, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (isSatellite) {
          map.removeLayer(satelliteTiles);
          map.addLayer(streetTiles);
        } else {
          map.removeLayer(streetTiles);
          map.addLayer(satelliteTiles);
        }
        isSatellite = !isSatellite;
        setTimeout(() => map.invalidateSize(), 100);
      });
      return container;
    }
  });
  map.addControl(new ToggleControl());
}

function buildPopup(loc) {
  const box = document.createElement('div');
  const title = document.createElement('b');
  title.textContent = loc.title || 'Bez naslova';
  const desc = document.createElement('div');
  desc.textContent = loc.description || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.textContent = 'Detalji';
  btn.addEventListener('click', () => detailsCallback?.(loc.id));
  box.append(title, desc, document.createElement('br'), btn);
  return box;
}

export async function updateMapMarkers() {
  if (!map || !markersGroup) return;
  const token = ++updateToken;
  const locations = await getLocations();
  if (token !== updateToken) return; // pristigao je noviji poziv

  markersGroup.clearLayers();
  const markers = [];
  for (const loc of locations) {
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!isValidLatLng(lat, lng)) continue;
    markers.push(L.marker([lat, lng], { title: loc.title }).bindPopup(buildPopup(loc)));
  }
  markersGroup.addLayers(markers);
}

export function centerMap(lat, lng, zoom = 15) {
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (map && isValidLatLng(la, ln)) map.setView([la, ln], zoom);
}

export function previewLocation(lat, lng) {
  if (!map) return;
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (!isValidLatLng(la, ln)) return;

  if (previewMarker) {
    previewMarker.setLatLng([la, ln]);
  } else {
    previewMarker = L.marker([la, ln], { opacity: 1, draggable: true }).addTo(map);
    previewMarker.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      pickCallback?.(pos.lat, pos.lng);
    });
  }
  map.panTo([la, ln]);
}

export function addGpsCircle(lat, lng, accuracy) {
  if (!map) return;
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (!isValidLatLng(la, ln)) return;

  if (gpsCircle) map.removeLayer(gpsCircle);
  gpsCircle = L.circle([la, ln], {
    radius: accuracy || 10,
    color: '#2563eb',
    fillColor: '#3b82f6',
    fillOpacity: 0.2
  }).addTo(map);
}

/** Ukloni privremeni pin i krug tačnosti (npr. nakon snimanja lokacije). */
export function clearPreview() {
  if (previewMarker) { map?.removeLayer(previewMarker); previewMarker = null; }
  if (gpsCircle) { map?.removeLayer(gpsCircle); gpsCircle = null; }
}

export function invalidateMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 200);
}
