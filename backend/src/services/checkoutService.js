/**
 * Checkout + orders (PLAN 4.1).
 *
 * One transaction per checkout: idempotency check, cart lock, stock decrement
 * (consuming the shopper's own hold when it is still live), customer + order +
 * order_items, one inventory.changed row per affected (product, store) via
 * inventoryService, one order.placed row, then the cart is deleted.
 *
 * No provider is ever called here: everything goes through the outbox.
 */
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, httpError } from "./errors.js";
import { recordInventoryChange } from "./inventoryService.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULFILMENTS = new Set(["pickup", "delivery"]);
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${name} is required`);
  }
  return value.trim();
}

function validateCheckout({ customer, fulfilment, idempotencyKey }) {
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string") throw badRequest("Idempotency-Key must be a string");
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw badRequest(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    if (idempotencyKey.trim() === "") idempotencyKey = null;
  }

  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    throw badRequest("customer is required");
  }

  const name = requireText(customer.name, "customer.name");
  const email = requireText(customer.email, "customer.email").toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw badRequest("customer.email must be a valid email address");
  const phone = requireText(customer.phone, "customer.phone");

  if (!FULFILMENTS.has(fulfilment)) {
    throw badRequest("fulfilment must be pickup or delivery");
  }

  return { name, email, phone, fulfilment, idempotencyKey };
}

async function findOrderIdByKey(queryable, key) {
  const { rows } = await queryable.query("SELECT id FROM orders WHERE idempotency_key = $1", [key]);
  return rows[0]?.id ?? null;
}

async function lockCart(client, sessionId) {
  const { rows } = await client.query(
    "SELECT id, store_id FROM carts WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  return rows[0] ?? null;
}

async function loadCartItems(client, cartId) {
  const { rows } = await client.query(
    `SELECT ci.product_id, ci.qty, p.name, p.price
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id = $1
     ORDER BY ci.product_id`,
    [cartId],
  );
  return rows.map((row) => ({
    product_id: row.product_id,
    name: row.name,
    qty: Number(row.qty),
    price: Number(row.price),
  }));
}

async function availableAt(client, productId, storeId) {
  const { rows } = await client.query(
    `SELECT COALESCE(stock - reserved, 0) AS available
     FROM store_stock WHERE product_id = $1 AND store_id = $2`,
    [productId, storeId],
  );
  return Number(rows[0]?.available ?? 0);
}

/**
 * Apply the stock side of the checkout for every cart line, in product_id order.
 * Returns the failing lines (empty when everything could be taken). The caller
 * throws at the end so the transaction rolls back with every failure listed.
 */
async function takeStock(client, { cartId, storeId, items }) {
  const failures = [];

  for (const item of items) {
    const { product_id: productId, qty } = item;
    const { rows: holdRows } = await client.query(
      `SELECT id, qty, (expires_at <= now()) AS expired
       FROM reservations
       WHERE cart_id = $1 AND product_id = $2 AND status = 'ACTIVE'
       FOR UPDATE`,
      [cartId, productId],
    );
    const hold = holdRows[0] ?? null;
    let taken = false;

    // The shopper's own expired hold must never block their checkout: release it
    // first, then fall back to the direct decrement below.
    if (hold && hold.expired) {
      await client.query(
        `UPDATE store_stock SET reserved = reserved - $1
         WHERE product_id = $2 AND store_id = $3`,
        [hold.qty, productId, storeId],
      );
      await client.query("UPDATE reservations SET status = 'EXPIRED' WHERE id = $1", [hold.id]);
      await recordInventoryChange(client, { productId, storeId, reason: "EXPIRE" });
    } else if (hold) {
      const { rowCount } = await client.query(
        `UPDATE store_stock SET stock = stock - $1, reserved = reserved - $1
         WHERE product_id = $2 AND store_id = $3 AND stock >= $1 AND reserved >= $1`,
        [qty, productId, storeId],
      );
      if (rowCount > 0) {
        await client.query("UPDATE reservations SET status = 'CONSUMED' WHERE id = $1", [hold.id]);
        taken = true;
      }
    }

    if (!taken) {
      const { rowCount } = await client.query(
        `UPDATE store_stock SET stock = stock - $1
         WHERE product_id = $2 AND store_id = $3 AND stock - reserved >= $1`,
        [qty, productId, storeId],
      );
      taken = rowCount > 0;
    }

    if (!taken) {
      failures.push({
        product_id: productId,
        name: item.name,
        available: await availableAt(client, productId, storeId),
      });
    }
  }

  return failures;
}

async function upsertCustomer(client, customer) {
  const { rows } = await client.query(
    `INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE
       SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone
     RETURNING id`,
    [customer.name, customer.email, customer.phone],
  );
  return rows[0].id;
}

async function insertOrder(client, { customerId, storeId, fulfilment, total, idempotencyKey }) {
  const { rows } = await client.query(
    `INSERT INTO orders (customer_id, store_id, status, fulfilment, total, idempotency_key)
     VALUES ($1, $2, 'CONFIRMED', $3, $4, $5)
     RETURNING id`,
    [customerId, storeId, fulfilment, total, idempotencyKey],
  );
  return rows[0].id;
}

async function loadOrder(queryable, orderId) {
  const { rows } = await queryable.query(
    `SELECT o.id, o.status, o.fulfilment, o.total, o.store_id, s.city, o.created_at,
            c.name AS customer_name, c.email, c.phone
     FROM orders o
     JOIN stores s ON s.id = o.store_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order) return null;

  const { rows: itemRows } = await queryable.query(
    `SELECT oi.product_id, p.name, oi.qty, oi.price
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.product_id`,
    [orderId],
  );

  return {
    id: order.id,
    status: order.status,
    fulfilment: order.fulfilment,
    total: Number(order.total),
    store_id: order.store_id,
    city: order.city,
    created_at: new Date(order.created_at).toISOString(),
    customer: {
      name: order.customer_name,
      email: order.email,
      phone: order.phone,
    },
    items: itemRows.map((row) => ({
      product_id: row.product_id,
      name: row.name,
      qty: Number(row.qty),
      price: Number(row.price),
    })),
  };
}

export async function getOrder(orderId) {
  if (typeof orderId !== "string" || !UUID_PATTERN.test(orderId)) {
    throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  const order = await loadOrder(pool, orderId);
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return order;
}

export async function checkout({ sessionId, customer, fulfilment, idempotencyKey }) {
  const input = validateCheckout({ customer, fulfilment, idempotencyKey });
  // Scoped by session, so one shopper can never replay another shopper's key.
  const key = input.idempotencyKey ? `${sessionId}:${input.idempotencyKey}` : null;

  let orderId;
  try {
    orderId = await withTransaction(async (client) => {
      // 4.1 step 1: replaying a key returns the original order.
      if (key) {
        const existing = await findOrderIdByKey(client, key);
        if (existing) return existing;
      }

      const cart = await lockCart(client, sessionId);
      if (!cart) {
        // A concurrent request with the same key may have committed while we waited
        // on the cart lock and deleted the cart; re-read before calling it empty.
        if (key) {
          const existing = await findOrderIdByKey(client, key);
          if (existing) return existing;
        }
        throw httpError(400, "EMPTY_CART", "Cart is empty");
      }

      const items = await loadCartItems(client, cart.id);
      if (items.length === 0) throw httpError(400, "EMPTY_CART", "Cart is empty");

      const { rows: cityRows } = await client.query("SELECT city FROM stores WHERE id = $1", [
        cart.store_id,
      ]);
      const city = cityRows[0].city;

      const failures = await takeStock(client, {
        cartId: cart.id,
        storeId: cart.store_id,
        items,
      });
      if (failures.length > 0) {
        throw httpError(409, "OUT_OF_STOCK", "Some items are no longer available", {
          items: failures,
        });
      }

      const total = Number(
        items.reduce((sum, item) => sum + item.price * item.qty, 0).toFixed(2),
      );
      const customerId = await upsertCustomer(client, input);
      const newOrderId = await insertOrder(client, {
        customerId,
        storeId: cart.store_id,
        fulfilment: input.fulfilment,
        total,
        idempotencyKey: key,
      });

      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)`,
          [newOrderId, item.product_id, item.qty, item.price],
        );
      }

      // One inventory.changed row (reason ORDER) and the alert check per affected row.
      for (const item of items) {
        await recordInventoryChange(client, {
          productId: item.product_id,
          storeId: cart.store_id,
          reason: "ORDER",
        });
      }

      await client.query(
        `INSERT INTO outbox (topic, key, payload)
         VALUES ('order.placed', $1, $2::jsonb)`,
        [
          newOrderId,
          JSON.stringify({
            order_id: newOrderId,
            store_id: cart.store_id,
            city,
            fulfilment: input.fulfilment,
            total,
            customer: { name: input.name, email: input.email, phone: input.phone },
            items: items.map((item) => ({
              product_id: item.product_id,
              name: item.name,
              qty: item.qty,
              price: item.price,
            })),
            placed_at: new Date().toISOString(),
          }),
        ],
      );

      // Cascades to cart_items and the cart's reservations.
      await client.query("DELETE FROM carts WHERE id = $1", [cart.id]);
      return newOrderId;
    });
  } catch (err) {
    // Two concurrent requests can slip past the first key check; the loser gets a
    // unique violation on the key and must return the winner's order, not a 500.
    if (key && err?.code === "23505") {
      const existing = await findOrderIdByKey(pool, key);
      if (existing) return loadOrder(pool, existing);
    }
    throw err;
  }

  const order = await loadOrder(pool, orderId);
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return order;
}
