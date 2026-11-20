"use client";

import { useStore } from "@/lib/StoreContext";

export default function CitySelector({ className = "", label = "City" }) {
  const { store, stores, setStore, ready, error } = useStore();

  return (
    <label className={`inline-flex items-center gap-2 text-sm ${className}`}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="text-neutral-500">
        📍
      </span>
      <select
        aria-label={`Choose ${label.toLowerCase()}`}
        className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-60"
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
    </label>
  );
}
