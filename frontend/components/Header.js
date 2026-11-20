"use client";

import Link from "next/link";

import CitySelector from "./CitySelector";
import SearchBar from "./SearchBar";

export default function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="container-page flex items-center gap-3 py-3">
        <Link href="/" className="focus-ring flex shrink-0 items-baseline gap-2 rounded-lg">
          <span className="text-xl font-extrabold tracking-tight text-slate-900">
            Shelf<span className="text-accent-600">Sync</span>
          </span>
          <span className="hidden text-[11px] font-medium leading-tight text-slate-500 lg:inline">
            Every shelf, every city, always in sync
          </span>
        </Link>

        <div className="mx-auto hidden min-w-0 w-full max-w-xl sm:block">
          <SearchBar />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <CitySelector />
          <Link
            href="/cart"
            aria-label="Cart, 0 items"
            className="focus-ring relative inline-flex h-9 items-center gap-2 rounded-pill border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 shadow-card transition hover:border-slate-300 hover:bg-slate-50"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M2.5 3h1.7l1.4 8.2a1.5 1.5 0 0 0 1.5 1.3h6.6a1.5 1.5 0 0 0 1.5-1.2L16.5 6H5" />
              <circle cx="8" cy="16" r="1.2" />
              <circle cx="14" cy="16" r="1.2" />
            </svg>
            <span className="hidden sm:inline">Cart</span>
            {/* Static placeholder until the cart UI lands in Step 10. */}
            <span className="flex h-5 min-w-5 items-center justify-center rounded-pill bg-accent-600 px-1.5 text-[11px] font-bold text-white">
              0
            </span>
          </Link>
        </div>
      </div>

      <div className="container-page pb-3 sm:hidden">
        <SearchBar />
      </div>
    </header>
  );
}
