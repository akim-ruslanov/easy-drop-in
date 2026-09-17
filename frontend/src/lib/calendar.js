import { parseTime } from './dates';

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIcs(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function escapeText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

function saveIcs(filename, lines) {
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slug(event) {
  return event.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'event';
}

function toGoogleDate(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Pre-filled Google Calendar compose URL (all datetimes converted to UTC).
export function googleCalendarUrl({ title, start, end, details = '', location = '' }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${toGoogleDate(start)}/${toGoogleDate(end)}`,
  });
  if (details) params.set('details', details);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function openInNewTab(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// mode 'google' (default) opens Google Calendar; 'ics' downloads a file.
export function addEventToCalendar(event, mode = 'google') {
  if (mode === 'ics') {
    downloadIcs(event);
    return;
  }
  const location = [event.centerName, event.facility].filter(Boolean).join(' - ');
  openInNewTab(
    googleCalendarUrl({
      title: event.title,
      start: parseTime(event.start),
      end: parseTime(event.end),
      details: [event.description, event.url].filter(Boolean).join('\n\n'),
      location,
    }),
  );
}

export function addRegistrationReminder(event, opensAt, mode = 'google') {
  if (mode === 'ics') {
    downloadRegistrationReminder(event, opensAt);
    return;
  }
  const location = [event.centerName, event.facility].filter(Boolean).join(' - ');
  const end = new Date(opensAt.getTime() + 15 * 60 * 1000);
  openInNewTab(
    googleCalendarUrl({
      title: `Registration opens: ${event.title}`,
      start: opensAt,
      end,
      details: event.url ? `Register: ${event.url}` : '',
      location,
    }),
  );
}

export function downloadIcs(event) {
  const start = parseTime(event.start);
  const end = parseTime(event.end);
  const location = [event.centerName, event.facility].filter(Boolean).join(' - ');

  saveIcs(`${slug(event)}.ics`, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Easy Drop-In//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@easydropin`,
    `DTSTAMP:${toIcs(new Date())}`,
    `DTSTART:${toIcs(start)}`,
    `DTEND:${toIcs(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `LOCATION:${escapeText(location)}`,
    `URL:${escapeText(event.url)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

// A short reminder at the moment online registration opens, rather than the
// event itself. `opensAt` is a Date.
export function downloadRegistrationReminder(event, opensAt) {
  const end = new Date(opensAt.getTime() + 15 * 60 * 1000);
  const location = [event.centerName, event.facility].filter(Boolean).join(' - ');
  const summary = `Registration opens: ${event.title}`;
  const description = [
    `Online registration opens for ${event.title}.`,
    location ? `Location: ${location}` : '',
    event.url ? `Register: ${event.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  saveIcs(`${slug(event)}-registration.ics`, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Easy Drop-In//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}-registration@easydropin`,
    `DTSTAMP:${toIcs(new Date())}`,
    `DTSTART:${toIcs(opensAt)}`,
    `DTEND:${toIcs(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(location)}`,
    `URL:${escapeText(event.url)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}
