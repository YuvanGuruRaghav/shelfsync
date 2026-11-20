"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import ProductImage from "@/components/ProductImage";
import StockBadge from "@/components/StockBadge";
import api from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { useStore } from "@/lib/StoreContext";
import useLiveStock from "@/lib/useLiveStock";

export default function ProductDetail({ productId }) {
  const { store, ready } = useStore();
  const [state, setState] = useState({ loading: true, error: null, product: null });
  const liveStock = useLiveStock(store?.id);

  useEffect(() => {
    if (!ready) return undefined;

    let cancelled = false;
    setState({ loading: true, error: null, product: null });

    api
      .getProduct(productId, store ? { store_id: store.id } : {})
      .then((product) => {
        if (cancelled) return;
        setState({ loading: false, error: null, product });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ loading: false, error: error.message, product: null });
      });

    return () => {
      cancelled = true;
    };
  }, [ready, productId, store?.id]);

  if (!ready || state.loading) {
    return (
      <div className="grid gap-6 md:grid-cols-2">
        <div className="aspect-square animate-pulse rounded-2xl bg-neutral-200" />
        <div className="flex flex-col gap-3">
          <div className="h-4 w-24 animate-pulse rounded bg-neutral-200" />
          <div className="h-8 w-3/4 animate-pulse rounded bg-neutral-200" />
          <div className="h-6 w-28 animate-pulse rounded bg-neutral-200" />
          <div className="h-20 animate-pulse rounded bg-neutral-200" />
        </div>
      </div>
    );
  }

  if (state.error || !state.product) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
        <p className="font-medium">Could not load this product.</p>
        <p className="mt-1">{state.error || "Product not found."}</p>
        <Link href="/" className="mt-3 inline-block font-medium underline">
          Back to the shelves
        </Link>
      </div>
    );
  }

  const product = state.product;
  const live = liveStock[product.id];
  const available = live?.available ?? product.available;
  const low = live?.low ?? product.low;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="overflow-hidden rounded-2xl border border-neutral-200">
        <ProductImage product={product} />
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{product.category}</p>
          <h1 className="mt-1 text-2xl font-bold leading-tight text-neutral-900 sm:text-3xl">{product.name}</h1>
        </div>

        <p className="text-2xl font-semibold text-neutral-900">{formatPrice(product.price)}</p>

        <div className="min-h-6">
          <StockBadge available={available} low={low} city={store?.city} className="text-sm" />
        </div>

        {product.description && <p className="text-sm leading-relaxed text-neutral-700">{product.description}</p>}

        <section aria-labelledby="availability-heading" className="rounded-xl border border-neutral-200 bg-white p-4">
          <h2 id="availability-heading" className="text-sm font-semibold text-neutral-900">
            Availability by city
          </h2>
          <ul className="mt-2 divide-y divide-neutral-100">
            {product.availability?.map((row) => {
              const isSelected = row.store_id === store?.id;
              return (
                <li
                  key={row.store_id}
                  className={`flex items-center justify-between py-2 text-sm ${
                    isSelected ? "font-medium text-neutral-900" : "text-neutral-600"
                  }`}
                >
                  <span>{row.city}</span>
                  <span className={row.available === 0 ? "text-red-600" : ""}>
                    {row.available === 0 ? "Out of stock" : `${row.available} available`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
