const BASE =
  "inline-flex max-w-full items-center gap-1.5 rounded-pill px-2.5 py-1 text-left text-[11px] font-semibold leading-tight";

function Dot({ className }) {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${className}`} />;
}

export default function StockBadge({ available, low, city, className = "" }) {
  if (available === null || available === undefined) return null;

  const place = city ? ` in ${city}` : "";

  if (available === 0) {
    return (
      <p className={`${BASE} bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200 ${className}`}>
        <Dot className="bg-slate-400" />
        Out of stock{place}
      </p>
    );
  }

  if (low) {
    return (
      <p className={`${BASE} bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 ${className}`}>
        <Dot className="bg-amber-500" />
        Only {available} left{place}
      </p>
    );
  }

  return (
    <p className={`${BASE} bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200 ${className}`}>
      <Dot className="bg-accent-500" />
      In stock
    </p>
  );
}
