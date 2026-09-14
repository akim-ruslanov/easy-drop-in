import { useState } from 'react';
import { parseTime, formatTime } from '../lib/dates';
import { downloadIcs } from '../lib/calendar';
import SpotsBadge from './SpotsBadge';

export default function EventRow({ event }) {
  const [open, setOpen] = useState(false);
  const start = parseTime(event.start);
  const end = parseTime(event.end);

  return (
    <div className="flex gap-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="w-24 shrink-0 text-right text-sm font-medium text-gray-700">
        <div>{formatTime(start)}</div>
        <div className="text-xs font-normal text-gray-400">{formatTime(end)}</div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate font-semibold text-gray-900">{event.title}</h3>
          <SpotsBadge openSpots={event.openSpots} className="shrink-0" />
          {event.price && (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              {event.price}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500">
          {event.centerName}
          {event.facility ? ` · ${event.facility}` : ''}
          {event.ageGroup ? ` · ${event.ageGroup}` : ''}
          <span className="text-gray-300"> · </span>
          {event.sport || event.calendarName}
        </p>

        {event.description && (
          <>
            <p
              className={`mt-1 text-sm text-gray-600 ${open ? '' : 'line-clamp-2'}`}
              onClick={() => setOpen(!open)}
            >
              {event.description}
            </p>
            <button
              onClick={() => setOpen(!open)}
              className="mt-1 text-xs font-medium text-blue-600 hover:underline"
            >
              {open ? 'Hide' : 'More'}
            </button>
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end justify-center gap-1">
        {event.url && (
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Sign up
          </a>
        )}
        <button
          onClick={() => downloadIcs(event)}
          className="text-xs font-medium text-gray-500 hover:text-gray-800"
        >
          Add to calendar
        </button>
      </div>
    </div>
  );
}
