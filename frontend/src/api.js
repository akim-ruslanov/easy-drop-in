const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export async function fetchData() {
  const res = await fetch(`${API_URL}/events`);
  if (!res.ok) throw new Error(`Failed to fetch events (${res.status})`);
  return res.json();
}

export async function geocode(query) {
  const res = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Location not found');
  return res.json();
}

// Open-spot counts are fetched only for the events about to be displayed.
// `items` is a list of { id, date } pairs.
export async function fetchSpots(items) {
  const params = new URLSearchParams({
    items: items.map(({ id, date }) => `${id}~${date}`).join(','),
  });
  const res = await fetch(`${API_URL}/spots?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch spots (${res.status})`);
  return res.json();
}
