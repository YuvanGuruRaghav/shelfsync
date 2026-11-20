import { readFile } from "node:fs/promises";

import config from "../config.js";

/**
 * Dev seed: 5 stores in 5 cities, 40 products across 5 categories,
 * varied per-store stock (a few deliberately low so alerts fire).
 *
 * Products come from catalog.json, generated once by `npm run images:fetch`.
 */

const stores = [
  { name: "ShelfSync Koramangala", city: "Bengaluru" },
  { name: "ShelfSync Andheri", city: "Mumbai" },
  { name: "ShelfSync Connaught Place", city: "Delhi" },
  { name: "ShelfSync T. Nagar", city: "Chennai" },
  { name: "ShelfSync Banjara Hills", city: "Hyderabad" },
];

// The catalog is generated once by `npm run images:fetch` (see scripts/fetch-images.js).
const catalogFile = new URL("./catalog.json", import.meta.url);

async function loadCatalog() {
  let raw;
  try {
    raw = await readFile(catalogFile, "utf8");
  } catch {
    console.error(
      "Cannot seed: backend/src/db/catalog.json is missing.\n" +
        "Generate it and the product photos once from the backend folder: npm run images:fetch",
    );
    process.exit(1);
  }

  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (err) {
    console.error(`Cannot seed: backend/src/db/catalog.json is not valid JSON (${err.message}).`);
    process.exit(1);
  }
  if (!Array.isArray(catalog) || catalog.length === 0) {
    console.error("Cannot seed: backend/src/db/catalog.json must be a non-empty array.");
    process.exit(1);
  }
  return catalog;
}

/** Stable, filesystem-safe key for a product; also the photo file name. */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Deterministic pseudo-random stock so the seed is reproducible.
function stockFor(productIndex, storeIndex) {
  const hash = (productIndex * 7 + storeIndex * 13 + 3) % 17;
  if (hash < 2) return 0; // out of stock in this city
  if (hash < 5) return hash; // low
  return hash * 3;
}

const force = process.argv.includes("--force");

function guardDestructiveSeed() {
  if (force) return;
  const reasons = [];
  if (config.databaseSsl) reasons.push("DATABASE_SSL=true");
  if (config.nodeEnv === "production") reasons.push("NODE_ENV=production");
  if (reasons.length === 0) return;

  console.error(
    `Refusing to seed: this script TRUNCATEs all tables (destructive) and ${reasons.join(" and ")}.\n` +
      "Re-run with --force if you really mean to wipe this database: npm run seed -- --force",
  );
  process.exit(1);
}

export async function seed() {
  guardDestructiveSeed();
  // Imported lazily so `products`/`slugify` can be imported by the image script without a DB.
  const { pool, withTransaction } = await import("./pool.js");
  const { migrate } = await import("./migrate.js");
  const catalog = await loadCatalog();
  await migrate();

  await withTransaction(async (client) => {
    await client.query(
      "TRUNCATE alerts, processed_events, outbox, order_items, orders, reservations, cart_items, carts, customers, store_stock, products, stores RESTART IDENTITY CASCADE",
    );

    const storeIds = [];
    for (const store of stores) {
      const { rows } = await client.query(
        "INSERT INTO stores (name, city) VALUES ($1, $2) RETURNING id",
        [store.name, store.city],
      );
      storeIds.push(rows[0].id);
    }

    let seedId = 0;
    for (const { name, description, category, price, image_url, low_stock_threshold } of catalog) {
      // The catalog order is the product id, so ids stay stable between seeds.
      seedId += 1;
      const { rows } = await client.query(
        `INSERT INTO products (id, name, description, category, price, image_url, low_stock_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           category = EXCLUDED.category,
           price = EXCLUDED.price,
           image_url = EXCLUDED.image_url,
           low_stock_threshold = EXCLUDED.low_stock_threshold
         RETURNING id`,
        [seedId, name, description, category, price, image_url ?? null, low_stock_threshold],
      );
      const productId = rows[0].id;
      for (let s = 0; s < storeIds.length; s += 1) {
        await client.query(
          "INSERT INTO store_stock (product_id, store_id, stock, reserved) VALUES ($1, $2, $3, 0)",
          [productId, storeIds[s], stockFor(productId, s)],
        );
      }
    }

    // Ids are inserted explicitly above; keep the serial sequence ahead of them.
    await client.query(
      "SELECT setval(pg_get_serial_sequence('products', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM products), 1))",
    );

    // Open an alert for every row already at or below its low-stock threshold.
    // The partial unique index on OPEN alerts makes this safe on a re-run.
    await client.query(
      `INSERT INTO alerts (product_id, store_id, stock_level, status)
       SELECT ss.product_id, ss.store_id, ss.stock - ss.reserved, 'OPEN'
       FROM store_stock ss
       JOIN products p ON p.id = ss.product_id
       WHERE ss.stock - ss.reserved <= p.low_stock_threshold
       ON CONFLICT DO NOTHING`,
    );
  });

  const { rows } = await pool.query(
    "SELECT (SELECT count(*) FROM stores) AS stores, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM store_stock) AS stock_rows, (SELECT count(*) FROM alerts WHERE status = 'OPEN') AS open_alerts",
  );
  console.log(
    `Seeded ${rows[0].stores} stores, ${rows[0].products} products, ${rows[0].stock_rows} stock rows, ${rows[0].open_alerts} open alerts.`,
  );
}

// Run only when this file is the entry point, so `slugify` can be imported safely.
if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  const { pool } = await import("./pool.js");
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      pool.end();
      process.exit(1);
    });
}
