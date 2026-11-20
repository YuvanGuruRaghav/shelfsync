"use client";

import Link from "next/link";

import { formatPrice } from "@/lib/format";

import ProductImage from "./ProductImage";
import StockBadge from "./StockBadge";

export default function ProductCard({ product, city, live }) {
  const available = live?.available ?? product.available;
  const low = live?.low ?? product.low;

  return (
    <Link
      href={`/product/${product.id}`}
      className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition hover:border-neutral-300 hover:shadow-sm"
    >
      <ProductImage product={product} />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-[11px] uppercase tracking-wide text-neutral-500">{product.category}</p>
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-neutral-900">{product.name}</h3>
        <p className="mt-auto pt-1 text-sm font-semibold text-neutral-900">{formatPrice(product.price)}</p>
        <StockBadge available={available} low={low} city={city} />
      </div>
    </Link>
  );
}
