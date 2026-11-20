"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import api from "./api";

const STORE_KEY = "shelfsync.store_id";
const DEFAULT_CITY = "Bengaluru";

const StoreContext = createContext(null);

function readSavedStoreId() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Selected store/city, persisted in localStorage and exposed to client components.
 * Stores are always loaded from GET /api/stores; Bengaluru is resolved by city name,
 * never by a hardcoded id. `ready` is false until the first client render has read
 * localStorage, so server HTML and the first client render match.
 */
export function StoreProvider({ children }) {
  const [stores, setStores] = useState([]);
  const [store, setStoreState] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let savedId = null;
    try {
      savedId = readSavedStoreId();
    } catch {
      savedId = null;
    }

    api
      .getStores()
      .then((list) => {
        if (cancelled) return;
        const safeList = Array.isArray(list) ? list : [];
        setStores(safeList);
        setStoreState(
          safeList.find((item) => item.id === savedId) ??
            safeList.find((item) => item.city?.toLowerCase() === DEFAULT_CITY.toLowerCase()) ??
            safeList[0] ??
            null,
        );
        setError(null);
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setStores([]);
        setStoreState(null);
        setError(err.message || "Could not load cities.");
        setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setStore = useCallback((next) => {
    if (!next) return;
    setStoreState(next);
    try {
      window.localStorage.setItem(STORE_KEY, String(next.id));
    } catch {
      // Storage can be blocked; the in-memory selection still works for this page view.
    }
  }, []);

  const value = useMemo(
    () => ({ store, stores, setStore, ready, error }),
    [store, stores, setStore, ready, error],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useStore must be used inside <StoreProvider>");
  return context;
}
