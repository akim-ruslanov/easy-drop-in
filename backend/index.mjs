import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || event.requestContext?.http?.path;

  if (method === 'GET' && path.endsWith('/events')) {
    try {
      const [centres, events] = await Promise.all([getCentres(), getEvents()]);
      return json(200, { centres, events });
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Upstream community centre API unavailable' });
    }
  }

  if (method === 'GET' && path.endsWith('/spots')) {
    try {
      const params = event.queryStringParameters || {};
      const spots = await getSpots(parseSpotItems(params.items));
      return json(200, { spots });
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Upstream community centre API unavailable' });
    }
  }

  if (method === 'GET' && path.endsWith('/geocode')) {
    try {
      const params = event.queryStringParameters || {};
      const result = await geocode(params.q);
      if (!result) return json(404, { error: 'Location not found' });
      return json(200, result);
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Geocoding unavailable' });
    }
  }

  return json(404, { error: 'Not found' });
}
