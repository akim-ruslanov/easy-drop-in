import { createServer } from 'node:http';
import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';
import { createWatch, listWatches, deleteWatch, runWatch } from './watch.mjs';

const PORT = process.env.PORT || 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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

  if (req.method === 'POST' && url.pathname.endsWith('/watch')) {
    try {
      send(res, 201, await createWatch(await readBody(req)));
    } catch (e) {
      console.error(e);
      send(res, 400, { error: e.message || 'Could not create watch' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/watch')) {
    try {
      send(res, 200, { watches: await listWatches() });
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
    try {
      const watchId = decodeURIComponent(url.pathname.split('/').pop());
      send(res, 200, await deleteWatch(watchId));
    } catch (e) {
      console.error(e);
      send(res, 502, { error: 'Could not delete watch' });
    }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}/events`));
