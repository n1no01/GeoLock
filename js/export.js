import { getLocations, getLocation } from './db.js';
import { getMediaBlobEnsured, downloadBlob } from './media.js';
import { toMgrs } from './coords.js';
import { csvCell, safeFileName, isValidLatLng } from './utils.js';
import { showToast } from './toast.js';

const mgrsOrNA = (lat, lng) => toMgrs(lat, lng) ?? 'N/A';

export async function exportGeoJSON() {
  try {
    const locations = (await getLocations()).filter((l) => isValidLatLng(l.lat, l.lng));
    const geojson = {
      type: 'FeatureCollection',
      features: locations.map((l) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
        properties: {
          id: l.id,
          title: l.title,
          description: l.description,
          mgrs: mgrsOrNA(l.lat, l.lng),
          accuracy_m: l.accuracy,
          created_at: l.createdAt,
          updated_at: l.updatedAt
        }
      }))
    };
    downloadBlob(new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' }), 'lokacije.geojson');
  } catch (err) {
    console.error('Greška pri izvozu GeoJSON-a:', err);
    showToast('Izvoz GeoJSON-a nije uspio.', 'error');
  }
}

export async function exportCSV() {
  try {
    const locations = await getLocations();
    const header = ['ID', 'Naziv', 'Sirina', 'Duzina', 'MGRS', 'Preciznost_m', 'Opis', 'Slike', 'Dokumenti', 'Audio', 'Zabiljezeno', 'Izmijenjeno'];
    const rows = locations.map((l) => [
      csvCell(l.id),
      csvCell(l.title),
      l.lat ?? '',
      l.lng ?? '',
      csvCell(mgrsOrNA(l.lat, l.lng)),
      l.accuracy ? Math.round(l.accuracy) : '',
      csvCell(l.description),
      l.images.length,
      l.documents.length,
      l.audio ? 'DA' : 'NE',
      csvCell(l.createdAt),
      csvCell(l.updatedAt)
    ].join(','));

    // BOM da Excel ispravno prikaže č, ć, š, ž, đ
    const csv = `\uFEFF${header.join(',')}\r\n${rows.join('\r\n')}\r\n`;
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'lokacije.csv');
  } catch (err) {
    console.error('Greška pri izvozu CSV-a:', err);
    showToast('Izvoz CSV-a nije uspio.', 'error');
  }
}

/** Dimenzije slike sa očuvanim omjerom stranica (ranije fiksno 450x300 -> izobličenje). */
async function fitImage(blob, maxWidth = 450, maxHeight = 600) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const size = { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) };
  bitmap.close?.();
  return size;
}

export async function exportSingleLocationToDocx(locationId) {
  try {
    const loc = await getLocation(locationId);
    if (!loc) return;

    // docx je veliki paket pa se učitava tek kad zatreba (i dolazi iz npm-a, ne sa CDN-a)
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, HeadingLevel, WidthType
    } = await import('docx');

    const cell = (text, bold = false) => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(text), bold })] })]
    });
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString('bs') : 'Nije zabilježeno');

    const children = [
      new Paragraph({ text: 'TERENSKI IZVJEŠTAJ - GEOLOCK', heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
      new Paragraph({
        children: [new TextRun({ text: 'Naziv lokacije: ', bold: true }), new TextRun(loc.title || 'Bez naziva')],
        spacing: { after: 120 }
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Zabilježeno: ', bold: true }), new TextRun(fmt(loc.createdAt))],
        spacing: { after: 120 }
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Zadnja izmjena: ', bold: true }), new TextRun(fmt(loc.updatedAt))],
        spacing: { after: 200 }
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [cell('Geografska širina (Lat)', true), cell('Geografska dužina (Lng)', true),
              cell('MGRS', true), cell('Preciznost', true)]
          }),
          new TableRow({
            children: [cell(loc.lat), cell(loc.lng), cell(mgrsOrNA(loc.lat, loc.lng)),
              cell(loc.accuracy ? `±${Math.round(loc.accuracy)} m` : 'N/A')]
          })
        ]
      }),
      new Paragraph({
        text: 'Opis i terenske bilješke:', heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 100 }
      }),
      new Paragraph({ text: loc.description || 'Nema pisanog opisa.', spacing: { after: 300 } })
    ];

    if (loc.documents.length > 0 || loc.audio) {
      children.push(new Paragraph({
        text: 'Prilozi:', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }
      }));
      for (const d of loc.documents) children.push(new Paragraph({ text: d.name, bullet: { level: 0 } }));
      if (loc.audio) children.push(new Paragraph({ text: 'Glasovna bilješka (dostupna u aplikaciji)', bullet: { level: 0 } }));
    }

    if (loc.images.length > 0) {
      children.push(new Paragraph({
        text: 'Fotografije sa terena:', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 150 }
      }));
      for (const mediaId of loc.images) {
        try {
          const blob = await getMediaBlobEnsured(mediaId);
          if (!blob) continue;
          const transformation = await fitImage(blob);
          children.push(new Paragraph({
            children: [new ImageRun({ data: new Uint8Array(await blob.arrayBuffer()), transformation })],
            spacing: { after: 200 }
          }));
        } catch (imgErr) {
          console.error('Slika nije dodana u DOCX:', imgErr);
        }
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    downloadBlob(blob, `Izvjestaj_${safeFileName(loc.title, 'lokacija')}.docx`);
  } catch (err) {
    console.error('Greška pri generisanju DOCX fajla:', err);
    showToast('Generisanje DOCX izvještaja nije uspjelo.', 'error');
  }
}
