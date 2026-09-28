import { getEvents, getCentres, getSpots, parseSpotItems } from './anc.mjs';
import { geocode } from './geocode.mjs';
import { createWatch, listWatches, deleteWatch, runWatch } from './watch.mjs';
import { signUp, logIn, currentUser, updateProfile, sessionFrom, cleanWebhook } from './auth.mjs';
import { sendNotification } from './notify.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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

  // --- auth ---

  if (method === 'POST' && path.endsWith('/auth/signup')) {
    try {
      return json(201, await signUp(parseBody(event)));
    } catch (e) {
      return json(400, { error: e.message || 'Could not create account' });
    }
  }

  if (method === 'POST' && path.endsWith('/auth/login')) {
    try {
      return json(200, await logIn(parseBody(event)));
    } catch (e) {
      return json(401, { error: e.message || 'Could not sign in' });
    }
  }

  if (method === 'GET' && path.endsWith('/auth/me')) {
    try {
      const user = await currentUser(sessionFrom(event));
      if (!user) return json(401, { error: 'Not signed in' });
      return json(200, { user });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Could not load account' });
    }
  }

  if (method === 'PUT' && path.endsWith('/profile')) {
    try {
      const session = sessionFrom(event);
      if (!session) return json(401, { error: 'Not signed in' });
      return json(200, { user: await updateProfile(session, parseBody(event)) });
    } catch (e) {
      console.error(e);
      return json(400, { error: e.message || 'Could not update profile' });
    }
  }

  if (method === 'POST' && path.endsWith('/notify/test')) {
    const session = sessionFrom(event);
    if (!session) return json(401, { error: 'Sign in to test notifications' });
    try {
      const config = cleanWebhook(parseBody(event));
      if (!config) return json(400, { error: 'Enter a valid webhook URL (https://…)' });
      await sendNotification({
        title: 'Easy Drop-In',
        text: 'Test notification — your webhook is working!',
        config,
      });
      return json(200, { sent: true });
    } catch (e) {
      console.error(e);
      return json(400, { error: e.message || 'Test notification failed' });
    }
  }

  // --- registration alerts (signed in) ---

  if (method === 'POST' && path.endsWith('/watch')) {
    const session = sessionFrom(event);
    if (!session) return json(401, { error: 'Sign in to create alerts' });
    try {
      const result = await createWatch(parseBody(event), {
        targetArn: context && context.invokedFunctionArn,
        email: session.email,
      });
      return json(201, result);
    } catch (e) {
      console.error(e);
      return json(400, { error: e.message || 'Could not create watch' });
    }
  }

  if (method === 'GET' && path.endsWith('/watch')) {
    const session = sessionFrom(event);
    if (!session) return json(401, { error: 'Sign in to view alerts' });
    try {
      return json(200, { watches: await listWatches(session.email) });
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Could not list watches' });
    }
  }

  if (method === 'DELETE' && /\/watch\/[^/]+$/.test(path)) {
    const session = sessionFrom(event);
    if (!session) return json(401, { error: 'Sign in to manage alerts' });
    try {
      const watchId = decodeURIComponent(path.split('/').pop());
      return json(200, await deleteWatch(watchId, session.email));
    } catch (e) {
      console.error(e);
      return json(502, { error: 'Could not delete watch' });
    }
  }

  return json(404, { error: 'Not found' });
}
