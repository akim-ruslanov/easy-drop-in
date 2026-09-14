// Persistent cache for the merged events feed. In Lambda this is a single
// S3 object; locally it is a JSON file under backend/.cache. Keeping one small
// object means a cold start costs at most one S3 GET and a rebuild at most one
// PUT, which stays well inside the S3 free tier.
const BUCKET = process.env.CACHE_BUCKET || '';
const KEY = process.env.CACHE_KEY || 'feed.json';
const FILE = new URL('./.cache/feed.json', import.meta.url);
const DIR = new URL('./.cache/', import.meta.url);

let s3ClientPromise = null;

async function getS3Client() {
  if (!s3ClientPromise) {
    s3ClientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({}));
  }
  return s3ClientPromise;
}

export async function readFeedCache() {
  try {
    if (BUCKET) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await getS3Client();
      const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      const text = res.Body.transformToString
        ? await res.Body.transformToString()
        : await new Response(res.Body).text();
      return JSON.parse(text);
    }
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeFeedCache(data) {
  const text = JSON.stringify(data);
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: KEY,
        Body: text,
        ContentType: 'application/json',
      }),
    );
    return;
  }
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, text);
}
