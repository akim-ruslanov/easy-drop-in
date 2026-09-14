const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'easy-drop-in/1.0 (personal project)';

const cache = new Map();

export async function geocode(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.length) {
    cache.set(key, null);
    return null;
  }

  const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
  cache.set(key, result);
  return result;
}
