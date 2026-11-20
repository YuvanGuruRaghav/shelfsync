"use client";

import Link from "next/link";

import CitySelector from "./CitySelector";
import SearchBar from "./SearchBar";

export default function Header() {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="text-lg font-bold tracking-tight text-neutral-900">
          Shelf<span className="text-emerald-600">Sync</span>
        </Link>

        <div className="order-3 flex w-full min-w-0 items-center gap-3 sm:order-2 sm:w-auto sm:flex-1">
          <SearchBar className="sm:max-w-sm" />
        </div>

        <div className="order-2 ml-auto flex items-center gap-3 sm:order-3">
          <CitySelector />
          <Link
            href="/cart"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Cart
          </Link>
        </div>
      </div>
    </header>
  );
}
