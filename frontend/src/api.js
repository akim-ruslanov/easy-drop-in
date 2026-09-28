const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const TOKEN_KEY = 'edi_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function headers({ json = false, auth = false } = {}) {
  const h = json ? { 'Content-Type': 'application/json' } : {};
  if (auth) {
    const t = getToken();
    if (t) h.Authorization = `Bearer ${t}`;
  }
  return h;
}

async function parse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function fetchData() {
  return parse(await fetch(`${API_URL}/events`));
}

// Open-spot counts are fetched only for the events about to be displayed.
// `items` is a list of { id, date } pairs.
export async function fetchSpots(items) {
  const params = new URLSearchParams({
    items: items.map(({ id, date }) => `${id}~${date}`).join(','),
  });
  return parse(await fetch(`${API_URL}/spots?${params}`));
}

export async function geocode(query) {
  return parse(await fetch(`${API_URL}/geocode?q=${encodeURIComponent(query)}`));
}

// --- accounts ---

export async function signup(email, password) {
  const d = await parse(
    await fetch(`${API_URL}/auth/signup`, {
      method: 'POST',
      headers: headers({ json: true }),
      body: JSON.stringify({ email, password }),
    }),
  );
  setToken(d.token);
  return d.user;
}

export async function login(email, password) {
  const d = await parse(
    await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: headers({ json: true }),
      body: JSON.stringify({ email, password }),
    }),
  );
  setToken(d.token);
  return d.user;
}

export async function fetchMe() {
  const d = await parse(await fetch(`${API_URL}/auth/me`, { headers: headers({ auth: true }) }));
  return d.user;
}

export async function saveProfile(profile) {
  const d = await parse(
    await fetch(`${API_URL}/profile`, {
      method: 'PUT',
      headers: headers({ json: true, auth: true }),
      body: JSON.stringify(profile),
    }),
  );
  return d.user;
}

export async function testNotification(webhook) {
  return parse(
    await fetch(`${API_URL}/notify/test`, {
      method: 'POST',
      headers: headers({ json: true, auth: true }),
      body: JSON.stringify(webhook),
    }),
  );
}

// --- registration alerts (signed in) ---

export async function subscribeWatch(event) {
  return parse(
    await fetch(`${API_URL}/watch`, {
      method: 'POST',
      headers: headers({ json: true, auth: true }),
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
    }),
  );
}

export async function listWatches() {
  const d = await parse(await fetch(`${API_URL}/watch`, { headers: headers({ auth: true }) }));
  return d;
}

export async function cancelWatch(watchId) {
  return parse(
    await fetch(`${API_URL}/watch/${encodeURIComponent(watchId)}`, {
      method: 'DELETE',
      headers: headers({ auth: true }),
    }),
  );
}
