import { getLocations } from './db.js';

function downloadFile(content, fileName, contentType) {
  const a = document.createElement("a"); 
  const file = new Blob([content], {type: contentType});
  a.href = URL.createObjectURL(file); 
  a.download = fileName; 
  a.click();
}

export async function exportGeoJSON() {
  try {
    const locations = await getLocations();
    const geojson = { 
      type: "FeatureCollection", 
      features: locations.map(l => ({ 
        type: "Feature", 
        geometry: { type: "Point", coordinates: [l.lng, l.lat] }, 
        properties: { title: l.title, description: l.description } 
      })) 
    };
    downloadFile(JSON.stringify(geojson, null, 2), "lokacije.geojson", "application/json");
  } catch (err) {
    console.error("Greška pri izvozu GeoJSON-a:", err);
  }
}

export async function exportCSV() {
  try {
    const locations = await getLocations();
    let csv = "ID,Naziv,Sirina,Duzina,Opis,Slika,ImAudio\n";
    locations.forEach(l => { 
      csv += `${l.id},"${l.title}",${l.lat},${l.lng},"${(l.description||'').replace(/"/g,'""')}",${l.images?l.images.length:0},${l.audio?'DA':'NE'}\n`; 
    });
    downloadFile(csv, "lokacije.csv", "text/csv;charset=utf-8;");
  } catch (err) {
    console.error("Greška pri izvozu CSV-a:", err);
  }
}