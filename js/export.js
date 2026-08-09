import { getLocations } from './db.js';
import * as mgrs from 'mgrs';

function downloadFile(content, fileName, contentType) {
  const a = document.createElement("a"); 
  const file = new Blob([content], {type: contentType});
  a.href = URL.createObjectURL(file); 
  a.download = fileName; 
  a.click();
}

// Pomoćna funkcija za sigurno izračunavanje MGRS-a
function getMGRS(latRaw, lngRaw) {
  try {
    const lat = parseFloat(latRaw);
    const lng = parseFloat(lngRaw);
    if (!isNaN(lat) && !isNaN(lng)) {
      return mgrs.forward([lng, lat], 5);
    }
  } catch (e) {
    console.warn("Greška pri konverziji u MGRS:", e);
  }
  return "N/A";
}

export async function exportGeoJSON() {
  try {
    const locations = await getLocations();
    const geojson = { 
      type: "FeatureCollection", 
      features: locations.map(l => ({ 
        type: "Feature", 
        geometry: { type: "Point", coordinates: [l.lng, l.lat] }, 
        properties: { 
          title: l.title, 
          description: l.description,
          mgrs: getMGRS(l.lat, l.lng)
        } 
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
    let csv = "ID,Naziv,Sirina,Duzina,MGRS,Opis,Slika,Dokumenti,ImAudio\n";
    locations.forEach(l => { 
      const mgrsVal = getMGRS(l.lat, l.lng);
      csv += `${l.id},"${l.title}",${l.lat},${l.lng},"${mgrsVal}","${(l.description||'').replace(/"/g,'""')}",${l.images?l.images.length:0},${l.documents?l.documents.length:0},${l.audio?'DA':'NE'}\n`; 
    });
    downloadFile(csv, "lokacije.csv", "text/csv;charset=utf-8;");
  } catch (err) {
    console.error("Greška pri izvozu CSV-a:", err);
  }
}

// Izvoz pojedinačne lokacije u DOCX dokument
export async function exportSingleLocationToDocx(locationId) {
  try {
    const locations = await getLocations();
    const loc = locations.find(l => String(l.id) === String(locationId));
    if (!loc) return;

    if (!window.docx) {
      console.error("docx biblioteka nije učitana u HTML-u.");
      return;
    }

    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, HeadingLevel, WidthType } = window.docx;

    const mgrsString = getMGRS(loc.lat, loc.lng);

    const docChildren = [
      new Paragraph({
        text: "TERENSKI IZVJEŠTAJ - GEOLOCK",
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 }
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "Naziv lokacije: ", bold: true }),
          new TextRun(loc.title || "Bez naziva")
        ],
        spacing: { after: 120 }
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "Datum i vrijeme: ", bold: true }),
          new TextRun(loc.timestamp ? new Date(loc.timestamp).toLocaleString("bs") : "Nije zabilježeno")
        ],
        spacing: { after: 200 }
      }),
      
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Geografska Širina (Lat)", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Geografska Dužina (Lng)", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "MGRS Koordinata", bold: true })] })] })
            ]
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(String(loc.lat))] }),
              new TableCell({ children: [new Paragraph(String(loc.lng))] }),
              new TableCell({ children: [new Paragraph(mgrsString)] })
            ]
          })
        ]
      }),

      new Paragraph({
        text: "Opis i terenske bilješke:",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 }
      }),
      new Paragraph({
        text: loc.description || "Nema pisanog opisa.",
        spacing: { after: 300 }
      })
    ];

    if (loc.images && loc.images.length > 0) {
      docChildren.push(
        new Paragraph({
          text: "Fotografije sa terena:",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 150 }
        })
      );

      for (const imgBase64 of loc.images) {
        try {
          const base64Data = imgBase64.split(',')[1];
          if (!base64Data) continue;
          
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          docChildren.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: bytes,
                  transformation: { width: 450, height: 300 }
                })
              ],
              spacing: { after: 200 }
            })
          );
        } catch (imgErr) {
          console.error("Greška pri dodavanju slike u DOCX:", imgErr);
        }
      }
    }

    const doc = new Document({
      sections: [{ children: docChildren }]
    });

    const blob = await Packer.toBlob(doc);
    downloadFile(blob, `Izvjestaj_${(loc.title || 'lokacija').replace(/\s+/g, '_')}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  } catch (err) {
    console.error("Greška pri generisanju DOCX fajla:", err);
  }
}