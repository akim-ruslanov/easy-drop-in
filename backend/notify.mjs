// Sends a registration-open alert to an external webhook. The destination is
// configured entirely through Lambda environment variables so the URL is never
// exposed to the browser. Supported kinds:
//   ntfy      POST https://ntfy.sh/<topic>            body = message
//   discord   POST <webhook url>                      { content }
//   telegram  POST https://api.telegram.org/bot<T>/sendMessage  { chat_id, text }
//   generic   POST <url>                              { title, text }
function config() {
  return {
    kind: (process.env.NOTIFY_KIND || 'ntfy').toLowerCase(),
    url: process.env.NOTIFY_WEBHOOK_URL || '',
    chatId: process.env.NOTIFY_TELEGRAM_CHAT_ID || '',
    token: process.env.NOTIFY_AUTH_TOKEN || '',
  };
}

export function notificationsConfigured() {
  return Boolean(config().url);
}

export async function sendNotification({ text, title = 'Easy Drop-In' }) {
  const { kind, url, chatId, token } = config();
  if (!url) throw new Error('NOTIFY_WEBHOOK_URL is not configured');

  let res;
  if (kind === 'telegram') {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
  } else if (kind === 'discord') {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
  } else if (kind === 'ntfy') {
    const headers = { Title: title, Tags: 'calendar' };
    if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetch(url, { method: 'POST', headers, body: text });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ title, text }),
    });
  }

  if (!res.ok) throw new Error(`Notification failed (${res.status})`);
  return true;
}
