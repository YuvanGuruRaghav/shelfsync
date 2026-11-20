"use client";

import { useStore } from "@/lib/StoreContext";

export default function CitySelector({ className = "", label = "City" }) {
  const { store, stores, setStore, ready, error } = useStore();

  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{label}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        className="pointer-events-none absolute left-3 h-4 w-4 text-accent-600"
      >
        <path d="M10 17s5.5-4.6 5.5-9a5.5 5.5 0 1 0-11 0c0 4.4 5.5 9 5.5 9Z" />
        <circle cx="10" cy="8" r="1.9" />
      </svg>
      <select
        aria-label={`Choose ${label.toLowerCase()}`}
        className="h-9 appearance-none rounded-pill border border-slate-200 bg-white pl-9 pr-8 text-sm font-semibold text-slate-800 shadow-card transition hover:border-slate-300 focus-visible:border-accent-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed disabled:text-slate-400"
        value={store?.id ?? ""}
        disabled={!ready || stores.length === 0}
        onChange={(event) => {
          const next = stores.find((item) => item.id === Number(event.target.value));
          if (next) setStore(next);
        }}
      >
        {!store && (
          <option value="" disabled>
            {ready ? (error ? "Cities unavailable" : "Select city") : "Loading cities…"}
          </option>
        )}
        {stores.map((item) => (
          <option key={item.id} value={item.id}>
            {item.city}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-slate-400"
      >
        <path d="m6 8 4 4 4-4" />
      </svg>
    </label>
  );
}
