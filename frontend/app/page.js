import Link from "next/link";

import CitySelector from "@/components/CitySelector";
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
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          Every shelf, every city, always in sync
        </p>
        <h1 className="mt-2 max-w-xl text-3xl font-bold leading-tight text-neutral-900 sm:text-4xl">
          Shop what is actually on the shelf in your city.
        </h1>
        <p className="mt-2 max-w-xl text-sm text-neutral-600">
          Stock counts update live as orders and restocks happen, so the badge you see is the truth.
        </p>
        <div className="mt-5">
          <CitySelector />
        </div>
      </section>

      <section aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Categories
        </h2>
        {categoriesError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {categoriesError}
          </p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-neutral-500">No categories yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <Link
                key={category}
                href={`/search?category=${encodeURIComponent(category)}`}
                className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:border-emerald-500 hover:text-emerald-700"
              >
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
