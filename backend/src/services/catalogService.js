import { pool } from "../db/pool.js";
import { httpError } from "./errors.js";

/**
 * Catalog reads (stores, categories, browse, product detail).
 * Every product row is returned in the browse shape:
 *   { id, name, description, category, price, image_url, available, low }
 * `available` is stock - reserved for the requested store, or the total across
 * all stores when no store is given. `low` is only meaningful per store.
 */

export function toProductItem(row, { perStore }) {
  const available = Number(row.available);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: Number(row.price),
    image_url: row.image_url,
    available,
    low: perStore ? available <= row.low_stock_threshold : false,
  };
}

export async function listStores() {
  const { rows } = await pool.query("SELECT id, name, city FROM stores ORDER BY id");
  return rows;
}

export async function listCategories() {
  const { rows } = await pool.query("SELECT DISTINCT category FROM products ORDER BY category");
  return rows.map((row) => row.category);
}

async function assertStoreExists(storeId) {
  if (storeId === null || storeId === undefined) return;
  const { rowCount } = await pool.query("SELECT 1 FROM stores WHERE id = $1", [storeId]);
  if (rowCount === 0) throw httpError(400, "INVALID_STORE", `Store ${storeId} does not exist`);
}

export async function listProducts({ storeId = null, category = null, minPrice = 0, maxPrice = 1_000_000, limit = 20, offset = 0 }) {
  await assertStoreExists(storeId);

  const filters = `WHERE ($1::text IS NULL OR p.category = $1)
                     AND p.price >= $2 AND p.price <= $3`;
  const filterValues = [category, minPrice, maxPrice];

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS total FROM products p ${filters}`,
    filterValues,
  );
  const total = countRows[0].total;

  if (storeId === null) {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
              COALESCE((SELECT SUM(ss.stock - ss.reserved) FROM store_stock ss WHERE ss.product_id = p.id), 0) AS available
       FROM products p
       ${filters}
       ORDER BY (COALESCE((SELECT SUM(ss.stock - ss.reserved) FROM store_stock ss WHERE ss.product_id = p.id), 0) > 0) DESC,
                p.id ASC
       LIMIT $4 OFFSET $5`,
      [...filterValues, limit, offset],
    );
    return {
      items: rows.map((row) => toProductItem(row, { perStore: false })),
      total,
      limit,
      offset,
    };
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
            COALESCE(ss.stock - ss.reserved, 0) AS available
     FROM products p
     LEFT JOIN store_stock ss ON ss.product_id = p.id AND ss.store_id = $4
     ${filters}
     ORDER BY (COALESCE(ss.stock - ss.reserved, 0) > 0) DESC, p.id ASC
     LIMIT $5 OFFSET $6`,
    [...filterValues, storeId, limit, offset],
  );
  return {
    items: rows.map((row) => toProductItem(row, { perStore: true })),
    total,
    limit,
    offset,
  };
}

export async function getProduct(productId, { storeId = null } = {}) {
  await assertStoreExists(storeId);

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
            ${
              storeId === null
                ? "COALESCE((SELECT SUM(ss.stock - ss.reserved) FROM store_stock ss WHERE ss.product_id = p.id), 0) AS available"
                : "COALESCE(ss.stock - ss.reserved, 0) AS available"
            }
     FROM products p
     ${
       storeId === null
         ? ""
         : "LEFT JOIN store_stock ss ON ss.product_id = p.id AND ss.store_id = $2"
     }
     WHERE p.id = $1`,
    storeId === null ? [productId] : [productId, storeId],
  );

  const product = rows[0];
  if (!product) throw httpError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);

  const { rows: availabilityRows } = await pool.query(
    `SELECT s.id AS store_id, s.city, COALESCE(ss.stock - ss.reserved, 0) AS available
     FROM stores s
     LEFT JOIN store_stock ss ON ss.store_id = s.id AND ss.product_id = $1
     ORDER BY s.id`,
    [productId],
  );

  return {
    ...toProductItem(product, { perStore: storeId !== null }),
    availability: availabilityRows.map((row) => ({
      store_id: row.store_id,
      city: row.city,
      available: Number(row.available),
    })),
  };
}
