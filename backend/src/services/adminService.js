import { pool, withTransaction } from "../db/pool.js";
import { badRequest, httpError } from "./errors.js";
import { recordInventoryChange, runAlertCheck } from "./inventoryService.js";

/**
 * Admin operations (PLAN 6, Admin).
 *
 * Reads run on the pool; restock and product edits own one transaction each.
 * No provider is called here: both writes only append to the outbox.
 */

const ALERT_STATUSES = new Set(["OPEN", "RESOLVED"]);

const PRODUCT_FIELDS = new Set([
  "name",
  "description",
  "category",
  "price",
  "image_url",
  "low_stock_threshold",
]);

const PRODUCT_COLUMNS = {
  name: "name",
  description: "description",
  category: "category",
  price: "price",
  image_url: "image_url",
  low_stock_threshold: "low_stock_threshold",
};

function requireInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest(`${name} must be an integer`);
  }
  if (value < min || value > max) {
    throw badRequest(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export async function listAlerts({ status = "OPEN" } = {}) {
  if (!ALERT_STATUSES.has(status)) {
    throw badRequest("status must be OPEN or RESOLVED");
  }

  const { rows } = await pool.query(
    `SELECT a.id, a.product_id, p.name AS product_name, a.store_id, s.city,
            a.stock_level, a.status, a.created_at
     FROM alerts a
     JOIN products p ON p.id = a.product_id
     JOIN stores s ON s.id = a.store_id
     WHERE a.status = $1
     ORDER BY a.created_at DESC, a.id DESC`,
    [status],
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      product_id: row.product_id,
      product_name: row.product_name,
      store_id: row.store_id,
      city: row.city,
      stock_level: Number(row.stock_level),
      status: row.status,
      created_at: row.created_at,
    })),
  };
}

export async function listEvents({ limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequest("limit must be an integer between 1 and 200");
  }

  const { rows } = await pool.query(
    `SELECT id, event_id, topic, key, payload, created_at, published_at
     FROM outbox
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
  );

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      event_id: row.event_id,
      topic: row.topic,
      key: row.key,
      payload: row.payload,
      created_at: row.created_at,
      published_at: row.published_at,
      published: row.published_at !== null,
    })),
  };
}

/**
 * Add stock at one (product, store) and record it as a RESTOCK inventory change in
 * the same transaction, so the outbox row and the low-stock alert check always agree
 * with the committed stock. Creates the store_stock row when it is missing.
 */
export async function restock({ productId, storeId, add }) {
  const product_id = requireInteger(productId, "product_id");
  const store_id = requireInteger(storeId, "store_id");
  const amount = requireInteger(add, "add", { min: 1, max: 10000 });

  const payload = await withTransaction(async (client) => {
    const product = await client.query("SELECT 1 FROM products WHERE id = $1", [product_id]);
    if (product.rowCount === 0) {
      throw httpError(404, "PRODUCT_NOT_FOUND", `Product ${product_id} not found`);
    }

    const store = await client.query("SELECT 1 FROM stores WHERE id = $1", [store_id]);
    if (store.rowCount === 0) {
      throw httpError(400, "INVALID_STORE", `Store ${store_id} does not exist`);
    }

    await client.query(
      `INSERT INTO store_stock (product_id, store_id, stock, reserved)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (product_id, store_id)
       DO UPDATE SET stock = store_stock.stock + EXCLUDED.stock`,
      [product_id, store_id, amount],
    );

    return recordInventoryChange(client, { productId: product_id, storeId: store_id, reason: "RESTOCK" });
  });

  return {
    product_id,
    store_id,
    city: payload.city,
    stock: payload.stock,
    reserved: payload.reserved,
    available: payload.available,
    low: payload.available <= payload.low_stock_threshold,
  };
}

function validatePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("body must be a JSON object");
  }

  const keys = Object.keys(body);
  if (keys.length === 0) throw badRequest("at least one product field is required");

  const unknown = keys.filter((key) => !PRODUCT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw badRequest(`unknown field(s): ${unknown.join(", ")}`);
  }

  const patch = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw badRequest("name must be a non-empty string");
    }
    patch.name = body.name.trim();
  }

  if ("description" in body) {
    if (typeof body.description !== "string") throw badRequest("description must be a string");
    patch.description = body.description;
  }

  if ("category" in body) {
    if (typeof body.category !== "string" || body.category.trim() === "") {
      throw badRequest("category must be a non-empty string");
    }
    patch.category = body.category.trim();
  }

  if ("price" in body) {
    const price = body.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw badRequest("price must be a number >= 0");
    }
    if (Math.abs(Math.round(price * 100) - price * 100) > 1e-9) {
      throw badRequest("price must have at most 2 decimals");
    }
    patch.price = price;
  }

  if ("image_url" in body) {
    if (body.image_url !== null && typeof body.image_url !== "string") {
      throw badRequest("image_url must be a string or null");
    }
    patch.image_url = body.image_url;
  }

  if ("low_stock_threshold" in body) {
    const threshold = body.low_stock_threshold;
    if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0) {
      throw badRequest("low_stock_threshold must be an integer >= 0");
    }
    patch.low_stock_threshold = threshold;
  }

  return patch;
}

/**
 * Edit a product in one transaction: lock the row, update it, append exactly one
 * `product.updated` outbox row (PLAN 5 payload), and re-run the alert check for every
 * store holding the product when the threshold changed.
 */
export async function updateProduct(productId, body) {
  const patch = validatePatch(body);
  const keys = Object.keys(patch);

  const row = await withTransaction(async (client) => {
    const locked = await client.query("SELECT 1 FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (locked.rowCount === 0) {
      throw httpError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
    }

    const assignments = keys
      .map((key, index) => `${PRODUCT_COLUMNS[key]} = $${index + 2}`)
      .join(", ");
    const { rows } = await client.query(
      `UPDATE products SET ${assignments} WHERE id = $1
       RETURNING id, name, description, category, price, image_url, low_stock_threshold`,
      [productId, ...keys.map((key) => patch[key])],
    );
    const product = rows[0];

    await client.query(
      `INSERT INTO outbox (topic, key, payload)
       VALUES ('product.updated', $1, $2::jsonb)`,
      [
        String(product.id),
        JSON.stringify({
          product_id: product.id,
          name: product.name,
          description: product.description,
          category: product.category,
          price: Number(product.price),
          image_url: product.image_url,
          low_stock_threshold: product.low_stock_threshold,
          updated_at: new Date().toISOString(),
        }),
      ],
    );

    if ("low_stock_threshold" in patch) {
      const { rows: stockRows } = await client.query(
        "SELECT store_id FROM store_stock WHERE product_id = $1 ORDER BY store_id",
        [productId],
      );
      for (const stock of stockRows) {
        await runAlertCheck(client, { productId, storeId: stock.store_id });
      }
    }

    return product;
  });

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: Number(row.price),
    image_url: row.image_url,
    low_stock_threshold: row.low_stock_threshold,
  };
}
