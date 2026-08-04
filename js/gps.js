import { centerMap, addGpsCircle } from './map.js';

export function getCurrentLocation() {
  const status = document.getElementById('gpsStatus');
  if (!navigator.geolocation) {
    status.innerText = "GPS nije podržan na ovom uređaju.";
    return;
  }
  
  status.innerText = "Traženje GPS signala...";
  
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      const accuracy = Math.round(pos.coords.accuracy);

      document.getElementById('lat').value = lat;
      document.getElementById('lng').value = lng;
      status.innerText = `✓ GPS očitan (Preciznost: ~${accuracy}m)`;
      
      centerMap(lat, lng, 16);
      addGpsCircle(lat, lng, accuracy);
    },
    (err) => {
      status.innerText = "Greška pri čitanju GPS-a.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}