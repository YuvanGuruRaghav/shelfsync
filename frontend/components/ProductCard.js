"use client";

import Link from "next/link";
import { useState } from "react";

import { formatPrice } from "@/lib/format";

import StockBadge from "./StockBadge";

export default function ProductCard({ product, city, live }) {
  const [imageFailed, setImageFailed] = useState(false);
  const available = live?.available ?? product.available;
  const low = live?.low ?? product.low;
  const showImage = Boolean(product.image_url) && !imageFailed;

  return (
    <Link
      href={`/product/${product.id}`}
      className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition hover:border-neutral-300 hover:shadow-sm"
    >
      <div className="relative aspect-square bg-neutral-100">
        {showImage ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">No image</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-[11px] uppercase tracking-wide text-neutral-500">{product.category}</p>
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-neutral-900">{product.name}</h3>
        <p className="mt-auto pt-1 text-sm font-semibold text-neutral-900">{formatPrice(product.price)}</p>
        <StockBadge available={available} low={low} city={city} />
      </div>
    </Link>
  );
}
