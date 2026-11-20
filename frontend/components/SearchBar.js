export default function SearchBar({ defaultValue = "", className = "" }) {
  return (
    <form action="/search" method="get" role="search" className={`relative flex w-full min-w-0 items-center ${className}`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="pointer-events-none absolute left-3.5 h-4 w-4 text-slate-400"
      >
        <circle cx="9" cy="9" r="5.5" />
        <path d="m13.5 13.5 3 3" />
      </svg>
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search products, brands and more"
        aria-label="Search products"
        className="h-11 w-full rounded-pill border border-slate-200 bg-white pl-10 pr-24 text-sm text-slate-900 shadow-card transition placeholder:text-slate-400 focus-visible:border-accent-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/25"
      />
      <button
        type="submit"
        className="absolute right-1.5 inline-flex h-8 items-center rounded-pill bg-accent-600 px-4 text-sm font-semibold text-white transition hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
      >
        Search
      </button>
    </form>
  );
}
