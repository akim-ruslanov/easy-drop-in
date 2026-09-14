import { useState } from 'react';
import { haversineKm, formatKm } from '../lib/geo';

export default function CentreFilter({
  centres,
  selected,
  onToggle,
  onAll,
  onNone,
  userLocation,
  onUseLocation,
  onSetLocation,
  locating,
  geocoding,
  locationError,
  radiusKm,
  onRadiusChange,
}) {
  const [open, setOpen] = useState(false);
  const [centreQuery, setCentreQuery] = useState('');
  const [locText, setLocText] = useState('');
  const count = selected ? selected.size : centres.length;

  const q = centreQuery.trim().toLowerCase();
  const sorted = [...centres]
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (userLocation) {
        return (
          haversineKm(userLocation.lat, userLocation.lng, a.lat, a.lng) -
          haversineKm(userLocation.lat, userLocation.lng, b.lat, b.lng)
        );
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        {selected ? `Centres (${count})` : 'All centres'}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white shadow-lg">
            <div className="border-b border-gray-100 p-3">
              <input
                value={centreQuery}
                onChange={(e) => setCentreQuery(e.target.value)}
                placeholder="Filter centres…"
                className="w-full rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:bg-white focus:outline-none"
              />

              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={onUseLocation}
                  disabled={locating}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {locating ? 'Locating…' : 'Use my location'}
                </button>
                <input
                  value={locText}
                  onChange={(e) => setLocText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && onSetLocation(locText)}
                  placeholder="Or enter a location…"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:bg-white focus:outline-none"
                />
                <button
                  onClick={() => onSetLocation(locText)}
                  disabled={geocoding || !locText.trim()}
                  className="rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {geocoding ? '…' : 'Set'}
                </button>
              </div>

              {locationError && <p className="mt-1 text-xs text-red-500">{locationError}</p>}

              {userLocation && (
                <label className="mt-2 flex items-center gap-1 text-xs text-gray-600">
                  Within
                  <select
                    value={radiusKm}
                    onChange={(e) => onRadiusChange(Number(e.target.value))}
                    className="rounded border border-gray-300 px-1 py-0.5"
                  >
                    {[5, 10, 15, 20].map((r) => (
                      <option key={r} value={r}>
                        {r} km
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="mt-2 flex gap-1">
                <button
                  onClick={onAll}
                  className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200"
                >
                  All
                </button>
                <button
                  onClick={onNone}
                  className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200"
                >
                  None
                </button>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto p-1">
              {sorted.length === 0 && (
                <p className="px-2 py-3 text-center text-sm text-gray-400">No centres match</p>
              )}
              {sorted.map((c) => {
                const checked = selected ? selected.has(c.id) : true;
                const km = userLocation
                  ? haversineKm(userLocation.lat, userLocation.lng, c.lat, c.lng)
                  : null;
                return (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(c.id)}
                      className="accent-blue-600"
                    />
                    <span className="flex-1 truncate text-sm text-gray-700">{c.name}</span>
                    {km !== null && (
                      <span className="shrink-0 text-xs text-gray-400">{formatKm(km)}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
