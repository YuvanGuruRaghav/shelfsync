"use client";

import { useEffect, useState } from "react";

import ProductCard from "@/components/ProductCard";
import api from "@/lib/api";
import { useStore } from "@/lib/StoreContext";
import useLiveStock from "@/lib/useLiveStock";

export default function HomeCatalog() {
  const { store, ready, error: storeError } = useStore();
  const [result, setResult] = useState({ loading: true, error: null, items: [] });
  const liveStock = useLiveStock(store?.id);

  useEffect(() => {
    if (!ready) return undefined;

    if (!store) {
      setResult({
        loading: false,
        error: storeError || "No city is available right now.",
        items: [],
      });
      return undefined;
    }

    let cancelled = false;
    setResult({ loading: true, error: null, items: [] });

    api
      .getProducts({ store_id: store.id, limit: 24 })
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
  }, [ready, store, storeError]);

  return (
    <section aria-labelledby="products-heading">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="products-heading" className="text-lg font-semibold text-neutral-900">
          On the shelves{store ? ` in ${store.city}` : ""}
        </h2>
        {!result.loading && !result.error && (
          <p className="text-xs text-neutral-500">{result.items.length} products</p>
        )}
      </div>

      {result.loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="aspect-[3/4] animate-pulse rounded-xl bg-neutral-200" />
          ))}
        </div>
      )}

      {!result.loading && result.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
          <p className="font-medium">Could not load products.</p>
          <p className="mt-1">{result.error}</p>
        </div>
      )}

      {!result.loading && !result.error && result.items.length === 0 && (
        <p className="rounded-xl border border-neutral-200 bg-white px-4 py-6 text-sm text-neutral-600">
          No products are listed for this city yet.
        </p>
      )}

      {!result.loading && !result.error && result.items.length > 0 && (
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
    </section>
  );
}
