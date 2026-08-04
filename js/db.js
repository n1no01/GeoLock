const DB_KEY = 'saved_locations';

export function getLocations() {
  return JSON.parse(localStorage.getItem(DB_KEY) || '[]');
}

export function saveLocation(location) {
  const locations = getLocations();
  // Označavamo da novi unos po defaultu nije sinhronizovan sa cloudom
  location.synced = location.synced || false; 
  locations.push(location);
  localStorage.setItem(DB_KEY, JSON.stringify(locations));
  return locations;
}

export function updateLocation(id, updatedData) {
  let locations = getLocations();
  const index = locations.findIndex(l => String(l.id) === String(id));
  if (index !== -1) {
    locations[index] = { ...locations[index], ...updatedData };
    localStorage.setItem(DB_KEY, JSON.stringify(locations));
  }
  return locations;
}

export function deleteLocationFromDb(id) {
  let locations = getLocations();
  locations = locations.filter(l => String(l.id) !== String(id));
  localStorage.setItem(DB_KEY, JSON.stringify(locations));
  return locations;
}