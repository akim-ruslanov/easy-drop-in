# Easy Drop-In

A single calendar of drop-in sports across Vancouver community centres, backed by the City of Vancouver's ActiveNet calendar API.

## Structure

- `frontend/` — React + Tailwind static site (Vite). Week calendar grid + list view, text search, sport filter, age-group filter, open-spots filter, centre filter (text search + "near me" via geolocation or a typed location, distance sort + radius), sign-up links, and a global "Add to: Google Calendar / .ics file" toggle (Google is the default) that applies to both "add event" and "remind me when registration opens" actions.
- `backend/` — Node proxy for the ActiveNet API (AWS Lambda + API Gateway). Merges 7 sports calendars across all 24 centres into one feed and returns centre metadata (address + coordinates) plus per-event age group. Open-spot counts are served separately by `/spots` on demand.

The ActiveNet API requires a server-side session cookie and a per-session CSRF token, so the browser cannot call it directly. The backend primes a session, fetches each sports calendar, and returns one slimmed, merged list.

## Run locally

One command starts both (installs frontend deps on first run):

```bash
./dev.sh
```

- Backend  → http://localhost:8787
- Frontend → http://localhost:5173

Press Ctrl+C to stop both.

Or start them separately:

```bash
cd backend && node server.mjs     # http://localhost:8787/events
cd frontend && npm install && npm run dev   # http://localhost:5173
```

The frontend defaults to `http://localhost:8787`; override with `VITE_API_URL`.

## Run with Docker

```bash
docker compose up --build
```

Then open http://localhost:5173 (API on http://localhost:8787). To point the built frontend at a different API URL, pass a build arg:

```bash
docker build --build-arg VITE_API_URL=https://your-api.execute-api.us-west-2.amazonaws.com -t easy-drop-in .
```

## Deploy

### Backend (AWS)

One-time bootstrap of the CI deploy role. This creates the GitHub OIDC provider (if missing), the `easy-drop-in-deploy` IAM role scoped to this repo/branch, and its permissions:

```bash
./bootstrap/setup-oidc-role.sh
```

Then add the role ARN the script prints as a repo secret `AWS_ROLE_ARN`:

```bash
gh secret set AWS_ROLE_ARN --body "arn:aws:iam::<ACCOUNT_ID>:role/easy-drop-in-deploy"
```

After that, `.github/workflows/deploy-backend.yml` builds and deploys with SAM on every push to `main` touching `backend/`, and can also be run on demand from the Actions tab.

To deploy manually instead:

```bash
cd backend
sam build && sam deploy --guided
```

`SPORTS_CALENDARS` (env var) controls which ANC calendars are merged. Default: `46,10,9,15,11,49,5` (floor hockey, basketball, volleyball, racquet sports, soccer, other sports, open gym).

### Frontend (GitHub Pages)

Add the API Gateway base URL as a repo secret `VITE_API_URL` (e.g. `https://abc123.execute-api.us-west-2.amazonaws.com`), then push to `main`. The `.github/workflows/deploy.yml` workflow builds and publishes `frontend/dist`.

## Notes

- Data comes from `anc.ca.apm.activecommunities.com/vancouver`; schedules are subject to change.
- ANC's calendars are not sport-homogeneous (the `Sports: Basketball` calendar also lists tennis lessons, Zumba, volleyball, etc.), so `backend/anc.mjs` classifies each event into a sport group from its title and the UI filters on that `sport` field.
- Sports calendars include both drop-in and registered programs. Prices (when present) are shown on each event.
- Centre coordinates are hardcoded in `backend/centres.mjs` (geocoded once); "near me" uses browser geolocation or a typed location (geocoded via the backend's `/geocode` endpoint, backed by OpenStreetMap Nominatim). Geolocation requires a secure context (localhost or HTTPS).
- Open spots come from the per-activity detail endpoint. Rather than fetching all ~700 upfront, the frontend asks `GET /spots?items=<id>~<date>,…` only for the events on screen; the backend caches each result for 5 minutes and fetches up to 16 at a time. The same response carries `registrationOpens` (the online registration open datetime), which drives the reminder option.
- The merged feed is cached in S3 (single object, `FEED_TTL_MS`, default 30 min) so a Lambda cold start reuses it instead of refetching every calendar. Locally it falls back to `backend/.cache/feed.json`. With one tiny object and at most one GET per cold start and one PUT per rebuild, usage stays inside the AWS free tier: S3 (5 GB, 20,000 GET, 2,000 PUT/month for 12 months) and Lambda (1M requests, 400,000 GB-s/month). Raise `FEED_TTL_MS` if PUTs ever approach the limit.

## TODO
- [ ] add a job for backend deployment
- [ ] ensure the roles/permissions are limited on aws
- [ ] add an option to add to calendar when registration opens later
- [ ] make the add to calendar open new tab in google calendar (download as a side option)