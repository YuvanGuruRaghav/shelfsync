import Link from "next/link";

import CitySelector from "@/components/CitySelector";
import SearchBar from "@/components/SearchBar";
import api from "@/lib/api";

import HomeCatalog from "./HomeCatalog";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let categories = [];
  let categoriesError = null;
  try {
    categories = await api.getCategories();
  } catch (error) {
    categoriesError = error.message || "Categories are unavailable right now.";
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-accent-50 via-white to-white px-5 py-8 shadow-card sm:px-10 sm:py-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-accent-100/70 blur-3xl"
        />
        <div className="relative flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-700">
            Every shelf, every city, always in sync
          </p>
          <h1 className="max-w-2xl text-display font-extrabold text-slate-900">
            Shop what is actually on the shelf in your city.
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-slate-600">
            Stock counts update live as orders and restocks happen, so the badge you see is the truth.
          </p>
          <div className="mt-1 w-full max-w-xl">
            <SearchBar />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>Showing stock in</span>
            <CitySelector />
          </div>
        </div>
      </section>

      <section aria-labelledby="categories-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="categories-heading" className="text-section font-semibold text-slate-900">
            Shop by category
          </h2>
          <Link href="/search" className="focus-ring rounded text-sm font-semibold text-accent-700 hover:text-accent-800">
            Browse all
          </Link>
        </div>

        {categoriesError ? (
          <p className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{categoriesError}</p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-slate-500">No categories yet.</p>
        ) : (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            {categories.map((category) => (
              <Link key={category} href={`/search?category=${encodeURIComponent(category)}`} className="chip">
                {category}
              </Link>
            ))}
          </div>
        )}
      </section>

      <HomeCatalog />
    </div>
  );
}
