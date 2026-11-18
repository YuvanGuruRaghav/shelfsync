import config from "../config.js";
import { withTransaction } from "../db/pool.js";
import { recordInventoryChange } from "../services/inventoryService.js";

/**
 * Reservation expiry worker (PLAN 4.2).
 *
 * Finds ACTIVE reservations past `expires_at`, processes ONE reservation per
 * transaction (locked FOR UPDATE SKIP LOCKED so it never contends with checkout),
 * marks it EXPIRED, releases its `reserved` qty and writes an `inventory.changed`
 * row with reason EXPIRE. Rows are handled in (product_id, store_id) order to keep
 * a stable lock order. Cart items are deliberately left alone: the shopper keeps the
 * cart and must re-reserve at checkout, which falls back to the direct decrement.
 */

/** Expire the next due reservation inside `client`'s transaction. Returns it, or null. */
export async function expireNextReservation(client) {
  const { rows } = await client.query(
    `SELECT id, product_id, store_id, qty
     FROM reservations
     WHERE status = 'ACTIVE' AND expires_at < now()
     ORDER BY product_id, store_id, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
  );
  const hold = rows[0];
  if (!hold) return null;

  const { rowCount } = await client.query(
    `UPDATE store_stock SET reserved = reserved - $1
     WHERE product_id = $2 AND store_id = $3 AND reserved >= $1`,
    [hold.qty, hold.product_id, hold.store_id],
  );

  await client.query(
    `UPDATE reservations SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'`,
    [hold.id],
  );

  if (rowCount > 0) {
    await recordInventoryChange(client, {
      productId: hold.product_id,
      storeId: hold.store_id,
      reason: "EXPIRE",
    });
  } else {
    // The stock invariant was already broken elsewhere; the hold is still released
    // and the reservation expires, so never decrement below zero.
    console.warn(
      `[expiry] reservation ${hold.id} had no reservable stock on product ${hold.product_id} at store ${hold.store_id}`,
    );
  }

  return hold;
}

/** Drain every due reservation, one transaction each. Returns how many expired. */
export async function runReservationExpiryTick() {
  let expired = 0;
  for (;;) {
    const hold = await withTransaction((client) => expireNextReservation(client));
    if (!hold) return expired;
    expired += 1;
  }
}

/** Start the interval loop. Errors are logged; the server keeps running. */
export function startReservationExpiry({ intervalMs = config.reservationExpiryIntervalMs } = {}) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const expired = await runReservationExpiryTick();
      if (expired > 0) console.log(`[expiry] released ${expired} expired reservation(s)`);
    } catch (err) {
      console.error("[expiry] tick failed; continuing next tick", err);
    } finally {
      running = false;
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
