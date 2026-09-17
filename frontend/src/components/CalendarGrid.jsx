import { parseTime, sameDay, addDays, formatTime, formatWeekRange } from '../lib/dates';

const START_HOUR = 6;
const END_HOUR = 22;
const ROW_HEIGHT = 48;
const GRID_H = (END_HOUR - START_HOUR) * ROW_HEIGHT;
const MIN = START_HOUR * 60;
const MAX = END_HOUR * 60;

const COLOURS = {
  'Sports: Basketball': 'bg-orange-50 border-orange-500 text-orange-800',
  'Sports: Volleyball': 'bg-yellow-50 border-yellow-500 text-yellow-800',
  'Sports: Racquet Sports': 'bg-emerald-50 border-emerald-500 text-emerald-800',
  'Sports: Soccer': 'bg-green-50 border-green-600 text-green-800',
  'Sports: Ball & Floor Hockey': 'bg-sky-50 border-sky-500 text-sky-800',
  'Sports: Other': 'bg-purple-50 border-purple-500 text-purple-800',
  'Open Gym Times': 'bg-rose-50 border-rose-500 text-rose-800',
};
const FALLBACK = 'bg-gray-50 border-gray-400 text-gray-700';

function minutes(d) {
  return d.getHours() * 60 + d.getMinutes();
}

// Lay out overlapping events into side-by-side columns within a day.
function layoutDay(dayEvents) {
  const items = dayEvents
    .map((event) => {
      const start = parseTime(event.start);
      const end = parseTime(event.end);
      const startMin = Math.min(Math.max(minutes(start), MIN), MAX);
      let endMin = Math.min(Math.max(minutes(end), MIN), MAX);
      if (endMin <= startMin) endMin = startMin + 30;
      return { event, start, end, startMin, endMin };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const out = [];
  let i = 0;
  while (i < items.length) {
    const cluster = [items[i]];
    let maxEnd = items[i].endMin;
    i++;
    while (i < items.length && items[i].startMin < maxEnd) {
      cluster.push(items[i]);
      maxEnd = Math.max(maxEnd, items[i].endMin);
      i++;
    }

    const cols = [];
    const assigned = cluster.map((it) => {
      let col = cols.findIndex((end) => end <= it.startMin);
      if (col === -1) {
        col = cols.length;
        cols.push(it.endMin);
      } else {
        cols[col] = it.endMin;
      }
      return { ...it, col };
    });
    for (const a of assigned) out.push({ ...a, total: cols.length });
  }
  return out;
}

export default function CalendarGrid({ events, weekStart, onPrev, onNext, onToday, onSelect }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();
  const hourLabels = [];
  for (let h = START_HOUR; h <= END_HOUR; h++) hourLabels.push(h);

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <div style={{ minWidth: '720px' }}>
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <button
            onClick={onPrev}
            className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            ‹
          </button>
          <button
            onClick={onToday}
            className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            Today
          </button>
          <button
            onClick={onNext}
            className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            ›
          </button>
          <span className="ml-auto text-sm font-medium text-gray-700">
            {formatWeekRange(weekStart)}
          </span>
        </div>

        <div className="flex">
          <div className="w-14 shrink-0" />
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className={`flex-1 border-l border-gray-100 py-2 text-center ${
                sameDay(day, today) ? 'bg-blue-50/50' : ''
              }`}
            >
              <div className="text-xs font-medium uppercase text-gray-400">
                {day.toLocaleDateString('en-CA', { weekday: 'short' })}
              </div>
              <div
                className={`text-lg ${
                  sameDay(day, today) ? 'font-bold text-blue-600' : 'font-semibold text-gray-700'
                }`}
              >
                {day.getDate()}
              </div>
            </div>
          ))}
        </div>

        <div className="flex">
          <div className="relative w-14 shrink-0" style={{ height: GRID_H }}>
            {hourLabels.map((h) => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 text-xs text-gray-400"
                style={{ top: (h - START_HOUR) * ROW_HEIGHT }}
              >
                {h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`}
              </div>
            ))}
          </div>

          {days.map((day) => {
            const dayEvents = events.filter((e) => sameDay(parseTime(e.start), day));
            const laid = layoutDay(dayEvents);
            return (
              <div
                key={day.toISOString()}
                className="relative flex-1 border-l border-gray-100"
                style={{ height: GRID_H }}
              >
                {hourLabels.map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-gray-100"
                    style={{ top: (h - START_HOUR) * ROW_HEIGHT }}
                  />
                ))}

                {laid.map(({ event, startMin, endMin, col, total }) => {
                  const top = ((startMin - MIN) / 60) * ROW_HEIGHT;
                  const height = Math.max(((endMin - startMin) / 60) * ROW_HEIGHT, 22);
                  const colour = COLOURS[event.sport || event.calendarName] || FALLBACK;
                  const opensAt = event.registrationOpens ? parseTime(event.registrationOpens) : null;
                  const regPending = opensAt && opensAt > new Date();
                  return (
                    <button
                      key={`${event.id}-${event.start}`}
                      onClick={() => onSelect(event)}
                      title={`${event.title} — ${event.centerName}`}
                      className={`absolute overflow-hidden rounded border-l-2 px-1.5 py-0.5 text-left ${colour}`}
                      style={{
                        top,
                        height,
                        left: `${(col / total) * 100}%`,
                        width: `${100 / total}%`,
                      }}
                    >
                      <div className="truncate text-[11px] font-semibold leading-tight">
                        {formatTime(parseTime(event.start))} {event.title}
                      </div>
                      <div className="truncate text-[10px] leading-tight opacity-70">
                        {regPending
                          ? `Reg. opens ${opensAt.toLocaleDateString('en-CA', {
                              month: 'short',
                              day: 'numeric',
                            })} · `
                          : event.openSpots === 0
                            ? 'Full · '
                            : event.openSpots > 0
                              ? `${event.openSpots} spot${event.openSpots === 1 ? '' : 's'} · `
                              : ''}
                        {event.centerName}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
