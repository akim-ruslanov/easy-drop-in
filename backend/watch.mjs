import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getSpots } from './anc.mjs';
import { sendNotification } from './notify.mjs';

// "Watch" = notify the user (via webhook) the moment online registration opens
// for a specific activity. Each watch stores a record and, in Lambda, an
// EventBridge Scheduler one-time schedule that fires this same function with
// { job: "watch", watchId }. No ANC credentials are involved.
const LOCAL_FILE = new URL('./.cache/watches.json', import.meta.url);
const LOCAL_DIR = new URL('./.cache/', import.meta.url);
const TIME_ZONE = 'America/Vancouver';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// --- time helpers ---------------------------------------------------------

// Interpret a naive ANC datetime ("2026-09-18 12:00:00") as wall-clock time in
// the given zone and return the corresponding absolute Date. Two-pass Intl
// trick; handles DST because the offset is resolved for the target instant.
export function zonedTimeToUtc(local, timeZone = TIME_ZONE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(local || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const asZone = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    parts.hour === '24' ? 0 : +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return new Date(asUtc + (asUtc - asZone));
}

// Echo a naive datetime's wall-clock labels (no zone shift) for display.
function fmtNaive(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(local || ''));
  if (!m) return local || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function toAtExpression(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `at(${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(
    date.getUTCHours(),
  )}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())})`;
}

function scheduleName(watchId) {
  return `edi-${watchId}`.slice(0, 64);
}

// --- storage (DynamoDB in Lambda, JSON file locally) ----------------------

function tableName() {
  return process.env.WATCHES_TABLE || '';
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
async function putRecord(rec) {
  if (!tableName()) {
    const map = await localRead();
    map[rec.watchId] = rec;
    await localWriteAll(map);
    return;
  }
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  await (await ddb()).send(new PutCommand({ TableName: tableName(), Item: rec }));
}
async function getRecord(watchId) {
  if (!tableName()) return (await localRead())[watchId] || null;
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const res = await (await ddb()).send(new GetCommand({ TableName: tableName(), Key: { watchId } }));
  return res.Item || null;
}
async function deleteRecord(watchId) {
  if (!tableName()) {
    const map = await localRead();
    delete map[watchId];
    await localWriteAll(map);
    return;
  }
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  await (await ddb()).send(new DeleteCommand({ TableName: tableName(), Key: { watchId } }));
}
async function listRecords() {
  if (!tableName()) return Object.values(await localRead());
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const res = await (await ddb()).send(new ScanCommand({ TableName: tableName() }));
  return res.Items || [];
}
async function markNotified(watchId) {
  if (!tableName()) {
    const map = await localRead();
    if (map[watchId]) {
      map[watchId].notified = true;
      await localWriteAll(map);
    }
    return;
  }
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await (await ddb()).send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { watchId },
      UpdateExpression: 'SET notified = :t',
      ConditionExpression: 'attribute_exists(watchId)',
      ExpressionAttributeValues: { ':t': true },
    }),
  );
}

// --- scheduler ------------------------------------------------------------

async function schedulerClient() {
  const { SchedulerClient } = await import('@aws-sdk/client-scheduler');
  return new SchedulerClient({});
}

// --- public API -----------------------------------------------------------

function buildRecord(input) {
  const activityId = parseInt(input && input.id, 10);
  const { date, registrationOpens } = input || {};
  if (!activityId || !date || !registrationOpens) return null;
  const dueAtUtc = zonedTimeToUtc(registrationOpens);
  if (!dueAtUtc || Number.isNaN(dueAtUtc.getTime())) return null;
  const watchId = `${activityId}-${dueAtUtc.getTime()}`;
  return {
    watchId,
    activityId,
    date,
    title: input.title || '',
    center: input.center || '',
    facility: input.facility || '',
    sport: input.sport || '',
    url: input.url || '',
    registrationOpens,
    dueAtUtc,
  };
}

function toItem(rec) {
  return {
    ...rec,
    dueAtUtc: rec.dueAtUtc.toISOString(),
    notified: false,
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor((rec.dueAtUtc.getTime() + RETENTION_MS) / 1000),
  };
}

export async function createWatch(input, { targetArn } = {}) {
  const rec = buildRecord(input);
  if (!rec) throw new Error('Invalid watch payload');
  if (rec.dueAtUtc.getTime() <= Date.now()) throw new Error('Registration is already open');

  const name = scheduleName(rec.watchId);
  await putRecord({ ...toItem(rec), scheduleName: name });

  const roleArn = process.env.SCHEDULER_ROLE_ARN;
  const scheduled = Boolean(roleArn && targetArn);
  if (scheduled) {
    try {
      const { CreateScheduleCommand } = await import('@aws-sdk/client-scheduler');
      await (await schedulerClient()).send(
        new CreateScheduleCommand({
          Name: name,
          ScheduleExpression: toAtExpression(rec.dueAtUtc),
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
          Target: {
            Arn: targetArn,
            RoleArn: roleArn,
            Input: JSON.stringify({ job: 'watch', watchId: rec.watchId }),
          },
        }),
      );
    } catch (e) {
      await deleteRecord(rec.watchId).catch(() => {});
      throw e;
    }
  }

  return { watchId: rec.watchId, dueAtUtc: rec.dueAtUtc.toISOString(), scheduled };
}

export async function listWatches() {
  const records = await listRecords();
  return records
    .map((r) => ({
      watchId: r.watchId,
      activityId: r.activityId,
      registrationOpens: r.registrationOpens,
      notified: Boolean(r.notified),
      title: r.title,
    }))
    .sort((a, b) => (a.registrationOpens < b.registrationOpens ? -1 : 1));
}

export async function deleteWatch(watchId) {
  const rec = await getRecord(watchId);
  if (process.env.SCHEDULER_ROLE_ARN) {
    try {
      const { DeleteScheduleCommand } = await import('@aws-sdk/client-scheduler');
      await (await schedulerClient()).send(
        new DeleteScheduleCommand({ Name: (rec && rec.scheduleName) || scheduleName(watchId) }),
      );
    } catch (e) {
      if (e.name !== 'ResourceNotFoundException') throw e;
    }
  }
  await deleteRecord(watchId);
  return { watchId, deleted: true };
}

export async function runWatch({ watchId }) {
  const rec = await getRecord(watchId);
  if (!rec) return { skipped: 'not-found' };
  if (rec.notified) return { skipped: 'already-notified' };

  let spotLine = '';
  try {
    const spots = await getSpots([{ id: rec.activityId, date: rec.date }]);
    const info = spots[rec.activityId];
    if (info && info.openSpots != null) {
      spotLine = `${info.openSpots} spot${info.openSpots === 1 ? '' : 's'} open`;
    }
  } catch {
    /* availability is a bonus; never block the alert */
  }

  const where = `${rec.center}${rec.facility ? ` (${rec.facility})` : ''}`;
  const text = [
    'Registration opens now!',
    '',
    rec.title,
    `${fmtNaive(rec.date)} · ${where}`,
    [rec.sport, spotLine].filter(Boolean).join(' · '),
    '',
    rec.url,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  await sendNotification({ title: 'Easy Drop-In', text });
  await markNotified(watchId);
  return { sent: true };
}
