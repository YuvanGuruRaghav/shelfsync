export default function SearchBar({ defaultValue = "", className = "" }) {
  return (
    <form action="/search" method="get" role="search" className={`flex min-w-0 flex-1 gap-2 ${className}`}>
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search products…"
        aria-label="Search products"
        className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
      />
      <button
        type="submit"
        className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Search
      </button>
    </form>
  );
}
