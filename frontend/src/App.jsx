import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchData, fetchSpots, geocode } from './api';
import EventRow from './components/EventRow';
import CalendarGrid from './components/CalendarGrid';
import EventModal from './components/EventModal';
import CentreFilter from './components/CentreFilter';
import { parseTime, dateKey, formatDayHeader, startOfWeek, addDays } from './lib/dates';
import { haversineKm } from './lib/geo';

const RANGES = { week: 'Next 7 days', month: 'Next 30 days', all: 'All upcoming' };

export default function App() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading');
  const [query, setQuery] = useState('');
  const [sport, setSport] = useState('All');
  const [ageGroup, setAgeGroup] = useState('All');
  const [openSpotsOnly, setOpenSpotsOnly] = useState(false);
  const [view, setView] = useState('calendar');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [range, setRange] = useState('week');
  const [selectedCentres, setSelectedCentres] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const [radiusKm, setRadiusKm] = useState(5);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [spots, setSpots] = useState({});
  const [calendarMode, setCalendarMode] = useState('google');
  const spotsInFlight = useRef(new Set());

  useEffect(() => {
    fetchData()
      .then((d) => {
        setData(d);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  const centres = data?.centres || [];
  const sports = useMemo(
    () => ['All', ...new Set((data?.events || []).map((e) => e.sport || e.calendarName))],
    [data],
  );
  const ageGroups = useMemo(
    () => [
      'All',
      ...new Set((data?.events || []).map((e) => e.ageGroup).filter(Boolean)),
    ],
    [data],
  );

  const eventsWithSpots = useMemo(() => {
    const events = data?.events || [];
    if (!Object.keys(spots).length) return events;
    return events.map((e) => {
      const s = spots[e.id];
      return s
        ? {
            ...e,
            openSpots: s.openSpots,
            spaceStatus: s.spaceStatus,
            registrationOpens: s.registrationOpens,
          }
        : e;
    });
  }, [data, spots]);

  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return eventsWithSpots.filter((e) => {
      if (sport !== 'All' && (e.sport || e.calendarName) !== sport) return false;
      if (ageGroup !== 'All' && e.ageGroup !== ageGroup) return false;
      if (selectedCentres && !selectedCentres.has(e.centerId)) return false;
      if (q) {
        const hay = [e.title, e.description, e.centerName, e.facility, e.sport, e.calendarName]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [eventsWithSpots, query, sport, ageGroup, selectedCentres]);

  const weekEvents = useMemo(() => {
    const end = addDays(weekStart, 7);
    return visibleEvents.filter((e) => {
      const s = parseTime(e.start);
      return s >= weekStart && s < end;
    });
  }, [visibleEvents, weekStart]);

  const listEvents = useMemo(() => {
    const now = new Date();
    const days = range === 'all' ? Infinity : range === 'month' ? 30 : 7;
    const cutoff = days === Infinity ? null : new Date(now.getTime() + days * 86400000);
    return visibleEvents
      .filter((e) => parseTime(e.end) >= now)
      .filter((e) => !cutoff || parseTime(e.start) <= cutoff);
  }, [visibleEvents, range]);

  // Only fetch open-spot counts for the events currently on screen, in chunks
  // that keep the query string short. Results are merged into `spots`.
  useEffect(() => {
    const displayed = view === 'calendar' ? weekEvents : listEvents;
    const needed = [];
    const seen = new Set();
    for (const e of displayed) {
      if (!e.id || spots[e.id] || seen.has(e.id) || spotsInFlight.current.has(e.id)) continue;
      seen.add(e.id);
      needed.push({ id: e.id, date: e.start });
    }
    if (!needed.length) return;
    for (let i = 0; i < needed.length; i += 50) {
      const chunk = needed.slice(i, i + 50);
      chunk.forEach((x) => spotsInFlight.current.add(x.id));
      fetchSpots(chunk)
        .then((d) => setSpots((prev) => ({ ...prev, ...d.spots })))
        .catch(() => {})
        .finally(() => chunk.forEach((x) => spotsInFlight.current.delete(x.id)));
    }
  }, [view, weekEvents, listEvents, spots]);

  const filteredWeekEvents = useMemo(
    () => (openSpotsOnly ? weekEvents.filter((e) => e.openSpots > 0) : weekEvents),
    [weekEvents, openSpotsOnly],
  );

  const filteredListEvents = useMemo(
    () => (openSpotsOnly ? listEvents.filter((e) => e.openSpots > 0) : listEvents),
    [listEvents, openSpotsOnly],
  );

  const grouped = useMemo(() => {
    const map = new Map();
    for (const e of filteredListEvents) {
      const key = dateKey(parseTime(e.start));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()];
  }, [filteredListEvents]);

  function toggleCentre(id) {
    setSelectedCentres((prev) => {
      if (prev === null) {
        const s = new Set(centres.map((c) => c.id));
        s.delete(id);
        return s;
      }
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s.size === centres.length ? null : s;
    });
  }

  function applyRadius(km, loc = userLocation) {
    if (!loc) return;
    const ids = centres
      .filter((c) => haversineKm(loc.lat, loc.lng, c.lat, c.lng) <= km)
      .map((c) => c.id);
    setSelectedCentres(new Set(ids));
  }

  function useLocation() {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported');
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        setLocating(false);
        applyRadius(radiusKm, loc);
      },
      () => {
        setLocating(false);
        setLocationError('Could not get your location');
      },
    );
  }

  async function setLocationByText(text) {
    setGeocoding(true);
    setLocationError(null);
    try {
      const loc = await geocode(text);
      setUserLocation(loc);
      applyRadius(radiusKm, loc);
    } catch {
      setLocationError('Could not find that location');
    } finally {
      setGeocoding(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Easy Drop-In</h1>
              <p className="mt-1 text-sm text-gray-500">
                Drop-in sports across Vancouver community centres
              </p>
            </div>
            <div className="flex items-center gap-2">
              <CentreFilter
                centres={centres}
                selected={selectedCentres}
                onToggle={toggleCentre}
                onAll={() => setSelectedCentres(null)}
                onNone={() => setSelectedCentres(new Set())}
                userLocation={userLocation}
                onUseLocation={useLocation}
                onSetLocation={setLocationByText}
                locating={locating}
                geocoding={geocoding}
                locationError={locationError}
                radiusKm={radiusKm}
                onRadiusChange={(km) => {
                  setRadiusKm(km);
                  applyRadius(km);
                }}
              />
              <div className="flex rounded-lg border border-gray-300 p-0.5">
                <button
                  onClick={() => setView('calendar')}
                  className={`rounded-md px-3 py-1 text-sm font-medium ${
                    view === 'calendar' ? 'bg-blue-600 text-white' : 'text-gray-600'
                  }`}
                >
                  Calendar
                </button>
                <button
                  onClick={() => setView('list')}
                  className={`rounded-md px-3 py-1 text-sm font-medium ${
                    view === 'list' ? 'bg-blue-600 text-white' : 'text-gray-600'
                  }`}
                >
                  List
                </button>
              </div>
            </div>
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search basketball, volleyball, tennis, a centre…"
            className="mt-4 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2.5 text-sm focus:border-blue-500 focus:bg-white focus:outline-none"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {sports.map((s) => (
                <button
                  key={s}
                  onClick={() => setSport(s)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    sport === s
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <select
              value={ageGroup}
              onChange={(e) => setAgeGroup(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600"
            >
              {ageGroups.map((a) => (
                <option key={a} value={a}>
                  {a === 'All' ? 'All ages' : a}
                </option>
              ))}
            </select>

            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={openSpotsOnly}
                onChange={(e) => setOpenSpotsOnly(e.target.checked)}
                className="accent-blue-600"
              />
              Open spots only
            </label>

            <div className="ml-auto flex items-center gap-2">
              {view === 'list' && (
                <select
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600"
                >
                  {Object.entries(RANGES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-400">Add to:</span>
                <div className="flex rounded-lg border border-gray-300 p-0.5">
                  <button
                    onClick={() => setCalendarMode('google')}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      calendarMode === 'google' ? 'bg-blue-600 text-white' : 'text-gray-600'
                    }`}
                  >
                    Google Calendar
                  </button>
                  <button
                    onClick={() => setCalendarMode('ics')}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      calendarMode === 'ics' ? 'bg-blue-600 text-white' : 'text-gray-600'
                    }`}
                  >
                    .ics file
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {status === 'loading' && (
          <p className="py-16 text-center text-sm text-gray-400">Loading events…</p>
        )}

        {status === 'error' && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Couldn&apos;t load events. The community centre calendar may be temporarily
            unavailable — try again shortly.
          </div>
        )}

        {status === 'ready' && view === 'calendar' && (
          <CalendarGrid
            events={filteredWeekEvents}
            weekStart={weekStart}
            onPrev={() => setWeekStart((w) => addDays(w, -7))}
            onNext={() => setWeekStart((w) => addDays(w, 7))}
            onToday={() => setWeekStart(startOfWeek(new Date()))}
            onSelect={setSelectedEvent}
          />
        )}

        {status === 'ready' && view === 'list' && (
          <>
            <p className="mb-4 text-sm text-gray-500">
              {filteredListEvents.length} event
              {filteredListEvents.length === 1 ? '' : 's'}
            </p>
            {grouped.map(([key, dayEvents]) => (
              <section key={key} className="mb-6">
                <h2 className="mb-2 text-sm font-semibold text-gray-500">
                  {formatDayHeader(parseTime(dayEvents[0].start))}
                </h2>
                <div className="space-y-2">
                  {dayEvents.map((e) => (
                    <EventRow key={`${e.id}-${e.start}`} event={e} calendarMode={calendarMode} />
                  ))}
                </div>
              </section>
            ))}
            {filteredListEvents.length === 0 && (
              <p className="py-16 text-center text-sm text-gray-400">
                No events match your search.
              </p>
            )}
          </>
        )}
      </main>

      <footer className="mx-auto max-w-5xl px-4 py-8 text-center text-xs text-gray-400">
        Data from the City of Vancouver community centre calendars.
      </footer>

      <EventModal
        event={selectedEvent}
        calendarMode={calendarMode}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}
