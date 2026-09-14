export function parseTime(s) {
  return new Date(s.replace(' ', 'T'));
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function dateKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function formatTime(date) {
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

export function formatDayHeader(date) {
  const today = new Date();
  const tomorrow = addDays(today, 1);

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function formatWeekRange(weekStart) {
  const end = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  if (weekStart.getFullYear() === end.getFullYear()) {
    return `${weekStart.toLocaleDateString('en-CA', opts)} – ${end.toLocaleDateString(
      'en-CA',
      { month: 'short', day: 'numeric', year: 'numeric' },
    )}`;
  }
  return `${weekStart.toLocaleDateString('en-CA', { ...opts, year: 'numeric' })} – ${end.toLocaleDateString(
    'en-CA',
    { ...opts, year: 'numeric' },
  )}`;
}
