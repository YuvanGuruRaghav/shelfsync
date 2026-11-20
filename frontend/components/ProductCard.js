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
      className="focus-ring group card flex flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lift"
    >
      <ProductImage product={product} />
      <div className="flex flex-1 flex-col gap-1.5 border-t border-slate-100 p-3.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-accent-700">{product.category}</p>
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900">{product.name}</h3>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
          <p className="text-base font-bold text-slate-900">{formatPrice(product.price)}</p>
          <StockBadge available={available} low={low} city={city} />
        </div>
      </div>
    </Link>
  );
}
