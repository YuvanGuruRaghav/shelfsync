export default function ProductCardSkeleton() {
  return (
    <div className="card overflow-hidden" aria-hidden="true">
      <div className="aspect-square animate-pulse bg-slate-100" />
      <div className="space-y-2 border-t border-slate-100 p-3.5">
        <div className="h-2.5 w-16 animate-pulse rounded-pill bg-slate-200" />
        <div className="h-3 w-full animate-pulse rounded bg-slate-200" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
        <div className="flex items-center justify-between pt-2">
          <div className="h-4 w-14 animate-pulse rounded bg-slate-200" />
          <div className="h-5 w-16 animate-pulse rounded-pill bg-slate-200" />
        </div>
      </div>
    </div>
  );
}
