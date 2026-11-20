"use client";

import { useState } from "react";

/**
 * Product photo with a fixed square frame. Photos are site-relative files under
 * frontend/public, so a plain <img> is all we need (no next/image remote config).
 * Falls back to a neutral tile with the product initial and category.
 */
export default function ProductImage({ product, className = "" }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(product.image_url) && !failed;
  const initial = (product.name ?? "").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className={`relative aspect-square w-full overflow-hidden bg-white ${className}`}>
      {showImage ? (
        <img
          src={product.image_url}
          alt={product.name}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain p-4"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-100 px-4 text-center">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-white text-xl font-semibold text-slate-500"
          >
            {initial}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {product.category}
          </span>
        </div>
      )}
    </div>
  );
}
