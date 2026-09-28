import { randomUUID, randomBytes, scrypt as scryptCb, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Minimal email+password auth: scrypt password hashing (Node built-in) and
// stateless HMAC-signed session tokens. Users (and their favourites/webhook
// preferences) live in DynamoDB in Lambda, or a JSON file locally.
const scrypt = promisify(scryptCb);
const LOCAL_FILE = new URL('./.cache/users.json', import.meta.url);
const LOCAL_DIR = new URL('./.cache/', import.meta.url);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tableName() {
  return process.env.USERS_TABLE || '';
}
function secret() {
  const s = process.env.AUTH_SECRET || '';
  if (s) return s;
  // Local dev only (no DynamoDB): fall back to a fixed throwaway secret so
  // `node server.mjs` / `./dev.sh` work with no setup. In Lambda, USERS_TABLE
  // is always set and AUTH_SECRET is required — sign-up/login stay disabled
  // until it is configured.
  if (!tableName()) return 'easy-drop-in-dev-secret-do-not-use-in-production';
  throw new Error('AUTH_SECRET is not configured');
}

// --- password hashing -----------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString(
    'base64',
  )}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, salt, expected.length, { N: +n, r: +r, p: +p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// --- tokens (JWT-shaped, HS256) -------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload) {
  const body = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(payload),
  )}`;
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac('sha256', secret()).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// `event` is a Lambda/HTTP event; HTTP API lowercases header names.
export function sessionFrom(event) {
  const headers = (event && event.headers) || {};
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? verifyToken(m[1].trim()) : null;
}

// --- user store -----------------------------------------------------------

async function localRead() {
  try {
    return JSON.parse(await readFile(LOCAL_FILE, 'utf8'));
  } catch {
    return {};
  }
}
async function localWriteAll(map) {
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(LOCAL_FILE, JSON.stringify(map, null, 2));
}

let ddbPromise = null;
async function ddb() {
  if (!ddbPromise) {
    ddbPromise = (async () => {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
      return DynamoDBDocumentClient.from(new DynamoDBClient({}));
    })();
  }
  return ddbPromise;
}

export async function getUser(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  if (!tableName()) return (await localRead())[key] || null;
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const res = await (await ddb()).send(new GetCommand({ TableName: tableName(), Key: { email: key } }));
  return res.Item || null;
}

async function putUser(user, { createOnly }) {
  if (!tableName()) {
    const map = await localRead();
    if (createOnly && map[user.email]) {
      const err = new Error('An account with that email already exists');
      err.code = 'EXISTS';
      throw err;
    }
    map[user.email] = user;
    await localWriteAll(map);
    return;
  }
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  try {
    await (await ddb()).send(
      new PutCommand({
        TableName: tableName(),
        Item: user,
        ...(createOnly ? { ConditionExpression: 'attribute_not_exists(email)' } : {}),
      }),
    );
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      const err = new Error('An account with that email already exists');
      err.code = 'EXISTS';
      throw err;
    }
    throw e;
  }
}

// --- public API -----------------------------------------------------------

function validateCredentials(email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (password.length > 200) throw new Error('Password is too long');
  return e;
}

function publicUser(user) {
  return {
    email: user.email,
    userId: user.userId,
    favouriteCentres: user.favouriteCentres || [],
    favouriteSports: user.favouriteSports || [],
    webhook: user.webhook || null,
  };
}

export async function signUp({ email, password }) {
  const e = validateCredentials(email, password);
  const passwordHash = await hashPassword(password);
  const user = {
    email: e,
    userId: randomUUID(),
    passwordHash,
    favouriteCentres: [],
    favouriteSports: [],
    webhook: null,
    createdAt: new Date().toISOString(),
  };
  await putUser(user, { createOnly: true });
  return { token: signToken({ sub: user.userId, email: e, exp: Date.now() + TOKEN_TTL_MS }), user: publicUser(user) };
}

export async function logIn({ email, password }) {
  const e = String(email || '').trim().toLowerCase();
  const user = await getUser(e);
  const ok = user && (await verifyPassword(password || '', user.passwordHash));
  if (!ok) throw new Error('Incorrect email or password');
  return { token: signToken({ sub: user.userId, email: e, exp: Date.now() + TOKEN_TTL_MS }), user: publicUser(user) };
}

export async function currentUser(session) {
  if (!session) return null;
  const user = await getUser(session.email);
  return user ? publicUser(user) : null;
}

function cleanList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit);
}

export function cleanWebhook(webhook) {
  if (!webhook || typeof webhook !== 'object') return null;
  const url = String(webhook.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const kind = ['ntfy', 'discord', 'telegram', 'generic'].includes(webhook.kind) ? webhook.kind : 'ntfy';
  return { kind, url, chatId: String(webhook.chatId || '').trim() };
}

export async function updateProfile(session, patch) {
  const email = String(session.email).toLowerCase();
  const user = await getUser(email);
  if (!user) throw new Error('Account not found');
  const next = {
    ...user,
    favouriteCentres: cleanList(patch.favouriteCentres, 100).map(Number).filter(Boolean),
    favouriteSports: cleanList(patch.favouriteSports, 50).map(String),
    webhook: cleanWebhook(patch.webhook),
    updatedAt: new Date().toISOString(),
  };
  await putUser(next, { createOnly: false });
  return publicUser(next);
}
