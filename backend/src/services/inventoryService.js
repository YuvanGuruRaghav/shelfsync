/**
 * Shared inventory helpers.
 *
 * Every function takes a pg client so it runs inside the caller's transaction and
 * never opens its own. Used by the cart now; checkout, the expiry worker and admin
 * restock will use the same helpers.
 */

export const INVENTORY_REASONS = ["ORDER", "RESERVE", "RELEASE", "EXPIRE", "RESTOCK"];

/**
 * Write one `inventory.changed` outbox row for the current state of a (product, store)
 * row, then run the low-stock alert check. The caller must already have applied the
 * stock/reserved change on `client`.
 */
export async function recordInventoryChange(client, { productId, storeId, reason }) {
  if (!INVENTORY_REASONS.includes(reason)) {
    throw new Error(`recordInventoryChange: unknown reason ${reason}`);
  }

  const { rows } = await client.query(
    `SELECT ss.stock, ss.reserved, s.city, p.low_stock_threshold
     FROM store_stock ss
     JOIN stores s ON s.id = ss.store_id
     JOIN products p ON p.id = ss.product_id
     WHERE ss.product_id = $1 AND ss.store_id = $2`,
    [productId, storeId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `recordInventoryChange: no store_stock row for product ${productId} at store ${storeId}`,
    );
  }

  const stock = Number(row.stock);
  const reserved = Number(row.reserved);
  const available = stock - reserved;
  const payload = {
    product_id: productId,
    store_id: storeId,
    city: row.city,
    stock,
    reserved,
    available,
    low_stock_threshold: Number(row.low_stock_threshold),
    reason,
    changed_at: new Date().toISOString(),
  };

  await client.query(
    `INSERT INTO outbox (topic, key, payload)
     VALUES ('inventory.changed', $1, $2::jsonb)`,
    [`${productId}:${storeId}`, JSON.stringify(payload)],
  );

  await runAlertCheck(client, { productId, storeId });
  return payload;
}

/**
 * PLAN 4.3: keep exactly one OPEN alert while available <= low_stock_threshold, and
 * resolve it once available climbs back above the threshold. Safe under concurrency
 * thanks to the partial unique index alerts_open_unique_idx.
 */
export async function runAlertCheck(client, { productId, storeId }) {
  const { rows } = await client.query(
    `SELECT ss.stock - ss.reserved AS available, p.low_stock_threshold
     FROM store_stock ss
     JOIN products p ON p.id = ss.product_id
     WHERE ss.product_id = $1 AND ss.store_id = $2`,
    [productId, storeId],
  );
  const row = rows[0];
  if (!row) return null;

  const available = Number(row.available);

  if (available <= Number(row.low_stock_threshold)) {
    await client.query(
      `INSERT INTO alerts (product_id, store_id, stock_level, status)
       VALUES ($1, $2, $3, 'OPEN')
       ON CONFLICT DO NOTHING`,
      [productId, storeId, available],
    );
    return "OPEN";
  }

  const { rowCount } = await client.query(
    `UPDATE alerts SET status = 'RESOLVED'
     WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'`,
    [productId, storeId],
  );
  return rowCount > 0 ? "RESOLVED" : null;
}
