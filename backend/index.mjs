import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';
import { createWatch, listWatches, deleteWatch, runWatch } from './watch.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

export async function handler(event, context) {
  // EventBridge Scheduler invokes the same function with { job: "watch" }.
  if (event && event.job === 'watch') {
    try {
      const result = await runWatch(event);
      console.log('watch result', event.watchId, result);
    } catch (e) {
      console.error('watch failed', event.watchId, e);
      throw e;
    }
    return { statusCode: 200, body: 'ok' };
  }

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

  if (method === 'POST' && path.endsWith('/watch')) {
    try {
      const result = await createWatch(parseBody(event), {
        targetArn: context && context.invokedFunctionArn,
      });
      return json(201, result);
    } catch (e) {
      console.error(e);
      return json(400, { error: e.message || 'Could not create watch' });
    }
  }

  if (method === 'GET' && path.endsWith('/watch')) {
    try {
      return json(200, { watches: await listWatches() });
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Could not list watches' });
    }
  }

  if (method === 'DELETE' && /\/watch\/[^/]+$/.test(path)) {
    try {
      const watchId = decodeURIComponent(path.split('/').pop());
      return json(200, await deleteWatch(watchId));
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Could not delete watch' });
    }
  }

  return json(404, { error: 'Not found' });
}
