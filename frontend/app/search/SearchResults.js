"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import ProductCard from "@/components/ProductCard";
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

  const activeFilters = [
    category && `Category: ${category}`,
    minPrice && `Min ₹${minPrice}`,
    maxPrice && `Max ₹${maxPrice}`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-2xl border border-neutral-200 bg-white p-4">
        <SearchBar defaultValue={q} />
        {activeFilters.length > 0 && (
          <p className="mt-3 text-xs text-neutral-600">Filters — {activeFilters.join(" · ")}</p>
        )}
      </section>

      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-neutral-900">
          {q ? `Results for “${q}”` : category ? category : "All products"}
        </h1>
        {!result.loading && !result.error && (
          <p className="text-xs text-neutral-500">
            {result.items.length} {result.items.length === 1 ? "result" : "results"}
            {store ? ` in ${store.city}` : ""}
          </p>
        )}
      </div>

      {!ready || result.loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="aspect-[3/4] animate-pulse rounded-xl bg-neutral-200" />
          ))}
        </div>
      ) : result.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
          <p className="font-medium">Search failed.</p>
          <p className="mt-1">{result.error}</p>
          {storeError && <p className="mt-1 text-red-600">{storeError}</p>}
        </div>
      ) : result.items.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-4 py-6 text-sm text-neutral-600">
          <p className="font-medium text-neutral-800">No products matched.</p>
          <p className="mt-1">Try a different word, a shorter phrase, or remove a filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
