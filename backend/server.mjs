import { createServer } from 'node:http';
import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';
import { createWatch, listWatches, deleteWatch, runWatch } from './watch.mjs';
import { signUp, logIn, currentUser, updateProfile, sessionFrom, cleanWebhook } from './auth.mjs';
import { sendNotification } from './notify.mjs';

const PORT = process.env.PORT || 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// Local server has no API Gateway, so normalise the incoming request into the
// shape `sessionFrom` expects.
function asEvent(req) {
  return { headers: req.headers };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname.endsWith('/events')) {
    try {
      const [centres, events] = await Promise.all([getCentres(), getEvents()]);
      send(res, 200, { centres, events });
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Upstream community centre API unavailable' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/spots')) {
    try {
      const spots = await getSpots(parseSpotItems(url.searchParams.get('items')));
      send(res, 200, { spots });
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Upstream community centre API unavailable' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/geocode')) {
    try {
      const result = await geocode(url.searchParams.get('q'));
      if (!result) return send(res, 404, { error: 'Location not found' });
      send(res, 200, result);
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Geocoding unavailable' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.endsWith('/auth/signup')) {
    try {
      send(res, 201, await signUp(await readBody(req)));
    } catch (e) {
      send(res, 400, { error: e.message || 'Could not create account' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.endsWith('/auth/login')) {
    try {
      send(res, 200, await logIn(await readBody(req)));
    } catch (e) {
      send(res, 401, { error: e.message || 'Could not sign in' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/auth/me')) {
    try {
      const user = await currentUser(sessionFrom(asEvent(req)));
      if (!user) return send(res, 401, { error: 'Not signed in' });
      send(res, 200, { user });
    } catch (e) {
      console.error(e);
      send(res, 500, { error: 'Could not load account' });
    }
    return;
  }

  if (req.method === 'PUT' && url.pathname.endsWith('/profile')) {
    try {
      const session = sessionFrom(asEvent(req));
      if (!session) return send(res, 401, { error: 'Not signed in' });
      send(res, 200, { user: await updateProfile(session, await readBody(req)) });
    } catch (e) {
      console.error(e);
      send(res, 400, { error: e.message || 'Could not update profile' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.endsWith('/notify/test')) {
    const session = sessionFrom(asEvent(req));
    if (!session) return send(res, 401, { error: 'Sign in to test notifications' });
    try {
      const config = cleanWebhook(await readBody(req));
      if (!config) return send(res, 400, { error: 'Enter a valid webhook URL (https://…)' });
      await sendNotification({
        title: 'Easy Drop-In',
        text: 'Test notification — your webhook is working!',
        config,
      });
      send(res, 200, { sent: true });
    } catch (e) {
      console.error(e);
      send(res, 400, { error: e.message || 'Test notification failed' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.endsWith('/watch')) {
    const session = sessionFrom(asEvent(req));
    if (!session) return send(res, 401, { error: 'Sign in to create alerts' });
    try {
      send(res, 201, await createWatch(await readBody(req), { email: session.email }));
    } catch (e) {
      console.error(e);
      send(res, 400, { error: e.message || 'Could not create watch' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/watch')) {
    const session = sessionFrom(asEvent(req));
    if (!session) return send(res, 401, { error: 'Sign in to view alerts' });
    try {
      send(res, 200, { watches: await listWatches(session.email) });
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Could not list watches' });
    }
    return;
  }

  // Dev-only: fire a watch immediately (no Scheduler locally).
  if (req.method === 'POST' && url.pathname.endsWith('/watch/run')) {
    try {
      send(res, 200, await runWatch(await readBody(req)));
    } catch (e) {
      console.error(e);
      send(res, 502, { error: e.message || 'Watch run failed' });
    }
    return;
  }

  if (req.method === 'DELETE' && /\/watch\/[^/]+$/.test(url.pathname)) {
    const session = sessionFrom(asEvent(req));
    if (!session) return send(res, 401, { error: 'Sign in to manage alerts' });
    try {
      const watchId = decodeURIComponent(url.pathname.split('/').pop());
      send(res, 200, await deleteWatch(watchId, session.email));
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Could not delete watch' });
    }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}/events`));
