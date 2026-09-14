export default function SpotsBadge({ openSpots, className = '' }) {
  if (openSpots === null || openSpots === undefined) return null;
  if (openSpots === 0) {
    return (
      <span className={`rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 ${className}`}>
        Full
      </span>
    );
  }
  return (
    <span className={`rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ${className}`}>
      {openSpots} spot{openSpots === 1 ? '' : 's'}
    </span>
  );
}
