import { centerMap, addGpsCircle } from './map.js';

export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    const status = document.getElementById('gpsStatus');
    if (!navigator.geolocation) {
      if (status) status.innerText = "GPS nije podržan na ovom uređaju.";
      return reject(new Error("Geolocation not supported"));
    }
    
    if (status) status.innerText = "🛰️ Traženje GPS lokacije...";
    
    // Opcije koje daju šansu uređaju da vrati bilo kakvu keširanu/brzu lokaciju
    const options = {
      enableHighAccuracy: false, // Krećemo sa brzim lociranjem (Wi-Fi / toranj) da ne čekaš predugo
      timeout: 10000, 
      maximumAge: 30000 // Dozvoli malo stariju keširanu lokaciju da odmah reaguje
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = parseFloat(pos.coords.latitude.toFixed(6));
        const lng = parseFloat(pos.coords.longitude.toFixed(6));
        const accuracy = Math.round(pos.coords.accuracy);

        document.getElementById('lat').value = lat;
        document.getElementById('lng').value = lng;
        if (status) status.innerText = `✓ GPS očitan (Preciznost: ~${accuracy}m)`;
        
        centerMap(lat, lng, 16);
        addGpsCircle(lat, lng, accuracy);
        
        resolve({ lat, lng });
      },
      (err) => {
        console.warn("Brzi GPS nije uspio, pokušavam sa visokom preciznošću...", err.message);
        
        if (status) status.innerText = "🛰️ Preciznije traženje satelita...";

        // Drugi pokušaj: Forsiramo pravi GPS ako prvi brzi način omane
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const lat = parseFloat(pos.coords.latitude.toFixed(6));
            const lng = parseFloat(pos.coords.longitude.toFixed(6));
            const accuracy = Math.round(pos.coords.accuracy);

            document.getElementById('lat').value = lat;
            document.getElementById('lng').value = lng;
            if (status) status.innerText = `✓ GPS očitan (Preciznost: ~${accuracy}m)`;
            
            centerMap(lat, lng, 16);
            addGpsCircle(lat, lng, accuracy);
            
            resolve({ lat, lng });
          },
          (fallbackErr) => {
            console.error("GPS greška:", fallbackErr);
            if (status) status.innerText = "❌ GPS signal nedostupan.";
            reject(fallbackErr);
          },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 } // Povećano na 20s za pravi GPS
        );
      },
      options
    );
  });
}