"use client";

import { useEffect, useState } from "react";

import api from "./api";

/**
 * Live stock for one store over SSE.
 *
 * Returns a map: product_id -> { available, low }. Events are applied whenever they
 * arrive (the relay can lag by a second or two, and Kafka will add more later), so the
 * map is never treated as "everything has been delivered". The param is replaced by
 * each new event for that product.
 */
export default function useLiveStock(storeId) {
  const [stock, setStock] = useState({});

  useEffect(() => {
    setStock({});
    if (!storeId) return undefined;

    let source = null;
    let retryTimer = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      source = new EventSource(api.stockStreamUrl(storeId));

      source.addEventListener("open", () => {
        attempt = 0;
      });

      source.addEventListener("stock", (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!data || data.store_id !== storeId) return;
        setStock((previous) => ({
          ...previous,
          [data.product_id]: { available: data.available, low: data.low },
        }));
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [storeId]);

  return stock;
}
