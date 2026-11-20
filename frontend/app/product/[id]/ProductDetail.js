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
  const [qty, setQty] = useState(1);
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
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
        <div className="aspect-square animate-pulse rounded-card bg-slate-200" />
        <div className="flex flex-col gap-4">
          <div className="h-3 w-24 animate-pulse rounded-pill bg-slate-200" />
          <div className="h-9 w-3/4 animate-pulse rounded bg-slate-200" />
          <div className="h-8 w-32 animate-pulse rounded bg-slate-200" />
          <div className="h-24 animate-pulse rounded-card bg-slate-200" />
        </div>
      </div>
    );
  }

  if (state.error || !state.product) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
        <p className="font-semibold">Could not load this product.</p>
        <p className="mt-1">{state.error || "Product not found."}</p>
        <Link href="/" className="focus-ring mt-3 inline-block rounded font-semibold underline">
          Back to the shelves
        </Link>
      </div>
    );
  }

  const product = state.product;
  const live = liveStock[product.id];
  const available = live?.available ?? product.available;
  const low = live?.low ?? product.low;
  const outOfStock = !available || available <= 0;
  const maxQty = Math.max(1, Math.min(10, available ?? 10));

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start lg:gap-10">
      <div className="card overflow-hidden">
        <ProductImage product={product} />
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-accent-700">{product.category}</p>
          <h1 className="mt-2 text-page-title font-extrabold text-slate-900 sm:text-display">{product.name}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <p className="text-3xl font-extrabold text-slate-900">{formatPrice(product.price)}</p>
          <StockBadge available={available} low={low} city={store?.city} />
        </div>

        {product.description && (
          <p className="text-sm leading-relaxed text-slate-600">{product.description}</p>
        )}

        <div className="card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-pill border border-slate-200 bg-white">
              <button
                type="button"
                aria-label="Decrease quantity"
                onClick={() => setQty((value) => Math.max(1, value - 1))}
                disabled={qty <= 1 || outOfStock}
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-l-pill text-lg font-semibold text-slate-600 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max={maxQty}
                value={qty}
                aria-label="Quantity"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setQty(Number.isFinite(next) ? Math.min(maxQty, Math.max(1, next)) : 1);
                }}
                className="h-11 w-12 border-x border-slate-200 bg-white text-center text-sm font-semibold text-slate-900 focus-visible:outline-none"
              />
              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => setQty((value) => Math.min(maxQty, value + 1))}
                disabled={qty >= maxQty || outOfStock}
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-r-pill text-lg font-semibold text-slate-600 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                +
              </button>
            </div>

            <button type="button" disabled={outOfStock} className="btn-primary flex-1 sm:flex-none">
              {outOfStock ? "Out of stock" : "Add to cart"}
            </button>
          </div>
        </div>

        <section aria-labelledby="availability-heading" className="card p-4">
          <h2 id="availability-heading" className="text-section font-semibold text-slate-900">
            Availability in other cities
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {product.availability?.map((row) => {
              const isSelected = row.store_id === store?.id;
              const isOut = row.available === 0;
              return (
                <li key={row.store_id}>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-xs font-semibold ${
                      isSelected
                        ? "border-accent-500 bg-accent-50 text-accent-800"
                        : isOut
                          ? "border-slate-200 bg-slate-50 text-slate-500"
                          : "border-slate-200 bg-white text-slate-700"
                    }`}
                  >
                    {row.city}
                    <span className={`font-medium ${isOut ? "text-slate-400" : "text-slate-500"}`}>
                      {isOut ? "Out of stock" : `${row.available} left`}
                    </span>
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
