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

// Server-side "notify me when registration opens" subscriptions.
export async function subscribeWatch(event) {
  const res = await fetch(`${API_URL}/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: event.id,
      date: event.start,
      title: event.title,
      center: event.centerName,
      facility: event.facility,
      sport: event.sport || event.calendarName,
      url: event.url,
      registrationOpens: event.registrationOpens,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to subscribe (${res.status})`);
  }
  return res.json();
}

export async function listWatches() {
  const res = await fetch(`${API_URL}/watch`);
  if (!res.ok) throw new Error(`Failed to list watches (${res.status})`);
  return res.json();
}

export async function cancelWatch(watchId) {
  const res = await fetch(`${API_URL}/watch/${encodeURIComponent(watchId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to cancel watch (${res.status})`);
  return res.json();
}
