import { Suspense } from "react";

import SearchResults from "./SearchResults";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search · ShelfSync",
};

export default function SearchPage() {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading search…</p>}>
      <SearchResults />
    </Suspense>
  );
}
