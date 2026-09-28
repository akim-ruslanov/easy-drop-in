import { useState } from 'react';
import { testNotification } from '../api';

const PLACEHOLDERS = {
  ntfy: 'https://ntfy.sh/your-topic',
  discord: 'https://discord.com/api/webhooks/…',
  telegram: 'https://api.telegram.org/bot<token>/sendMessage',
  generic: 'https://example.com/hook',
};

const HELP = {
  ntfy: 'Install the ntfy app, subscribe to a topic, then paste its URL here.',
  discord: 'Server Settings → Integrations → Webhooks → New Webhook, then copy the URL.',
  telegram:
    'Create a bot with @BotFather, paste the bot token into the URL and your chat id below.',
  generic: 'Any URL that accepts a JSON POST containing { title, text }.',
};

export default function SettingsModal({ user, centres, sports, onSave, onClose }) {
  const [centreSel, setCentreSel] = useState(new Set(user.favouriteCentres || []));
  const [sportSel, setSportSel] = useState(new Set(user.favouriteSports || []));
  const [kind, setKind] = useState(user.webhook?.kind || 'ntfy');
  const [url, setUrl] = useState(user.webhook?.url || '');
  const [chatId, setChatId] = useState(user.webhook?.chatId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [testError, setTestError] = useState('');

  const sportOptions = (sports || []).filter((s) => s !== 'All');

  function toggle(setState, value) {
    setState((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave({
        favouriteCentres: [...centreSel],
        favouriteSports: [...sportSel],
        webhook: url.trim() ? { kind, url: url.trim(), chatId: chatId.trim() } : null,
      });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const clean = url.trim();
    if (!clean) {
      setTestResult('');
      setTestError('Enter a webhook URL first.');
      return;
    }
    setTestBusy(true);
    setTestResult('');
    setTestError('');
    try {
      await testNotification({ kind, url: clean, chatId: chatId.trim() });
      setTestResult('Test notification sent — check your device.');
    } catch (e) {
      setTestError(e.message);
    } finally {
      setTestBusy(false);
    }
  }

  function removeWebhook() {
    setUrl('');
    setChatId('');
    setTestResult('');
    setTestError('');
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Preferences</h2>
            <p className="text-xs text-gray-400">{user.email}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Favourite sports</h3>
          <div className="flex flex-wrap gap-1.5">
            {sportOptions.map((s) => (
              <button
                key={s}
                onClick={() => toggle(setSportSel, s)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  sportSel.has(s)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Favourite centres</h3>
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
            {centres.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-gray-700 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={centreSel.has(c.id)}
                  onChange={() => toggle(setCentreSel, c.id)}
                  className="accent-blue-600"
                />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Notification webhook</h3>
            {url.trim() && (
              <button
                onClick={removeWebhook}
                className="text-xs font-medium text-red-500 hover:text-red-600"
              >
                Remove
              </button>
            )}
          </div>
          <p className="mb-2 text-xs text-gray-400">
            Where &ldquo;Notify me&rdquo; registration alerts are sent.
          </p>
          <div className="flex gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-700"
            >
              <option value="ntfy">ntfy</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
              <option value="generic">Generic</option>
            </select>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={PLACEHOLDERS[kind]}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          {kind === 'telegram' && (
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="Telegram chat id"
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          )}
          <p className="mt-2 text-xs text-gray-400">{HELP[kind]}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={sendTest}
              disabled={testBusy}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testBusy ? 'Sending…' : 'Send test'}
            </button>
            {testResult && <span className="text-xs text-emerald-600">{testResult}</span>}
            {testError && <span className="text-xs text-red-600">{testError}</span>}
          </div>
        </section>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
