import config from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { httpError } from "./errors.js";
import { recordInventoryChange } from "./inventoryService.js";

/**
 * Cart + reservations (PLAN 4.2).
 *
 * A cart belongs to one session and one store. Every quantity change adjusts
 * `store_stock.reserved` by `delta = newQty - activeReservationQty` and keeps one
 * ACTIVE reservation per (cart, product). All writes happen inside one transaction
 * and the cart row is locked, so two requests from the same session serialise.
 */

const TTL_MINUTES = config.reservationTtlMinutes;

function emptyCart() {
  return { store_id: null, city: null, items: [], total: 0, expires_at: null };
}

async function assertStore(client, storeId) {
  const { rowCount } = await client.query("SELECT 1 FROM stores WHERE id = $1", [storeId]);
  if (rowCount === 0) throw httpError(400, "INVALID_STORE", `Store ${storeId} does not exist`);
}

async function assertProduct(client, productId) {
  const { rowCount } = await client.query("SELECT 1 FROM products WHERE id = $1", [productId]);
  if (rowCount === 0) throw httpError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
}

/** Read the cart in the public shape. Works with the pool or a transaction client. */
export async function loadCart(queryable, sessionId) {
  const { rows: cartRows } = await queryable.query(
    `SELECT c.id, c.store_id, s.city
     FROM carts c
     JOIN stores s ON s.id = c.store_id
     WHERE c.session_id = $1`,
    [sessionId],
  );
  const cart = cartRows[0];
  if (!cart) return emptyCart();

  const { rows: itemRows } = await queryable.query(
    `SELECT ci.product_id, p.name, p.price, ci.qty,
            EXISTS (
              SELECT 1 FROM reservations r
              WHERE r.cart_id = ci.cart_id AND r.product_id = ci.product_id AND r.status = 'ACTIVE'
            ) AS held,
            COALESCE(ss.stock - ss.reserved, 0) AS available
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN store_stock ss ON ss.product_id = ci.product_id AND ss.store_id = $2
     WHERE ci.cart_id = $1
     ORDER BY ci.product_id`,
    [cart.id, cart.store_id],
  );

  const { rows: expiryRows } = await queryable.query(
    `SELECT min(expires_at) AS expires_at
     FROM reservations
     WHERE cart_id = $1 AND status = 'ACTIVE'`,
    [cart.id],
  );

  const items = itemRows.map((row) => {
    const price = Number(row.price);
    const qty = Number(row.qty);
    return {
      product_id: row.product_id,
      name: row.name,
      price,
      qty,
      line_total: Number((price * qty).toFixed(2)),
      held: row.held,
      available: Number(row.available),
    };
  });

  const total = Number(items.reduce((sum, item) => sum + item.line_total, 0).toFixed(2));

  return {
    store_id: cart.store_id,
    city: cart.city,
    items,
    total,
    expires_at: expiryRows[0]?.expires_at ?? null,
  };
}

export async function getCart(sessionId) {
  return loadCart(pool, sessionId);
}

/**
 * Get the session's cart (creating it if needed) and lock its row. A concurrent
 * first-time insert blocks on the unique session_id index, then reuses the row.
 *
 * The row can also disappear between the conflicting INSERT and the locking SELECT:
 * a concurrent DELETE /api/cart (or checkout) removes the cart and commits while we
 * are waiting for it. There is nothing to lock then, so retry the insert/lock pair.
 */
const CART_LOCK_ATTEMPTS = 3;

async function lockOrCreateCart(client, sessionId, storeId) {
  for (let attempt = 1; attempt <= CART_LOCK_ATTEMPTS; attempt += 1) {
    const inserted = await client.query(
      `INSERT INTO carts (session_id, store_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING
       RETURNING id, store_id`,
      [sessionId, storeId],
    );

    if (inserted.rows[0]) {
      const { rows } = await client.query("SELECT id, store_id FROM carts WHERE id = $1 FOR UPDATE", [
        inserted.rows[0].id,
      ]);
      if (rows[0]) return rows[0];
      continue;
    }

    const { rows } = await client.query(
      "SELECT id, store_id FROM carts WHERE session_id = $1 FOR UPDATE",
      [sessionId],
    );
    if (rows[0]) return rows[0];
  }

  throw new Error(
    `could not lock or create the cart for session ${sessionId} after ${CART_LOCK_ATTEMPTS} attempts`,
  );
}

/**
 * Set one line to `qty` (0 removes it) and move `reserved` by the difference between
 * `qty` and whatever is actively held — never by cart_items.qty, because a hold can
 * expire while the line stays.
 */
async function applyLineChange(client, { cartId, storeId, productId, qty }) {
  const { rows: holdRows } = await client.query(
    `SELECT id, qty FROM reservations
     WHERE cart_id = $1 AND product_id = $2 AND status = 'ACTIVE'
     FOR UPDATE`,
    [cartId, productId],
  );
  const hold = holdRows[0] ?? null;
  const held = hold ? Number(hold.qty) : 0;
  const delta = qty - held;
  let stockChanged = false;

  if (delta > 0) {
    const { rowCount } = await client.query(
      `UPDATE store_stock SET reserved = reserved + $1
       WHERE product_id = $2 AND store_id = $3 AND stock - reserved >= $1`,
      [delta, productId, storeId],
    );
    if (rowCount === 0) {
      const { rows } = await client.query(
        `SELECT COALESCE(stock - reserved, 0) AS available
         FROM store_stock WHERE product_id = $1 AND store_id = $2`,
        [productId, storeId],
      );
      const available = Number(rows[0]?.available ?? 0);
      throw httpError(
        409,
        "INSUFFICIENT_STOCK",
        `Only ${available} available for product ${productId} at this store`,
        { available },
      );
    }
    stockChanged = true;
  } else if (delta < 0) {
    const { rowCount } = await client.query(
      `UPDATE store_stock SET reserved = reserved + $1
       WHERE product_id = $2 AND store_id = $3`,
      [delta, productId, storeId],
    );
    stockChanged = rowCount > 0;
  }

  if (qty > 0) {
    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, qty) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = EXCLUDED.qty`,
      [cartId, productId, qty],
    );
    if (hold) {
      await client.query("UPDATE reservations SET qty = $1 WHERE id = $2", [qty, hold.id]);
    } else {
      await client.query(
        `INSERT INTO reservations (cart_id, product_id, store_id, qty, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
        [cartId, productId, storeId, qty, TTL_MINUTES],
      );
    }
  } else {
    await client.query("DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2", [
      cartId,
      productId,
    ]);
    await client.query(
      `UPDATE reservations SET status = 'EXPIRED'
       WHERE cart_id = $1 AND product_id = $2 AND status = 'ACTIVE'`,
      [cartId, productId],
    );
  }

  // Any cart change refreshes the whole cart's holds.
  await client.query(
    `UPDATE reservations SET expires_at = now() + make_interval(mins => $2)
     WHERE cart_id = $1 AND status = 'ACTIVE'`,
    [cartId, TTL_MINUTES],
  );

  if (stockChanged) {
    await recordInventoryChange(client, {
      productId,
      storeId,
      reason: delta > 0 ? "RESERVE" : "RELEASE",
    });
  }
}

export async function setCartItem({ sessionId, productId, qty, storeId }) {
  await withTransaction(async (client) => {
    await assertStore(client, storeId);
    await assertProduct(client, productId);

    const cart = await lockOrCreateCart(client, sessionId, storeId);
    if (cart.store_id !== storeId) {
      const { rows } = await client.query(
        "SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1",
        [cart.id],
      );
      if (rows[0].count > 0) {
        throw httpError(
          409,
          "CART_STORE_MISMATCH",
          "This cart belongs to another store. Clear the cart before switching stores.",
          { store_id: cart.store_id },
        );
      }
      await client.query("UPDATE carts SET store_id = $1 WHERE id = $2", [storeId, cart.id]);
    }

    await applyLineChange(client, {
      cartId: cart.id,
      storeId,
      productId,
      qty,
    });
  });

  return loadCart(pool, sessionId);
}

export async function removeCartItem({ sessionId, productId }) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, store_id FROM carts WHERE session_id = $1 FOR UPDATE",
      [sessionId],
    );
    const cart = rows[0];
    if (!cart) return;

    await applyLineChange(client, {
      cartId: cart.id,
      storeId: cart.store_id,
      productId,
      qty: 0,
    });
  });

  return loadCart(pool, sessionId);
}

export async function clearCart(sessionId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id FROM carts WHERE session_id = $1 FOR UPDATE",
      [sessionId],
    );
    const cart = rows[0];
    if (!cart) return;

    // Release holds in product order to keep a stable lock order across sessions.
    const { rows: holds } = await client.query(
      `SELECT product_id, store_id, qty FROM reservations
       WHERE cart_id = $1 AND status = 'ACTIVE'
       ORDER BY product_id
       FOR UPDATE`,
      [cart.id],
    );

    for (const hold of holds) {
      const { rowCount } = await client.query(
        `UPDATE store_stock SET reserved = reserved - $1
         WHERE product_id = $2 AND store_id = $3`,
        [hold.qty, hold.product_id, hold.store_id],
      );
      if (rowCount > 0) {
        await recordInventoryChange(client, {
          productId: hold.product_id,
          storeId: hold.store_id,
          reason: "RELEASE",
        });
      }
    }

    await client.query(
      `UPDATE reservations SET status = 'EXPIRED' WHERE cart_id = $1 AND status = 'ACTIVE'`,
      [cart.id],
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cart.id]);
    await client.query("DELETE FROM carts WHERE id = $1", [cart.id]);
  });

  return emptyCart();
}
