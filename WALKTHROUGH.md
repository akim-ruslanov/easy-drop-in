# Easy Drop-In — Code Walkthrough

This document is for a developer who is comfortable with software engineering
but new to this particular stack. It explains what each file does, how the
pieces talk to each other, how the app behaves at runtime on AWS, and how to
deploy it.

---

## 0. The stack in one paragraph

- **Frontend** — React 18 with **Vite 6** as the build tool/dev server and
  **Tailwind CSS v4** for styling. Plain JavaScript + JSX, no TypeScript, no
  router, no state library. It builds to a folder of static files.
- **Backend** — Node.js using **ES modules** (`.mjs` files). No web framework;
  it uses the built-in global `fetch` (Node 18+). There are two entry points:
  `server.mjs` for local development and `index.mjs` for AWS Lambda.
- **AWS** — the backend runs as a **Lambda** function behind an **API Gateway
  HTTP API**, and caches its merged feed in a small **S3** object.
- **Deployment** — the backend is deployed with **AWS SAM** (a CLI on top of
  CloudFormation). The frontend is built by **GitHub Actions** and published to
  **GitHub Pages**.

If you know Express/Node, the backend will feel familiar except for the Lambda
handler signature and the S3 cache. If you know React, the frontend is a single
component tree with hooks; the only non-obvious part is the lazy spot-loading
effect.

---

## 1. Why a backend exists at all

The data comes from the City of Vancouver's **ActiveNet (ANC)** calendar API at
`anc.ca.apm.activecommunities.com/vancouver`. That API:

1. Requires a server-side **session cookie** (it redirects a few times to set
   cookies), and
2. Requires a per-session **CSRF token** scraped from the calendar HTML page, and
3. Does **not** send permissive CORS headers.

A browser therefore cannot call it directly. The backend acts as a proxy: it
primes a session, calls ANC on the server, normalizes the data, and returns one
compact JSON feed. This is the entire reason the `backend/` folder exists.

There is one important domain wrinkle baked into the code: ANC's calendars are
**not sport-homogeneous** (the "Basketball" calendar also lists tennis lessons
and Zumba), and open-spot counts are only available one activity at a time.
Both facts drive design decisions below.

---

## 2. Repository map

```
easy-drop-in/
├── dev.sh                    # start backend + frontend together locally
├── docker-compose.yml        # single-container local run
├── Dockerfile                # builds frontend, serves it + backend
├── README.md
├── .github/workflows/deploy.yml   # GitHub Pages deploy of the frontend
├── backend/
│   ├── index.mjs             # AWS Lambda handler (production entry point)
│   ├── server.mjs            # local-only HTTP server (dev entry point)
│   ├── anc.mjs               # core ANC proxy logic + caching
│   ├── cache.mjs             # persistent feed cache (S3 or local file)
│   ├── centres.mjs           # static list of 24 community centres + coords
│   ├── geocode.mjs           # Nominatim address -> lat/lng proxy
│   ├── template.yaml         # AWS SAM/CloudFormation deployment template
│   └── package.json          # no runtime deps (AWS SDK is in the Lambda runtime)
└── frontend/
    ├── index.html            # Vite HTML entry
    ├── vite.config.js        # React + Tailwind plugins, relative base path
    ├── package.json
    └── src/
        ├── main.jsx          # React bootstrap
        ├── App.jsx           # all state, filtering, data fetching
        ├── api.js            # fetch wrappers for the backend
        ├── index.css         # Tailwind import
        ├── components/       # CalendarGrid, EventRow, EventModal, SpotsBadge, CentreFilter
        └── lib/              # dates.js, geo.js, calendar.js (pure helpers)
```

---

## 3. Backend

### 3.1 The two entry points

**`server.mjs`** is a thin, dependency-free HTTP server (`node:http`) used only
for local development. It routes three paths and adds CORS. It exists so you can
run the backend with plain `node server.mjs` without any AWS tooling.

**`index.mjs`** is the same logic expressed as a **Lambda handler**:

```js
export async function handler(event) { ... }
```

Conceptual mapping from a normal web server to Lambda:

| Web server concept        | Lambda equivalent |
|---------------------------|-------------------|
| `req.method` / `req.url`  | `event.httpMethod` (REST) or `event.requestContext.http.method`, and `event.path` / `event.rawPath` |
| `req` body                | JSON string in `event.body` (here unused; only GET) |
| `res.writeHead` + `res.end` | return `{ statusCode, headers, body }` |

`event.queryStringParameters` is a plain object of query params. The handler
returns a **plain object**; API Gateway serializes it to HTTP. Because SAM is
configured to auto-CORS the HTTP API, the handler also has its own `CORS`
constant for the local server and defense in depth.

Route table (both entry points behave identically):

| Method | Path       | Purpose |
|--------|------------|---------|
| GET    | `/events`  | full merged feed (centres + events), no open-spot counts |
| GET    | `/spots`   | open-spot counts for requested `items` |
| GET    | `/geocode` | address string -> `{ lat, lng, name }` via Nominatim |
| OPTIONS| any        | CORS preflight |

`path.endsWith(...)` is used rather than exact equality because API Gateway adds
a stage prefix (so the real path may be `/<stage>/events`).

### 3.2 `anc.mjs` — the core

This is where nearly all interesting logic lives.

#### Configuration (top of file)

- `BASE` — ANC host.
- `SPORTS_CALENDARS` — comma-separated ANC calendar ids, from env var
  `SPORTS_CALENDARS` (default `46,10,9,15,11,49,5`).
- `UA` — a desktop browser User-Agent; ANC rejects some default clients.
- `SESSION_TTL_MS` (5 min), `FEED_TTL_MS` (30 min, env-overridable),
  `SPOTS_TTL_MS` (5 min, env-overridable).
- `CACHE_VERSION` — **bump this whenever the shape of the cached feed changes**;
  stale S3/local cache entries are then ignored instead of served.
- `cachedSession`, `cachedEvents`, `cachedSpots` — module-level in-memory caches.
  In Lambda these live only as long as the container is warm.

#### Session priming (lines 33–71)

`primeSession()` requests the calendars page with `redirect: 'manual'`, follows
up to 6 redirects manually while accumulating `Set-Cookie` headers into a map,
then scrapes the CSRF token out of the returned HTML with a regex. It returns
`{ cookie, csrf }`. `getSession()` memoizes it for `SESSION_TTL_MS`. If any
downstream call throws, `invalidateSession()` clears it so the next request
re-primes.

This mirrors what a browser does: cookies plus a hidden CSRF field.

#### `ancFetch` (lines 73–90)

Adds the session cookie, `X-CSRF-Token`, `Origin`, `Referer`, and UA to every
call, and parses JSON. Throws a descriptive error on non-2xx.

#### Normalization helpers (lines 92–148)

- `stripHtml` — ANC descriptions contain HTML; flatten to text.
- `extractPrice` — prefer a "Standard charge" price, else `estimate_price` or
  "Free".
- `cleanName` — strip a leading `*` from centre names.
- `ageGroupName` — ANC sub-categories look like `"6 - Adult"`; strip the numeric
  prefix.
- `classifySport` — maps an event **title** to one of the seven UI sport groups
  via `SPORT_RULES`. This is deliberately keyword-based because the calendar is
  unreliable (see §1). Order matters: e.g. `Racquet` is checked before
  `Volleyball` so "Pickleball … Volley Smart" is racquet, not volleyball.
  Anything unmatched becomes `Sports: Other`.
- `parseOpenSpots` — turns `"8 openings remaining"` into `8`, `"Full"` into `0`,
  else `null`.
- `parseRegistrationOpens` — reads
  `meeting_and_registration_dates.enrollment_datetimes[*].first_daytime_internet`
  (falling back to the priority buckets) and returns the earliest online
  registration-open datetime, or `null`. Drives the "remind me" feature.

#### `slimEvent` (lines 163–178)

Maps one ANC event object to the app's slim shape:
`{ id, title, start, end, description, centerId, centerName, facility, url,
price, calendarId, calendarName }`. `id` is ANC's `event_item_id`, which is
actually the **activity id** (shared by all occurrences of a recurring activity).

#### `getEvents()` — the main feed builder (lines 219–292)

Flow:

1. Return the **in-memory** feed if fresh.
2. Otherwise read the **persistent** cache (`readFeedCache()`), and return it if
   it is the current `CACHE_VERSION` and unexpired.
3. Prime a session.
4. `GET /onlinecalendar/calendars` to get `calendar_id -> name`.
5. Fetch **filters** (`POST /onlinecalendar/filters`) for every selected
   calendar. The union of `f.center` across all filters gives the set of centre
   ids (a single calendar only lists centres offering that sport).
6. Build two lookup tables from the filters:
   `subCategories[id] -> name` and `activityAge[activityId] -> subCategoryId`.
7. Fetch events for every calendar in parallel
   (`POST /onlinecalendar/multicenter/events` with the centre id list).
8. Flatten `center_events` into `events[]`, attaching `sport` (title
   classification) and `ageGroup`.
9. Sort by start time, write the result to the persistent cache, and return.

Note the currency: this is ~1 + 1 + N(calendars) filters + N(calendars) event
calls — roughly **16 upstream calls**, no matter how many events. Open spots are
*not* fetched here.

#### `getSpots()` (lines 297–337)

Invoked by `/spots`. Input is a list of `{ id, date }` pairs. It:

1. Dedupes by id (first date wins).
2. Serves any entries from the in-memory `cachedSpots` map.
3. Fetches the rest concurrently (`mapWithConcurrency`, limit 16) via
   `GET /onlinecalendar/activity-details/{id}?selected_date=...`.
4. Caches each result for `SPOTS_TTL_MS` and returns
   `{ [id]: { openSpots, spaceStatus, registrationOpens } }`.

Failure to fetch one activity yields `{ openSpots: null, spaceStatus: '' }`
rather than failing the whole request.

#### `parseSpotItems()` (lines 340–351)

Parses the query format
`items=620705~2026-09-13 14:00:00,620706~2026-09-14 10:00:00` (a `~` separates
id from the selected date; `,` separates items; the frontend URL-encodes it).

#### `mapWithConcurrency` (lines 150–161)

A small worker-pool helper: runs up to `limit` instances of `fn` at a time over
an array and preserves result order. Used to avoid firing hundreds of parallel
requests at ANC.

### 3.3 `cache.mjs` — persistent cache

A deliberately tiny module with `readFeedCache()` / `writeFeedCache(data)`.

- If env var **`CACHE_BUCKET`** is set (which it is in Lambda), it reads/writes a
  **single S3 object** (`CACHE_KEY`, default `feed.json`) using
  `@aws-sdk/client-s3`. The SDK is **not** a dependency in `package.json`
  because the `nodejs20.x` Lambda runtime ships it — the import is dynamic so it
  never loads during local file-based operation.
- Otherwise (local dev) it uses `backend/.cache/feed.json`.

Storing one object is intentional: one GET per cold start and one PUT per
rebuild keeps S3 usage inside the free tier. Both read and write swallow errors,
so a cache outage degrades to a rebuild rather than a failure.

### 3.4 `centres.mjs` and `geocode.mjs`

- `centres.mjs` is a static array of the 24 centres with id, name, address and
  pre-geocoded coordinates. `/events` returns it verbatim so the frontend can
  compute distances without an external service.
- `geocode.mjs` proxies OpenStreetMap **Nominatim** for the "enter a location"
  feature. It has its own in-memory `Map` cache keyed by lowercased query. Note
  it returns `null` rather than throwing when nothing matches.

---

## 4. HTTP API contract

All responses are JSON. CORS is open (`*`).

### `GET /events`

```json
{
  "centres": [
    { "id": 38, "name": "Britannia Community Centre", "address": "...", "lat": 49.27, "lng": -123.07 }
  ],
  "events": [
    {
      "id": 620746,
      "title": "Basketball - Sun 2pm",
      "start": "2026-09-13 14:00:00",
      "end": "2026-09-13 16:00:00",
      "description": "Come get your sweat on ...",
      "centerId": 38,
      "centerName": "Britannia Community Centre",
      "facility": "Gymnasium C",
      "url": "https://ca.apm.activecommunities.com/vancouver/Activity_Search/...",
      "price": "$98.00",
      "calendarId": 10,
      "calendarName": "Sports: Basketball",
      "sport": "Sports: Basketball",
      "ageGroup": "Adult"
    }
  ]
}
```

`openSpots` / `spaceStatus` are **absent** here by design; they come from
`/spots`. Datetime strings are naive local time (`YYYY-MM-DD HH:MM:SS`).

### `GET /spots?items=<id>~<date>,...`

```json
{
  "spots": {
    "620746": { "openSpots": 0, "spaceStatus": "Full", "registrationOpens": null },
    "620747": { "openSpots": 8, "spaceStatus": "8 openings remaining", "registrationOpens": "2026-09-18 12:00:00" }
  }
}
```

`registrationOpens` is the online registration-open datetime (naive local time),
or `null` when registration is already open or unavailable.

### `GET /geocode?q=<address>`

```json
{ "lat": 49.2827, "lng": -123.1207, "name": "Vancouver, Metro Vancouver, British Columbia, Canada" }
```

Returns `404 { "error": "Location not found" }` when Nominatim has no match.

---

## 5. Frontend

### 5.1 Tooling

- **Vite** is the dev server and bundler. `npm run dev` starts it; `npm run
  build` writes static files to `frontend/dist`.
- **Tailwind v4** is wired through the `@tailwindcss/vite` plugin (see
  `vite.config.js`); `src/index.css` just imports Tailwind and is imported once
  in `main.jsx`.
- `base: './'` makes built asset URLs **relative**, which matters because GitHub
  Pages serves the site under a repository subpath.
- Vite exposes environment variables prefixed with `VITE_` on
  `import.meta.env`. Critically, these are **inlined at build time**, not read at
  runtime. Changing `VITE_API_URL` requires a rebuild.

### 5.2 Bootstrapping

`index.html` has a single `<div id="root">`. `main.jsx` mounts `<App />` into it
under React `StrictMode`. In development StrictMode intentionally double-invokes
effects — the spot-fetching effect is written to tolerate that.

### 5.3 `api.js`

Three thin wrappers, all using the global `fetch`:
`fetchData()` (`/events`), `fetchSpots(items)` (`/spots`, chunk-friendly), and
`geocode(query)` (`/geocode`). The base URL is
`import.meta.env.VITE_API_URL || 'http://localhost:8787'`.

### 5.4 `App.jsx` — data flow (the important part)

All application state is in this one component. Key pieces:

**State.** Filter inputs (`query`, `sport`, `ageGroup`, `openSpotsOnly`,
`range`), view/navigation (`view`, `weekStart`), centre/location selection,
`selectedEvent` for the modal, `calendarMode` (`'google'` default, or `'ics'`),
and `spots` — a map of activity id -> spot info loaded lazily. `spotsInFlight`
is a `useRef(Set)` used to dedupe concurrent requests without triggering
re-renders.

**Derived data (a pipeline of `useMemo`s).** Read it top to bottom:

```
data.events  (from /events)
   │  merge in spots loaded so far
   ▼
eventsWithSpots
   │  filter: sport, ageGroup, selected centre, text query
   ▼
visibleEvents
   ├─ filter by current week  ─► weekEvents   (calendar view)
   └─ filter by date range    ─► listEvents   (list view)
```

Then, conditionally on `openSpotsOnly`, `weekEvents` / `listEvents` are further
filtered into `filteredWeekEvents` / `filteredListEvents`, and the list is
grouped by day for rendering.

**Lazy spot loading.** The effect at `App.jsx:98` looks at whichever set is on
screen (`weekEvents` for calendar, `listEvents` for list), skips ids already in
`spots` or already in flight, then requests the rest in chunks of 50 and merges
the responses into `spots`. Consequences:

- The first paint does not wait for spot counts; badges appear shortly after.
- Only on-screen activities cost upstream calls (typically tens, not ~700).
- Selecting a large list range ("All upcoming") legitimately requests more.
- Because `eventsWithSpots` feeds `visibleEvents`, the sport/age/centre filters
  operate on the merged objects and re-run automatically as spots arrive.

**Centre/location logic.** `toggleCentre` implements tri-state selection (`null`
= all, a `Set` = explicit subset). `applyRadius` picks centres within `radiusKm`
of a location using `haversineKm`. `useLocation` wraps the browser Geolocation
API; `setLocationByText` calls the backend `/geocode`.

### 5.5 Components

- **`CalendarGrid`** — a week grid. `layoutDay` runs an interval-overlap
  algorithm to place concurrent events side by side in columns. Colour is chosen
  from `COLOURS` keyed by `event.sport` (falling back to `calendarName`).
- **`EventRow`** — list row: time, title, spot badge, price, location line, an
  amber "registration opens …" note when applicable, expandable description,
  sign-up link, a "Remind me" button, and an "add to calendar" button. Button
  behaviour follows the global `calendarMode`.
- **`EventModal`** — details for a clicked calendar event, including the
  registration-open note and reminder button.
- **`SpotsBadge`** — renders "N spots" / "Full", or nothing when data is absent.
- **`CentreFilter`** — the dropdown: centre search, "use my location", a typed
  location, radius selector, distance-sorted list, All/None.

### 5.6 `lib/`

- `dates.js` — parsing ANC's naive datetime strings (`replace(' ', 'T')`),
  week/day math, and locale formatting (`en-CA`).
- `geo.js` — `haversineKm` and distance formatting.
- `calendar.js` — client-side calendar actions. `googleCalendarUrl({ title,
  start, end, details, location })` builds a pre-filled Google Calendar compose
  URL (datetimes converted to UTC `YYYYMMDDTHHMMSSZ`). `addEventToCalendar(event,
  mode)` and `addRegistrationReminder(event, opensAt, mode)` dispatch on `mode`:
  `'google'` (default) opens the URL in a new tab; `'ics'` downloads a file via
  `downloadIcs` / `downloadRegistrationReminder`. The reminder variant is a
  15-minute block (with a 10-minute VALARM) at the registration-open time.
- The global `calendarMode` state (default `'google'`) lives in `App.jsx` and is
  passed down to `EventRow` and `EventModal`; the header segmented control
  toggles it.
- Registration-open datetimes flow: `parseRegistrationOpens` (backend) →
  `/spots` → merged onto the event in `App.jsx` as `registrationOpens` → compared
  against `new Date()` in the components; if it is in the future the reminder UI
  is shown, otherwise the normal sign-up flow applies.

---

## 6. Running locally

```bash
./dev.sh                 # installs frontend deps on first run, starts both
# or
cd backend && node server.mjs          # http://localhost:8787
cd frontend && npm install && npm run dev   # http://localhost:5173
```

- Backend reads/writes `backend/.cache/feed.json` (gitignored) as its persistent
  cache; delete it to force a cold rebuild.
- Frontend points at `http://localhost:8787` unless `VITE_API_URL` is set.
- `docker compose up --build` runs both in one container via the `Dockerfile`
  (builds the frontend, then serves `vite preview` and the backend).

---

## 7. Deployment

### 7.1 Backend — AWS SAM

`backend/template.yaml` is a **SAM/CloudFormation** template. SAM is declarative:
you describe resources and `sam build && sam deploy` diffs and applies them.

```bash
cd backend
sam build
sam deploy --guided
```

`sam build` stages the function code into `.aws-sam/build`. Because
`package.json` has no dependencies, it is essentially a copy step — the AWS SDK
comes from the Lambda runtime. `sam deploy --guided` asks for stack name, region
and confirmation the first time, then writes `samconfig.toml`; subsequent
deploys are just `sam deploy`.

What the template creates:

| Resource            | Type                        | Role |
|---------------------|-----------------------------|------|
| `FeedCacheBucket`   | `AWS::S3::Bucket`           | holds the single cached feed object; a lifecycle rule expires objects after 7 days as a safety net |
| `EventsFunction`    | `AWS::Serverless::Function` | the Lambda running `index.handler` |
| `Api`               | `AWS::Serverless::HttpApi`  | API Gateway HTTP API with open CORS |
| `GetEvents`/`GetSpots` events | `HttpApi` events   | route `GET /events` and `GET /spots` to the function |
| `ApiUrl`            | Output                      | prints the base URL |

Function configuration:

- Runtime `nodejs20.x`, 60 s timeout, 512 MB.
- Environment: `SPORTS_CALENDARS`, `CACHE_BUCKET` (= the bucket's generated
  name), `CACHE_KEY=feed.json`, `FEED_TTL_MS=1800000` (30 min).
- IAM: an inline policy granting only `s3:GetObject` and `s3:PutObject` on the
  bucket (`${FeedCacheBucket.Arn}/*`) — least privilege. No other AWS access.

Deployment locations: Lambda + API Gateway + S3 in the chosen AWS region; the
`ApiUrl` output (e.g. `https://abc123.execute-api.us-west-2.amazonaws.com/events`)
is what the frontend needs.

Common config changes:

- **Which sports:** edit `SPORTS_CALENDARS` in `template.yaml` (or override in
  the console) and redeploy. Valid ids are printed by
  `GET /rest/onlinecalendar/calendars`.
- **Cache freshness vs S3 writes:** adjust `FEED_TTL_MS` (see §8).

### 7.2 Frontend — GitHub Pages

`.github/workflows/deploy.yml` runs on pushes to `main`:

1. `npm ci` in `frontend/`.
2. `npm run build` with `VITE_API_URL: ${{ secrets.VITE_API_URL }}` injected.
   This is where the API base URL is **compiled into** the JavaScript.
3. Upload `frontend/dist` and deploy it to GitHub Pages.

One-time setup: add a repository secret named `VITE_API_URL` containing the API
Gateway base (no `/events` suffix), e.g.
`https://abc123.execute-api.us-west-2.amazonaws.com`, and enable Pages with
"GitHub Actions" as the source. If the backend URL ever changes, update the
secret and re-run the workflow — the site will not pick it up otherwise.

The equivalent manual/Docker build is:

```bash
docker build --build-arg VITE_API_URL=https://your-api.execute-api.us-west-2.amazonaws.com -t easy-drop-in .
```

---

## 8. Runtime behaviour on AWS

### Request path

```
Browser (GitHub Pages static files)
   │  GET {VITE_API_URL}/events      (CORS, open)
   ▼
API Gateway HTTP API ──► Lambda (index.handler)
                            │
                            ├─ in-memory feed cache? return
                            ├─ else read S3 object (CACHE_KEY)
                            ├─ else prime ANC session, fetch calendars/
                            │    filters/events, classify, then PUT S3
                            ▼
                         JSON response

Browser then calls /spots for the visible events
   │
   ▼
Lambda ── per-id in-memory spot cache ── ANC activity-details
```

### Cold vs warm, and the three cache layers

A **cold start** is a fresh Lambda container: module-level `cachedSession`,
`cachedEvents` and `cachedSpots` are empty. A **warm** container keeps them.

1. **In-memory feed** (`cachedEvents`) — fastest, survives while warm, TTL
   `FEED_TTL_MS` (30 min).
2. **S3 feed** (`readFeedCache`) — survives cold starts. A cold container reads
   it and skips all upstream work if unexpired.
3. **Session / spot caches** — in-memory only. Spots are keyed per activity and
   refreshed every `SPOTS_TTL_MS` (5 min) because availability changes quickly;
   the feed is more static so it is cached longer.

`CACHE_VERSION` is the escape hatch: if you change the feed shape, bump it and
every stale S3 object is ignored and rebuilt on the next request.

### AWS free tier

- **Lambda:** always-free 1M requests + 400,000 GB-s per month. A page load is
  two invocations (`/events`, `/spots`). A cold rebuild is ~1–2 s at 512 MB
  (~0.5–1 GB-s); even heavy traffic stays far inside the limit.
- **S3:** 5 GB storage / 20,000 GET / 2,000 PUT per month for the first 12
  months. There is exactly one tiny object; a cold start costs one GET and a
  rebuild one PUT. At a 30-minute TTL the worst case is ~1,440 PUT/month. Raise
  `FEED_TTL_MS` if PUTs ever approach 2,000. (After the first year S3 is billed,
  but this usage is a few cents.)
- **API Gateway HTTP API:** 1M requests/month free for 12 months.

---

## 9. Common maintenance tasks

- **Add/remove a sport calendar:** update `SPORTS_CALENDARS` in
  `template.yaml` and redeploy. If it is a genuinely new sport group, add a rule
  to `SPORT_RULES` in `anc.mjs` and a colour entry to `COLOURS` in
  `CalendarGrid.jsx`.
- **Sport misclassification:** tune the regexes in `SPORT_RULES` (order
  matters). Bump `CACHE_VERSION` so cached feeds are regenerated.
- **Change feed shape:** always bump `CACHE_VERSION`; otherwise stale S3/local
  caches are served with missing fields.
- **Add an endpoint:** add a branch in both `server.mjs` and `index.mjs`, then
  declare a new `HttpApi` event (`Path`, `Method`) in `template.yaml` and
  redeploy. Add a wrapper in `frontend/src/api.js`.
- **Tune spot batching:** the frontend chunk size (50) is in `App.jsx:108`; the
  backend concurrency (16) is `SPOTS_CONCURRENCY` in `anc.mjs`.

---

## 10. Gotchas & conventions

- **Build-time env vars.** `VITE_*` values are baked into the bundle. A running
  frontend cannot be re-pointed at another API without a rebuild.
- **Naive datetimes.** ANC returns `YYYY-MM-DD HH:MM:SS` with no timezone;
  `parseTime` assumes local time. Do not mix in ISO `Z` strings.
- **`event_item_id` is an activity id.** Recurring occurrences share it, so
  spots and age group are per-activity, not per-occurrence.
- **Course-grained calendar ids are unreliable.** Always use the `sport` field
  for sport filtering/display, never `calendarName` alone.
- **Errors are swallowed at the edges.** `writeFeedCache` and individual spot
  fetches fail softly; the feed rebuild and `/events`/`/spots` handlers surface a
  `502` only when they cannot produce anything.
- **No framework, no dependencies in the backend.** Prefer built-ins
  (`node:http`, `fetch`, `node:fs/promises`) and the runtime-provided AWS SDK.
- **Formatting.** The codebase uses 2-space indentation and single quotes.
  There is no configured linter or test suite; verify changes by running
  `./dev.sh` and building (`npm run build` in `frontend/`).
