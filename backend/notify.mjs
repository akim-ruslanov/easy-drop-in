// Sends a registration-open alert to an external webhook. A per-user config
// (kind/url/chatId/token) can be passed in; otherwise the Lambda environment
// defaults are used. The destination never reaches the browser.
//   ntfy      POST https://ntfy.sh/<topic>            body = message
//   discord   POST <webhook url>                      { content }
//   telegram  POST https://api.telegram.org/bot<T>/sendMessage  { chat_id, text }
//   generic   POST <url>                              { title, text }
function envConfig() {
  return {
    kind: process.env.NOTIFY_KIND || 'ntfy',
    url: process.env.NOTIFY_WEBHOOK_URL || '',
    chatId: process.env.NOTIFY_TELEGRAM_CHAT_ID || '',
    token: process.env.NOTIFY_AUTH_TOKEN || '',
  };
}

export function resolveConfig(config) {
  const env = envConfig();
  const c = config || {};
  return {
    kind: String(c.kind || env.kind || 'ntfy').toLowerCase(),
    url: c.url || env.url || '',
    chatId: c.chatId || env.chatId || '',
    token: c.token || env.token || '',
  };
}

export function notificationsConfigured(config) {
  return Boolean(resolveConfig(config).url);
}

export async function sendNotification({ text, title = 'Easy Drop-In', config }) {
  const { kind, url, chatId, token } = resolveConfig(config);
  if (!url) throw new Error('No notification webhook is configured');

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
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ title, text }),
    });
  }

  if (!res.ok) throw new Error(`Notification failed (${res.status})`);
  return true;
}
