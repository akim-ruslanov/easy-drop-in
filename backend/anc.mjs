import { CENTRES } from './centres.mjs';
import { readFeedCache, writeFeedCache } from './cache.mjs';

const BASE = 'https://anc.ca.apm.activecommunities.com/vancouver';

// Sports-related drop-in calendars on the Vancouver ANC site.
const SPORTS_CALENDARS = (process.env.SPORTS_CALENDARS || '46,10,9,15,11,49,5')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const SESSION_TTL_MS = 5 * 60 * 1000;
// The merged feed lives in S3 between cold starts. 30 minutes keeps S3 writes
// to at most ~1,440/month (free tier allows 2,000 PUT), while schedules rarely
// change faster than that. Spots are cached separately and much more briefly.
const FEED_TTL_MS = Number(process.env.FEED_TTL_MS || 30 * 60 * 1000);
const SPOTS_TTL_MS = Number(process.env.SPOTS_TTL_MS || 5 * 60 * 1000);
// Bump whenever the shape/semantics of a cached feed changes so stale entries
// (including S3 objects) are ignored instead of served.
const CACHE_VERSION = 2;
const SPOTS_CONCURRENCY = 16;
let cachedSession = null;
let cachedEvents = null;
const cachedSpots = new Map();

function serialize(cookies) {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function primeSession() {
  let url = `${BASE}/calendars?onlineSiteId=0&no_scroll_top=true&defaultCalendarId=10&locationId=38&displayType=0&view=2`;
  const cookies = new Map();

  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: serialize(cookies) },
    });

    for (const h of res.headers.getSetCookie()) {
      const pair = h.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }

    const html = await res.text();
    const m = html.match(/csrfToken = "([^"]+)"/);
    if (!m) throw new Error(`CSRF token not found (status ${res.status})`);
    return { cookie: serialize(cookies), csrf: m[1] };
  }
  throw new Error('Too many redirects while priming session');
}

async function getSession() {
  if (cachedSession && Date.now() < cachedSession.expiresAt) return cachedSession.session;
  const session = await primeSession();
  cachedSession = { session, expiresAt: Date.now() + SESSION_TTL_MS };
  return session;
}

function invalidateSession() {
  cachedSession = null;
}

async function ancFetch(session, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'X-CSRF-Token': session.csrf,
      Cookie: session.cookie,
      Origin: 'https://anc.ca.apm.activecommunities.com',
      Referer: `${BASE}/calendars`,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`ANC ${method} ${path} failed (${res.status})`);
  return res.json();
}

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPrice(price) {
  if (!price) return '';
  if (price.free) return 'Free';
  for (const p of price.prices || []) {
    const std = (p.details || []).find((d) => /standard/i.test(d.description || ''));
    if (std) return std.price;
  }
  return price.estimate_price || '';
}

function cleanName(name) {
  return (name || '').replace(/^\*/, '').trim();
}

function ageGroupName(name) {
  return (name || '').replace(/^\d+\s*-\s*/, '').trim();
}

// ANC's calendars are not sport-homogeneous (e.g. the "Basketball" calendar
// also lists tennis lessons, Zumba and volleyball), so classify each event by
// its title instead of trusting calendar_id. Labels match the calendar names
// the UI and calendar colours already use.
const SPORT_RULES = [
  ['Sports: Ball & Floor Hockey', /hockey|shinny/i],
  ['Sports: Basketball', /basket|hoop/i],
  ['Sports: Racquet Sports', /tennis|badminton|pickle|racquet|squash/i],
  ['Sports: Volleyball', /volley/i],
  ['Sports: Soccer', /soccer|futsal/i],
  ['Open Gym Times', /open gym|drop-?in gym|gym/i],
];

function classifySport(title) {
  for (const [name, re] of SPORT_RULES) if (re.test(title || '')) return name;
  return 'Sports: Other';
}

function parseOpenSpots(spaceStatus) {
  if (!spaceStatus) return null;
  const m = /(\d+)\s*openings?/i.exec(spaceStatus);
  if (m) return parseInt(m[1], 10);
  if (/full/i.test(spaceStatus)) return 0;
  return null;
}

// The datetime online registration opens, taken from the activity detail. ANC
// exposes it under enrollment_datetimes (and, less commonly, the priority
// buckets). Events with an opening but a future registration date get a
// "remind me" calendar entry instead of a sign-up link.
function parseRegistrationOpens(detail) {
  const dates = detail && detail.meeting_and_registration_dates;
  if (!dates) return null;

  const values = [];
  const collect = (d) => {
    if (!d) return;
    for (const key of ['first_daytime_internet', 'drop_in_first_daytime_internet']) {
      if (d[key]) values.push(d[key]);
    }
  };
  for (const d of dates.enrollment_datetimes || []) collect(d);
  if (!values.length) {
    collect(dates.priority_enrollment_datetimes);
    collect(dates.local_priority_enrollment_datetimes);
  }
  if (!values.length) return null;
  values.sort();
  return values[0];
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function slimEvent(center, calendarId, calendarName, e) {
  return {
    id: e.event_item_id,
    title: e.title,
    start: e.start_time,
    end: e.end_time,
    description: stripHtml(e.description),
    centerId: center.center_id,
    centerName: cleanName(center.center_name),
    facility: (e.facilities && e.facilities[0] && e.facilities[0].facility_name) || '',
    url: e.activity_detail_url || '',
    price: extractPrice(e.price),
    calendarId,
    calendarName,
  };
}

async function getCalendars(session) {
  const data = await ancFetch(session, '/rest/onlinecalendar/calendars');
  const map = {};
  for (const c of data.body.calendars) map[c.calendar_id] = cleanName(c.name);
  return map;
}

async function getFiltersBody(session, calendarId) {
  const data = await ancFetch(session, '/rest/onlinecalendar/filters?locale=en-US', {
    method: 'POST',
    body: { calendar_id: calendarId },
  });
  return data.body;
}

async function getActivityDetail(session, activityId, selectedDate) {
  const path = `/rest/onlinecalendar/activity-details/${activityId}?selected_date=${encodeURIComponent(
    selectedDate,
  )}`;
  const data = await ancFetch(session, path);
  return data.body.activity_detail;
}

async function getEventsForCalendar(session, calendarId, centerIds) {
  const data = await ancFetch(session, '/rest/onlinecalendar/multicenter/events', {
    method: 'POST',
    body: {
      calendar_id: calendarId,
      center_ids: centerIds,
      display_all: 0,
    },
  });
  return data.body.center_events || [];
}

export function getCentres() {
  return CENTRES;
}

export async function getEvents() {
  if (cachedEvents && Date.now() < cachedEvents.expiresAt) return cachedEvents.events;

  const persisted = await readFeedCache();
  if (
    persisted &&
    persisted.version === CACHE_VERSION &&
    persisted.expiresAt > Date.now() &&
    Array.isArray(persisted.events)
  ) {
    cachedEvents = persisted;
    return persisted.events;
  }

  let session;
  try {
    session = await getSession();
  } catch (e) {
    invalidateSession();
    throw e;
  }

  const calendarNames = await getCalendars(session);
  const calendars = SPORTS_CALENDARS.filter((id) => calendarNames[id]);

  const filterBodies = await Promise.all(calendars.map((id) => getFiltersBody(session, id)));

  // Union of centres across calendars (each calendar's filters only lists
  // centres that offer that sport, so a single calendar is insufficient).
  const centerIds = [];
  const seenCenter = new Set();
  for (const f of filterBodies) {
    for (const c of f.center) {
      if (!seenCenter.has(c.id)) {
        seenCenter.add(c.id);
        centerIds.push(c.id);
      }
    }
  }

  // Map activity id -> age group, using the ANC sub-category for each calendar.
  const subCategories = {};
  const activityAge = {};
  for (const f of filterBodies) {
    for (const s of f.activity_sub_category) subCategories[s.id] = s.name;
    for (const a of f.activity) {
      if (!(a.id in activityAge)) activityAge[a.id] = a.sub_category_id;
    }
  }

  const results = await Promise.all(
    calendars.map((id) => getEventsForCalendar(session, id, centerIds)),
  );

  const events = [];
  results.forEach((centerEvents, i) => {
    for (const center of centerEvents) {
      for (const e of center.events) {
        const sub = activityAge[e.event_item_id];
        events.push({
          ...slimEvent(center, calendars[i], calendarNames[calendars[i]], e),
          sport: classifySport(e.title),
          ageGroup: sub != null ? ageGroupName(subCategories[sub]) : '',
        });
      }
    }
  });

  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const entry = { version: CACHE_VERSION, events, expiresAt: Date.now() + FEED_TTL_MS };
  cachedEvents = entry;
  await writeFeedCache(entry).catch(() => {});
  return events;
}

// Open-spot counts are only available per activity, so the frontend requests
// them lazily for the events it is about to display. `items` is a list of
// { id, date } pairs; duplicate ids keep their first requested date.
export async function getSpots(items) {
  const unique = new Map();
  for (const { id, date } of items) {
    if (id && date && !unique.has(id)) unique.set(id, date);
  }

  const out = {};
  const missing = [];
  const now = Date.now();
  for (const id of unique.keys()) {
    const hit = cachedSpots.get(id);
    if (hit && now < hit.expiresAt) out[id] = hit.value;
    else missing.push(id);
  }

  if (missing.length) {
    let session;
    try {
      session = await getSession();
    } catch (e) {
      invalidateSession();
      throw e;
    }

    const fetched = await mapWithConcurrency(missing, SPOTS_CONCURRENCY, async (id) => {
      try {
        const detail = await getActivityDetail(session, id, unique.get(id));
        return {
          openSpots: parseOpenSpots(detail.space_status),
          spaceStatus: detail.space_status || '',
          registrationOpens: parseRegistrationOpens(detail),
        };
      } catch {
        return { openSpots: null, spaceStatus: '', registrationOpens: null };
      }
    });

    missing.forEach((id, i) => {
      cachedSpots.set(id, { value: fetched[i], expiresAt: Date.now() + SPOTS_TTL_MS });
      out[id] = fetched[i];
    });
  }

  return out;
}

// Query-string format: "items=620705~2026-09-13 14:00:00,620706~2026-09-14 10:00:00".
export function parseSpotItems(raw) {
  if (!raw) return [];
  const items = [];
  for (const part of String(raw).split(',')) {
    const sep = part.indexOf('~');
    if (sep <= 0) continue;
    const id = parseInt(part.slice(0, sep), 10);
    const date = part.slice(sep + 1).trim();
    if (id && date) items.push({ id, date });
  }
  return items;
}
