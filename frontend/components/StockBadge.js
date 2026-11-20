export default function StockBadge({ available, low, city, className = "" }) {
  if (available === null || available === undefined || !city) return null;

  if (available === 0) {
    return <p className={`text-xs font-medium text-red-600 ${className}`}>Out of stock in {city}</p>;
  }

  if (low) {
    return (
      <p className={`text-xs font-medium text-amber-700 ${className}`}>
        Only {available} left in {city}
      </p>
    );
  }

  return null;
}
