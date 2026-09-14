import { createServer } from 'node:http';
import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';

const PORT = process.env.PORT || 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
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

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}/events`));
