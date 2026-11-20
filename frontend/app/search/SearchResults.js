"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import ProductCard from "@/components/ProductCard";
import ProductCardSkeleton from "@/components/ProductCardSkeleton";
import SearchBar from "@/components/SearchBar";
import api from "@/lib/api";
import { useStore } from "@/lib/StoreContext";
import useLiveStock from "@/lib/useLiveStock";

export default function SearchResults() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const category = searchParams.get("category") ?? "";
  const minPrice = searchParams.get("min_price") ?? "";
  const maxPrice = searchParams.get("max_price") ?? "";

  const { store, ready, error: storeError } = useStore();
  const [result, setResult] = useState({ loading: true, error: null, items: [] });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const liveStock = useLiveStock(store?.id);

  useEffect(() => {
    if (!ready) return undefined;

    let cancelled = false;
    setResult({ loading: true, error: null, items: [] });

    api
      .search({
        q: q || undefined,
        store_id: store?.id,
        category: category || undefined,
        min_price: minPrice || undefined,
        max_price: maxPrice || undefined,
      })
      .then((data) => {
        if (cancelled) return;
        setResult({ loading: false, error: null, items: Array.isArray(data?.items) ? data.items : [] });
      })
      .catch((error) => {
        if (cancelled) return;
        setResult({ loading: false, error: error.message, items: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [ready, q, category, minPrice, maxPrice, store?.id]);

  const activeFilterCount = [category, minPrice, maxPrice].filter(Boolean).length;
  const clearHref = q ? `/search?q=${encodeURIComponent(q)}` : "/search";
  const title = q ? `Results for “${q}”` : category ? category : "All products";

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4 sm:p-5">
        <SearchBar defaultValue={q} />

        <div className="mt-4">
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="filter-panel"
            onClick={() => setFiltersOpen((open) => !open)}
            className="btn-secondary w-full justify-between lg:hidden"
          >
            <span className="inline-flex items-center gap-2">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                className="h-4 w-4"
              >
                <path d="M3 5.5h14M5.5 10h9M8 14.5h4" />
              </svg>
              Filters
              {activeFilterCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-pill bg-accent-600 px-1.5 text-[11px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-4 w-4 transition ${filtersOpen ? "rotate-180" : ""}`}
            >
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>

          <div id="filter-panel" className={`${filtersOpen ? "block" : "hidden"} mt-4 lg:mt-0 lg:block`}>
            <form
              action="/search"
              method="get"
              className="grid gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
            >
              {q && <input type="hidden" name="q" value={q} />}

              <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Category
                <input
                  type="text"
                  name="category"
                  defaultValue={category}
                  placeholder="e.g. Audio"
                  className="field"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Min price (₹)
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  name="min_price"
                  defaultValue={minPrice}
                  placeholder="0"
                  className="field"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Max price (₹)
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  name="max_price"
                  defaultValue={maxPrice}
                  placeholder="Any"
                  className="field"
                />
              </label>

              <div className="flex items-center gap-2 lg:justify-end">
                <button type="submit" className="btn-primary flex-1 px-4 lg:flex-none">
                  Apply
                </button>
                <Link href={clearHref} className="btn-secondary px-4">
                  Clear
                </Link>
              </div>
            </form>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-page-title font-extrabold text-slate-900">{title}</h1>
        {!ready || (result.loading && !result.error) ? null : result.error ? null : (
          <p className="text-sm text-slate-500">
            {result.items.length} {result.items.length === 1 ? "result" : "results"}
            {store ? ` in ${store.city}` : ""}
          </p>
        )}
      </div>

      {!ready || result.loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <ProductCardSkeleton key={index} />
          ))}
        </div>
      ) : result.error ? (
        <div className="rounded-card border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
          <p className="font-semibold">Search failed.</p>
          <p className="mt-1">{result.error}</p>
          {storeError && <p className="mt-1 text-red-600">{storeError}</p>}
        </div>
      ) : result.items.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              className="h-5 w-5"
            >
              <circle cx="9" cy="9" r="5.5" />
              <path d="m13.5 13.5 3 3" />
            </svg>
          </span>
          <p className="text-section font-semibold text-slate-900">No products matched{q ? ` “${q}”` : ""}</p>
          <p className="max-w-sm text-sm text-slate-600">
            Try a different word, a shorter phrase, or clear your filters.
          </p>
          <Link href={clearHref} className="btn-secondary mt-1">
            Clear filters
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {result.items.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              city={store?.city}
              live={liveStock[product.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
