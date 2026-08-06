import { centerMap, addGpsCircle } from './map.js';

export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    const status = document.getElementById('gpsStatus');
    if (!navigator.geolocation) {
      if (status) status.innerText = "GPS nije podržan na ovom uređaju.";
      return reject(new Error("Geolocation not supported"));
    }
    
    if (status) status.innerText = "🛰️ Traženje GPS signala (offline)...";
    
    // Prvi pokušaj: Stroga preciznost sa dužim timeout-om za offline rad
    const options = {
      enableHighAccuracy: true,
      timeout: 15000, // Produženo na 15 sekundi da GPS čip stigne uhvatiti satelite
      maximumAge: 5000 // Dozvoli keširanu lokaciju staru do 5 sekundi
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
        console.warn("Prvi GPS pokušaj nije uspio, probavam rezervni režim:", err.message);
        
        // Drugi pokušaj (Fallback): Opšta preciznost (ako je prvi istekao)
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const lat = parseFloat(pos.coords.latitude.toFixed(6));
            const lng = parseFloat(pos.coords.longitude.toFixed(6));
            const accuracy = Math.round(pos.coords.accuracy);

            document.getElementById('lat').value = lat;
            document.getElementById('lng').value = lng;
            if (status) status.innerText = `✓ GPS očitan (Rezervni signal)`;
            
            centerMap(lat, lng, 16);
            addGpsCircle(lat, lng, accuracy);
            
            resolve({ lat, lng });
          },
          (fallbackErr) => {
            console.error("GPS greška:", fallbackErr);
            if (status) status.innerText = "❌ GPS signal nedostupan. Provjerite dozvole.";
            reject(fallbackErr);
          },
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
      },
      options
    );
  });
}