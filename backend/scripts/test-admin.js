/**
 * Admin endpoint checks (PLAN 6, Admin).
 *
 * Talks to the running API and to the database through pool.js. Uses the real ADMIN_KEY
 * from config, sets up its own stock/alert rows, and restores everything afterwards.
 * Run with the API up: `npm run test:admin`. Exit code 1 if anything fails.
 */
import config from "../src/config.js";
import { pool } from "../src/db/pool.js";

if (config.databaseSsl) {
  console.error("Refusing to run test:admin with DATABASE_SSL=true — this script resets stock rows.");
  process.exit(1);
}

if (!config.adminKey) {
  console.error("ADMIN_KEY is empty; every admin request is rejected, so test:admin cannot run.");
  process.exit(1);
}

const API = process.env.API_URL ?? `http://localhost:${config.port}`;
const ADMIN_KEY = config.adminKey;
const WRONG_KEY = "definitely-not-the-admin-key";
const failures = [];
const sessions = [];

let target; // { productId, storeId, city, threshold, productName }
let patchProduct; // { id, storeId, original }

function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

function section(title) {
  console.log(`\n=== ${title}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, everyMs = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

function session() {
  const id = `test-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sessions.push(id);
  return id;
}

async function api(method, path, { sessionId, adminKey, body } = {}) {
  const headers = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  if (adminKey !== undefined) headers["X-Admin-Key"] = adminKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function errorCode(res) {
  return res.body?.error?.code ?? null;
}

function codeDetail(res) {
  return res.body?.error ? `${res.status} ${res.body.error.code}` : `${res.status}`;
}

function admin(method, path, body) {
  return api(method, path, { adminKey: ADMIN_KEY, body });
}

function putItem(sessionId, productId, storeId, qty) {
  return api("PUT", "/api/cart/items", {
    sessionId,
    body: { product_id: productId, qty, store_id: storeId },
  });
}

// ---------------------------------------------------------------- db helpers

async function rowOf(productId, storeId) {
  const { rows } = await pool.query(
    "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
    [productId, storeId],
  );
  if (!rows[0]) return null;
  return { stock: Number(rows[0].stock), reserved: Number(rows[0].reserved) };
}

async function setRow(productId, storeId, stock) {
  await pool.query(
    "UPDATE store_stock SET stock = $1, reserved = 0 WHERE product_id = $2 AND store_id = $3",
    [stock, productId, storeId],
  );
}

async function openAlert(productId, storeId) {
  const { rows } = await pool.query(
    `SELECT id, stock_level FROM alerts
     WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN' LIMIT 1`,
    [productId, storeId],
  );
  return rows[0] ? { id: rows[0].id, stockLevel: Number(rows[0].stock_level) } : null;
}

async function alertById(id) {
  const { rows } = await pool.query("SELECT status FROM alerts WHERE id = $1", [id]);
  return rows[0]?.status ?? null;
}

/**
 * Set the row's stock, resolve any existing OPEN alert for the pair and open a fresh
 * one. Returns the new alert id (used to check it resolves).
 */
async function setupOpenAlert(productId, storeId, stock) {
  await setRow(productId, storeId, stock);
  await pool.query(
    `UPDATE alerts SET status = 'RESOLVED'
     WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'`,
    [productId, storeId],
  );
  const { rows } = await pool.query(
    `INSERT INTO alerts (product_id, store_id, stock_level, status)
     VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
    [productId, storeId, stock],
  );
  return rows[0].id;
}

async function snapshotAlerts(productId, storeId = null) {
  const { rows } = await pool.query(
    `SELECT id, store_id, stock_level, status FROM alerts
     WHERE product_id = $1 ${storeId === null ? "" : "AND store_id = $2"}
     ORDER BY id`,
    storeId === null ? [productId] : [productId, storeId],
  );
  return {
    rows: rows.map((row) => ({
      id: row.id,
      stockLevel: Number(row.stock_level),
      status: row.status,
    })),
    maxId: rows.length ? Math.max(...rows.map((row) => row.id)) : 0,
  };
}

async function restoreAlerts(productId, snapshot, storeId = null) {
  await pool.query(
    `DELETE FROM alerts
     WHERE product_id = $1 AND id > $2 ${storeId === null ? "" : "AND store_id = $3"}`,
    storeId === null ? [productId, snapshot.maxId] : [productId, snapshot.maxId, storeId],
  );
  // Resolve everything first, then reopen, so the partial unique index is never violated.
  await pool.query(
    `UPDATE alerts SET status = 'RESOLVED'
     WHERE product_id = $1 ${storeId === null ? "" : "AND store_id = $2"}`,
    storeId === null ? [productId] : [productId, storeId],
  );
  for (const row of snapshot.rows) {
    await pool.query("UPDATE alerts SET status = $1, stock_level = $2 WHERE id = $3", [
      row.status,
      row.stockLevel,
      row.id,
    ]);
  }
}

async function maxOutboxId() {
  const { rows } = await pool.query("SELECT COALESCE(max(id), 0) AS id FROM outbox");
  return Number(rows[0].id);
}

async function outboxSince(id) {
  const { rows } = await pool.query(
    `SELECT id, topic, key, payload, published_at FROM outbox WHERE id > $1 ORDER BY id`,
    [id],
  );
  return rows;
}

async function activeQty(productId, storeId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(qty), 0)::int AS qty FROM reservations
     WHERE product_id = $1 AND store_id = $2 AND status = 'ACTIVE'`,
    [productId, storeId],
  );
  return Number(rows[0].qty);
}

// ------------------------------------------------------------------- checks

async function test1Auth() {
  section("Test 1: every admin endpoint rejects a missing or wrong key");

  const requests = [
    ["GET alerts", "GET", "/api/admin/alerts"],
    ["GET events", "GET", "/api/admin/events"],
    ["POST stock", "POST", "/api/admin/stock", { product_id: target.productId, store_id: target.storeId, add: 1 }],
    ["PATCH product", "PATCH", `/api/admin/products/${target.productId}`, { name: "Should Not Apply" }],
  ];

  for (const [label, method, path, body] of requests) {
    const none = await api(method, path, { body });
    check(
      `${label} with no key -> 401 UNAUTHORIZED`,
      none.status === 401 && errorCode(none) === "UNAUTHORIZED",
      codeDetail(none),
    );

    const wrong = await api(method, path, { adminKey: WRONG_KEY, body });
    check(
      `${label} with a wrong key -> 401 UNAUTHORIZED`,
      wrong.status === 401 && errorCode(wrong) === "UNAUTHORIZED",
      codeDetail(wrong),
    );
  }
}

async function test2Alerts() {
  section("Test 2: alert listing defaults to OPEN and carries product/city names");
  const alertId = await setupOpenAlert(target.productId, target.storeId, target.threshold);

  const defaultRes = await admin("GET", "/api/admin/alerts");
  check("GET /api/admin/alerts returns 200", defaultRes.status === 200, codeDetail(defaultRes));
  const items = defaultRes.body?.items ?? [];
  const ours = items.find((item) => item.id === alertId);
  check("the OPEN alert is listed by default", Boolean(ours), `alertId=${alertId}`);
  if (ours) {
    check(
      "the item carries product_name and city",
      ours.product_name === target.productName && ours.city === target.city,
      JSON.stringify(ours),
    );
    check(
      "the item has id, product_id, store_id, stock_level and status",
      ours.product_id === target.productId &&
        ours.store_id === target.storeId &&
        ours.stock_level === target.threshold &&
        ours.status === "OPEN",
      JSON.stringify(ours),
    );
  }
  check(
    "all default items are OPEN",
    items.every((item) => item.status === "OPEN"),
    `statuses=${[...new Set(items.map((item) => item.status))].join(",")}`,
  );

  await pool.query("UPDATE alerts SET status = 'RESOLVED' WHERE id = $1", [alertId]);
  const resolved = await admin("GET", "/api/admin/alerts?status=RESOLVED");
  check(
    "status=RESOLVED returns the resolved alert",
    resolved.status === 200 && (resolved.body?.items ?? []).some((item) => item.id === alertId),
    codeDetail(resolved),
  );

  const bad = await admin("GET", "/api/admin/alerts?status=BOGUS");
  check(
    "a bad status returns 400 BAD_REQUEST",
    bad.status === 400 && errorCode(bad) === "BAD_REQUEST",
    codeDetail(bad),
  );
}

async function test3Restock() {
  section("Test 3: restock raises stock, writes a RESTOCK outbox row, resolves the alert");
  const alertId = await setupOpenAlert(target.productId, target.storeId, target.threshold);
  const startingStock = target.threshold;
  const before = await maxOutboxId();

  const res = await admin("POST", "/api/admin/stock", {
    product_id: target.productId,
    store_id: target.storeId,
    add: 10,
  });
  check("restock returns 200", res.status === 200, codeDetail(res));
  check(
    "response carries product_id, store_id, city, stock, reserved, available, low",
    res.body?.product_id === target.productId &&
      res.body?.store_id === target.storeId &&
      res.body?.city === target.city &&
      res.body?.stock === startingStock + 10 &&
      res.body?.reserved === 0 &&
      res.body?.available === startingStock + 10 &&
      res.body?.low === false,
    JSON.stringify(res.body),
  );

  const dbRow = await rowOf(target.productId, target.storeId);
  check(
    "the store_stock row holds the new stock",
    dbRow?.stock === startingStock + 10 && dbRow?.reserved === 0,
    JSON.stringify(dbRow),
  );

  const rows = (await outboxSince(before)).filter(
    (row) => row.topic === "inventory.changed" && row.key === `${target.productId}:${target.storeId}`,
  );
  check("exactly one inventory.changed row was written", rows.length === 1, `${rows.length} rows`);
  if (rows.length === 1) {
    check(
      "the event reason is RESTOCK with the new levels",
      rows[0].payload.reason === "RESTOCK" &&
        rows[0].payload.stock === startingStock + 10 &&
        rows[0].payload.available === startingStock + 10 &&
        rows[0].payload.city === target.city,
      JSON.stringify(rows[0].payload),
    );
  }

  check("the open alert is no longer OPEN", (await openAlert(target.productId, target.storeId)) === null);
  check("the alert row is RESOLVED", (await alertById(alertId)) === "RESOLVED", await alertById(alertId));

  const beforeBad = await maxOutboxId();
  const badValues = [["0", 0], ["-1", -1], ["1.5", 1.5], ['"5"', "5"], ["true", true]];
  for (const [label, add] of badValues) {
    const bad = await admin("POST", "/api/admin/stock", {
      product_id: target.productId,
      store_id: target.storeId,
      add,
    });
    check(
      `add=${label} -> 400 BAD_REQUEST`,
      bad.status === 400 && errorCode(bad) === "BAD_REQUEST",
      codeDetail(bad),
    );
  }
  check(
    "rejected restocks wrote no outbox rows",
    (await outboxSince(beforeBad)).length === 0,
    `${(await outboxSince(beforeBad)).length} rows`,
  );

  const unknownProduct = await admin("POST", "/api/admin/stock", {
    product_id: 999999999,
    store_id: target.storeId,
    add: 1,
  });
  check(
    "an unknown product -> 404 PRODUCT_NOT_FOUND",
    unknownProduct.status === 404 && errorCode(unknownProduct) === "PRODUCT_NOT_FOUND",
    codeDetail(unknownProduct),
  );

  const unknownStore = await admin("POST", "/api/admin/stock", {
    product_id: target.productId,
    store_id: 999999999,
    add: 1,
  });
  check(
    "an unknown store -> 400 INVALID_STORE",
    unknownStore.status === 400 && errorCode(unknownStore) === "INVALID_STORE",
    codeDetail(unknownStore),
  );
}

async function test4RestockRace() {
  section("Test 4: restock racing a cart reservation keeps the stock invariants");
  await setRow(target.productId, target.storeId, 5);
  const s = session();

  const [put, restockRes] = await Promise.all([
    putItem(s, target.productId, target.storeId, 2),
    admin("POST", "/api/admin/stock", {
      product_id: target.productId,
      store_id: target.storeId,
      add: 3,
    }),
  ]);

  check("the reservation succeeded", put.status === 200, codeDetail(put));
  check("the restock succeeded", restockRes.status === 200, codeDetail(restockRes));

  const row = await rowOf(target.productId, target.storeId);
  const active = await activeQty(target.productId, target.storeId);
  check(
    "stock is 8 and reserved is 2",
    row?.stock === 8 && row?.reserved === 2,
    JSON.stringify(row),
  );
  check(
    "invariant 0 <= reserved <= stock",
    row && row.reserved >= 0 && row.reserved <= row.stock,
    JSON.stringify(row),
  );
  check(
    "invariant reserved = SUM(ACTIVE reservation qty)",
    row?.reserved === active,
    `reserved=${row?.reserved} active=${active}`,
  );

  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test5Patch() {
  section("Test 5: PATCH edits fields and writes exactly one product.updated event");
  const baseline = patchProduct.original;
  const before = await maxOutboxId();
  const newName = `${baseline.name} (admin)`;
  const newDescription = "Edited by test:admin";

  const res = await admin("PATCH", `/api/admin/products/${patchProduct.id}`, {
    name: newName,
    description: newDescription,
    category: "Test Category",
    price: 12.34,
    image_url: null,
  });
  check("PATCH returns 200", res.status === 200, codeDetail(res));
  check(
    "the response is the updated product with a numeric price",
    res.body?.id === patchProduct.id &&
      res.body?.name === newName &&
      res.body?.description === newDescription &&
      res.body?.category === "Test Category" &&
      res.body?.price === 12.34 &&
      res.body?.image_url === null &&
      typeof res.body?.price === "number",
    JSON.stringify(res.body),
  );

  const { rows: productRows } = await pool.query(
    "SELECT name, description, category, price, image_url, low_stock_threshold FROM products WHERE id = $1",
    [patchProduct.id],
  );
  const stored = productRows[0];
  check(
    "the product row is updated",
    stored.name === newName &&
      stored.description === newDescription &&
      stored.category === "Test Category" &&
      Number(stored.price) === 12.34 &&
      stored.image_url === null,
    JSON.stringify(stored),
  );

  const rows = (await outboxSince(before)).filter(
    (row) => row.topic === "product.updated" && row.key === String(patchProduct.id),
  );
  check("exactly one product.updated row was written", rows.length === 1, `${rows.length} rows`);
  if (rows.length === 1) {
    const payload = rows[0].payload;
    const fields = [
      "product_id",
      "name",
      "description",
      "category",
      "price",
      "image_url",
      "low_stock_threshold",
      "updated_at",
    ];
    check(
      "the payload matches section 5",
      fields.every((field) => field in payload) &&
        Object.keys(payload).sort().join(",") === [...fields].sort().join(",") &&
        payload.product_id === patchProduct.id &&
        payload.name === newName &&
        payload.category === "Test Category" &&
        payload.price === 12.34 &&
        payload.image_url === null &&
        payload.low_stock_threshold === baseline.low_stock_threshold &&
        typeof payload.updated_at === "string",
      JSON.stringify(payload),
    );
  }

  const invalid = [
    ["empty body", {}],
    ["unknown field", { colour: "red" }],
    ["negative price", { price: -1 }],
    ["price with 3 decimals", { price: 1.239 }],
    ["non-integer threshold", { low_stock_threshold: 1.5 }],
    ["negative threshold", { low_stock_threshold: -1 }],
    ["empty name", { name: "   " }],
    ["non-string category", { category: 5 }],
    ["non-string image_url", { image_url: 42 }],
  ];
  for (const [label, body] of invalid) {
    const bad = await admin("PATCH", `/api/admin/products/${patchProduct.id}`, body);
    check(
      `${label} -> 400 BAD_REQUEST`,
      bad.status === 400 && errorCode(bad) === "BAD_REQUEST",
      codeDetail(bad),
    );
  }

  const unknown = await admin("PATCH", "/api/admin/products/999999999", { name: "Nope" });
  check(
    "an unknown id -> 404 PRODUCT_NOT_FOUND",
    unknown.status === 404 && errorCode(unknown) === "PRODUCT_NOT_FOUND",
    codeDetail(unknown),
  );

  check(
    "no rejected PATCH wrote an outbox row",
    (await outboxSince(before)).filter((row) => row.topic === "product.updated").length === 1,
    `${(await outboxSince(before)).filter((row) => row.topic === "product.updated").length} rows`,
  );
  check(
    "no rejected PATCH changed the product",
    (await pool.query("SELECT name FROM products WHERE id = $1", [patchProduct.id])).rows[0].name === newName,
  );
}

async function test6ThresholdAlerts() {
  section("Test 6: PATCH low_stock_threshold up opens an alert, down resolves it");
  await setRow(patchProduct.id, patchProduct.storeId, 5);

  const low = await admin("PATCH", `/api/admin/products/${patchProduct.id}`, {
    low_stock_threshold: 0,
  });
  check("threshold 0 is accepted", low.status === 200 && low.body?.low_stock_threshold === 0, codeDetail(low));
  check("no OPEN alert at threshold 0", (await openAlert(patchProduct.id, patchProduct.storeId)) === null);

  const up = await admin("PATCH", `/api/admin/products/${patchProduct.id}`, {
    low_stock_threshold: 10,
  });
  const opened = await openAlert(patchProduct.id, patchProduct.storeId);
  check("threshold 10 is accepted", up.status === 200 && up.body?.low_stock_threshold === 10, codeDetail(up));
  check(
    "an OPEN alert appears with stock_level 5",
    opened !== null && opened.stockLevel === 5,
    JSON.stringify(opened),
  );

  const down = await admin("PATCH", `/api/admin/products/${patchProduct.id}`, {
    low_stock_threshold: 1,
  });
  check("threshold 1 is accepted", down.status === 200, codeDetail(down));
  check("the alert is resolved when the threshold drops", (await openAlert(patchProduct.id, patchProduct.storeId)) === null);
  if (opened) {
    check("the alert row is RESOLVED", (await alertById(opened.id)) === "RESOLVED", await alertById(opened.id));
  }
}

async function test7Events() {
  section("Test 7: the event feed is newest first, respects limit and reports published state");
  const top = await admin("GET", "/api/admin/events?limit=5");
  check("GET /api/admin/events returns 200", top.status === 200, codeDetail(top));
  const items = top.body?.items ?? [];
  check("limit=5 returns 5 rows", items.length === 5, `${items.length} rows`);
  check(
    "ids are strictly descending (newest first)",
    items.every((item, index) => index === 0 || item.id < items[index - 1].id),
    items.map((item) => item.id).join(","),
  );
  check(
    "each row carries the event shape and a boolean published",
    items.every(
      (item) =>
        "event_id" in item &&
        "topic" in item &&
        "key" in item &&
        "payload" in item &&
        "created_at" in item &&
        "published_at" in item &&
        typeof item.published === "boolean" &&
        item.published === (item.published_at !== null),
    ),
    JSON.stringify(items[0]),
  );

  const three = await admin("GET", "/api/admin/events?limit=3");
  check("limit=3 returns 3 rows", three.body?.items?.length === 3, `${three.body?.items?.length} rows`);

  for (const limit of [0, 201]) {
    const bad = await admin("GET", `/api/admin/events?limit=${limit}`);
    check(
      `limit=${limit} -> 400 BAD_REQUEST`,
      bad.status === 400 && errorCode(bad) === "BAD_REQUEST",
      codeDetail(bad),
    );
  }

  // A restock event must be marked published by the Step 7 relay within ~5s.
  await setRow(target.productId, target.storeId, 5);
  const before = await maxOutboxId();
  const restock = await admin("POST", "/api/admin/stock", {
    product_id: target.productId,
    store_id: target.storeId,
    add: 1,
  });
  check("set up: restock succeeded", restock.status === 200, codeDetail(restock));

  const eventRow = (await outboxSince(before)).find(
    (row) => row.topic === "inventory.changed" && row.key === `${target.productId}:${target.storeId}`,
  );
  check("set up: the RESTOCK outbox row exists", Boolean(eventRow));
  if (!eventRow) return;

  const started = Date.now();
  const published = await waitFor(async () => {
    const res = await admin("GET", "/api/admin/events?limit=200");
    const item = (res.body?.items ?? []).find((candidate) => candidate.id === Number(eventRow.id));
    return item?.published === true ? item : null;
  }, 5000, 200);

  check(
    "the event is reported published within ~5s",
    Boolean(published),
    published ? `${Date.now() - started}ms` : `not published after ${Date.now() - started}ms`,
  );
  if (published) {
    check(
      "the published event is the RESTOCK inventory.changed row",
      published.topic === "inventory.changed" && published.payload.reason === "RESTOCK",
      JSON.stringify({ topic: published.topic, reason: published.payload.reason }),
    );
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`No API at ${API}. Start it with \`npm run dev\` first.`);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const targetRow = await pool.query(
    `SELECT ss.product_id, ss.store_id, s.city, p.name, p.low_stock_threshold
     FROM store_stock ss
     JOIN stores s ON s.id = ss.store_id
     JOIN products p ON p.id = ss.product_id
     ORDER BY ss.store_id, ss.product_id
     LIMIT 1`,
  );
  target = {
    productId: targetRow.rows[0].product_id,
    storeId: targetRow.rows[0].store_id,
    city: targetRow.rows[0].city,
    productName: targetRow.rows[0].name,
    threshold: Number(targetRow.rows[0].low_stock_threshold),
  };

  const patchRow = await pool.query(
    `SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
            (SELECT min(ss.store_id) FROM store_stock ss WHERE ss.product_id = p.id) AS store_id
     FROM products p
     WHERE p.id <> $1
       AND EXISTS (SELECT 1 FROM store_stock ss WHERE ss.product_id = p.id)
     ORDER BY p.id
     LIMIT 1`,
    [target.productId],
  );
  const patchRowData = patchRow.rows[0];
  if (!patchRowData) {
    console.error("Seed data has no second product with stock; cannot run test:admin.");
    await pool.end();
    process.exitCode = 1;
    return;
  }
  patchProduct = {
    id: patchRowData.id,
    storeId: patchRowData.store_id,
    original: {
      name: patchRowData.name,
      description: patchRowData.description,
      category: patchRowData.category,
      price: Number(patchRowData.price),
      image_url: patchRowData.image_url,
      low_stock_threshold: Number(patchRowData.low_stock_threshold),
    },
  };

  // Everything this script mutates, snapshotted for restoration.
  const targetOriginal = await rowOf(target.productId, target.storeId);
  const patchOriginalRow = await rowOf(patchProduct.id, patchProduct.storeId);
  const targetAlerts = await snapshotAlerts(target.productId, target.storeId);
  const patchAlerts = await snapshotAlerts(patchProduct.id);

  console.log(
    `Testing product ${target.productId} at store ${target.storeId} (${target.city}) ` +
      `and product ${patchProduct.id} at store ${patchProduct.storeId} via ${API}`,
  );

  try {
    await test1Auth();
    await test2Alerts();
    await test3Restock();
    await test4RestockRace();
    await test5Patch();
    await test6ThresholdAlerts();
    await test7Events();
  } finally {
    for (const s of sessions) {
      await api("DELETE", "/api/cart", { sessionId: s }).catch(() => {});
    }
    await pool.query("DELETE FROM carts WHERE session_id = ANY($1)", [sessions]);

    await pool.query(
      "UPDATE store_stock SET stock = $1, reserved = $2 WHERE product_id = $3 AND store_id = $4",
      [targetOriginal.stock, targetOriginal.reserved, target.productId, target.storeId],
    );
    await pool.query(
      "UPDATE store_stock SET stock = $1, reserved = $2 WHERE product_id = $3 AND store_id = $4",
      [patchOriginalRow.stock, patchOriginalRow.reserved, patchProduct.id, patchProduct.storeId],
    );
    await pool.query(
      `UPDATE products SET name = $1, description = $2, category = $3, price = $4, image_url = $5,
              low_stock_threshold = $6
       WHERE id = $7`,
      [
        patchProduct.original.name,
        patchProduct.original.description,
        patchProduct.original.category,
        patchProduct.original.price,
        patchProduct.original.image_url,
        patchProduct.original.low_stock_threshold,
        patchProduct.id,
      ],
    );
    await restoreAlerts(target.productId, targetAlerts, target.storeId);
    await restoreAlerts(patchProduct.id, patchAlerts);

    await pool.end();
  }

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`}`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  FAILED: ${name}`);
    process.exitCode = 1;
  }
}

// No process.exit() after pool.end(): on Windows that can trip a libuv teardown assert.
main().catch(async (err) => {
  console.error("test:admin crashed:", err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
