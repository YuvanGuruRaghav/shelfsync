/**
 * In-process registry of connected SSE clients, grouped by store.
 *
 * Kept out of the route so the live-stock consumer can push without importing
 * Express routes, and so the route stays thin.
 */

const clientsByStore = new Map(); // store_id -> Set<res>

export function addStockClient(storeId, res) {
  let clients = clientsByStore.get(storeId);
  if (!clients) {
    clients = new Set();
    clientsByStore.set(storeId, clients);
  }
  clients.add(res);

  return () => removeStockClient(storeId, res);
}

export function removeStockClient(storeId, res) {
  const clients = clientsByStore.get(storeId);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) clientsByStore.delete(storeId);
}

/**
 * Push one `stock` event to every client watching `payload.store_id`.
 * The public event only carries { product_id, store_id, available, low }.
 */
export function broadcastStock(payload) {
  const clients = clientsByStore.get(payload.store_id);
  if (!clients || clients.size === 0) return;

  const data = {
    product_id: payload.product_id,
    store_id: payload.store_id,
    available: payload.available,
    low: payload.available <= payload.low_stock_threshold,
  };
  const frame = `event: stock\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      removeStockClient(payload.store_id, res);
    }
  }
}

/** Used by tests/shutdown to inspect or drop connections. */
export function stockClientCount(storeId) {
  return clientsByStore.get(storeId)?.size ?? 0;
}
