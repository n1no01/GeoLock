// Leaflet.markercluster očekuje globalni `L`. Leaflet ga u pregledniku postavlja sam,
// ali eksplicitno osiguravamo to prije učitavanja plugina (redoslijed importa je bitan).
import L from 'leaflet';

if (typeof window !== 'undefined' && !window.L) window.L = L;
