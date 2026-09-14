import { useEffect } from 'react';
import { parseTime, formatTime, formatDayHeader } from '../lib/dates';
import { downloadIcs } from '../lib/calendar';
import SpotsBadge from './SpotsBadge';

export default function EventModal({ event, onClose }) {
  useEffect(() => {
    if (!event) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [event, onClose]);

  if (!event) return null;

  const start = parseTime(event.start);
  const end = parseTime(event.end);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-gray-400">
              {formatDayHeader(start)} · {formatTime(start)} – {formatTime(end)}
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-gray-900">{event.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        <p className="mt-1 text-sm text-gray-500">
          {event.centerName}
          {event.facility ? ` · ${event.facility}` : ''}
          {event.ageGroup ? ` · ${event.ageGroup}` : ''}
          <span className="text-gray-300"> · </span>
          {event.sport || event.calendarName}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SpotsBadge openSpots={event.openSpots} />
          {event.price && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              {event.price}
            </span>
          )}
        </div>

        {event.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-600">{event.description}</p>
        )}

        <div className="mt-4 flex gap-2">
          {event.url && (
            <a
              href={event.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Sign up
            </a>
          )}
          <button
            onClick={() => downloadIcs(event)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Add to calendar
          </button>
        </div>
      </div>
    </div>
  );
}
