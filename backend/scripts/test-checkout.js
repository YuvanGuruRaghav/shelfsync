/**
 * Checkout + orders checks (PLAN 4.1, 4.3, 5, 6).
 *
 * Talks to the running API and to the database through pool.js. Sets up its own
 * inventory rows, uses fresh session ids and restores everything afterwards.
 * Run with the API up: `npm run test:checkout`. Exit code 1 if anything fails.
 */
import config from "../src/config.js";
import { pool } from "../src/db/pool.js";

if (config.databaseSsl) {
  console.error("Refusing to run test:checkout with DATABASE_SSL=true — this script resets stock rows.");
  process.exit(1);
}

const API = process.env.API_URL ?? `http://localhost:${config.port}`;
const failures = [];
const sessions = [];
const checkoutEmails = [];
const TEST_EMAIL_LIKE = "test-checkout-%@example.com";

let target;
let second;
let storeCity;
let price;

function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

function section(title) {
  console.log(`\n=== ${title}`);
}

function session() {
  const id = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sessions.push(id);
  return id;
}

let emailCounter = 0;
function email() {
  emailCounter += 1;
  const value = `test-checkout-${Date.now().toString(36)}-${emailCounter}@example.com`;
  checkoutEmails.push(value);
  return value;
}

async function api(method, path, { sessionId, body, idempotencyKey } = {}) {
  const headers = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
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

function addItem(sessionId, productId, qty) {
  return api("PUT", "/api/cart/items", {
    sessionId,
    body: { product_id: productId, qty, store_id: target.storeId },
  });
}

function checkout(sessionId, { key, fulfilment = "pickup", customer } = {}) {
  return api("POST", "/api/checkout", {
    sessionId,
    idempotencyKey: key,
    body: {
      customer: customer ?? {
        name: "Test Shopper",
        email: email(),
        phone: "+919000000000",
      },
      fulfilment,
    },
  });
}

// ---------------------------------------------------------------- db helpers

function rowMeta(productId) {
  return target.productId === productId ? target : second;
}

async function resetRow(productId, stock) {
  await pool.query(
    "UPDATE store_stock SET stock = $1, reserved = 0 WHERE product_id = $2 AND store_id = $3",
    [stock, productId, target.storeId],
  );
  await pool.query(
    "DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'",
    [productId, target.storeId],
  );
}

async function setStockOnly(productId, stock) {
  await pool.query(
    "UPDATE store_stock SET stock = $1 WHERE product_id = $2 AND store_id = $3",
    [stock, productId, target.storeId],
  );
}

async function rowOf(productId) {
  const { rows } = await pool.query(
    "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
    [productId, target.storeId],
  );
  return { stock: Number(rows[0].stock), reserved: Number(rows[0].reserved) };
}

async function cartLines(sessionId) {
  const { rows } = await pool.query(
    `SELECT ci.product_id, ci.qty
     FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
     WHERE c.session_id = $1 ORDER BY ci.product_id`,
    [sessionId],
  );
  return rows.map((row) => ({ product_id: row.product_id, qty: Number(row.qty) }));
}

async function cartCount(sessionId) {
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM carts WHERE session_id = $1", [
    sessionId,
  ]);
  return rows[0].count;
}

/** Age the session's ACTIVE hold past its expiry, leaving status = 'ACTIVE'. */
async function ageActiveHold(sessionId, productId) {
  await pool.query(
    `UPDATE reservations SET expires_at = now() - interval '1 minute'
     WHERE cart_id = (SELECT id FROM carts WHERE session_id = $1)
       AND product_id = $2 AND status = 'ACTIVE'`,
    [sessionId, productId],
  );
}

/** Mark the session's ACTIVE hold EXPIRED and give back its reserved qty (like the worker). */
async function releaseHold(sessionId, productId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.qty
     FROM reservations r JOIN carts c ON c.id = r.cart_id
     WHERE c.session_id = $1 AND r.product_id = $2 AND r.status = 'ACTIVE'`,
    [sessionId, productId],
  );
  for (const hold of rows) {
    await pool.query(
      "UPDATE store_stock SET reserved = reserved - $1 WHERE product_id = $2 AND store_id = $3",
      [hold.qty, productId, target.storeId],
    );
    await pool.query("UPDATE reservations SET status = 'EXPIRED' WHERE id = $1", [hold.id]);
  }
}

async function openAlerts(productId) {
  const { rows } = await pool.query(
    `SELECT stock_level FROM alerts
     WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'`,
    [productId, target.storeId],
  );
  return rows;
}

async function maxOutboxId() {
  const { rows } = await pool.query("SELECT COALESCE(max(id), 0) AS id FROM outbox");
  return Number(rows[0].id);
}

async function outboxSince(id) {
  const { rows } = await pool.query(
    "SELECT id, topic, key, payload FROM outbox WHERE id > $1 ORDER BY id",
    [id],
  );
  return rows;
}

async function orderCountByKey(key) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM orders WHERE idempotency_key = $1",
    [key],
  );
  return rows[0].count;
}

async function ordersForTestEmails() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE c.email LIKE $1`,
    [TEST_EMAIL_LIKE],
  );
  return rows[0].count;
}

/** The invariant that must hold after every scenario, for one product row. */
async function invariant(label, productId) {
  const { rows } = await pool.query(
    `SELECT ss.stock, ss.reserved,
            COALESCE((
              SELECT SUM(r.qty) FROM reservations r
              WHERE r.product_id = $1 AND r.store_id = $2 AND r.status = 'ACTIVE'
            ), 0)::int AS active_qty
     FROM store_stock ss
     WHERE ss.product_id = $1 AND ss.store_id = $2`,
    [productId, target.storeId],
  );
  const row = rows[0];
  check(
    `invariant ${label}: 0 <= reserved <= stock`,
    row.reserved >= 0 && row.reserved <= row.stock,
    `stock=${row.stock} reserved=${row.reserved}`,
  );
  check(
    `invariant ${label}: reserved = SUM(ACTIVE reservation qty)`,
    row.reserved === row.active_qty,
    `reserved=${row.reserved} active=${row.active_qty}`,
  );
}

function assertOrderShape(res, expected) {
  const order = res.body;
  check(
    `order shape: id/status/fulfilment/total/store_id/city/created_at`,
    res.status === 200 &&
      typeof order?.id === "string" &&
      order.status === "CONFIRMED" &&
      order.fulfilment === expected.fulfilment &&
      order.total === expected.total &&
      order.store_id === target.storeId &&
      order.city === storeCity &&
      typeof order.created_at === "string" &&
      !Number.isNaN(Date.parse(order.created_at)),
    JSON.stringify(order),
  );
  check(
    `order shape: customer { name, email, phone }`,
    order?.customer?.name === expected.customer.name &&
      order.customer.email === expected.customer.email &&
      order.customer.phone === expected.customer.phone,
    JSON.stringify(order?.customer),
  );
  check(
    `order shape: items [{ product_id, name, qty, price }] as numbers`,
    Array.isArray(order?.items) &&
      order.items.length === expected.items.length &&
      order.items.every(
        (item, index) =>
          item.product_id === expected.items[index].product_id &&
          item.qty === expected.items[index].qty &&
          typeof item.price === "number" &&
          typeof item.name === "string",
      ),
    JSON.stringify(order?.items),
  );
}

// ------------------------------------------------------------------- checks

async function test1RaceForOneUnit() {
  section("Test 1: stock=1, two sessions check out at the same time");
  const a = session();
  const b = session();
  await resetRow(target.productId, 2);

  await addItem(a, target.productId, 1);
  await addItem(b, target.productId, 1);
  await releaseHold(b, target.productId);
  await setStockOnly(target.productId, 1);
  check(
    "set up: stock=1 reserved=1, B's line is un-held",
    JSON.stringify(await rowOf(target.productId)) === JSON.stringify({ stock: 1, reserved: 1 }),
    JSON.stringify(await rowOf(target.productId)),
  );

  const ordersBefore = await ordersForTestEmails();
  const [ra, rb] = await Promise.all([checkout(a), checkout(b)]);
  const results = [ra, rb];
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 409);
  const after = await rowOf(target.productId);

  check(
    "exactly one 200 and one 409",
    ok.length === 1 && rejected.length === 1,
    `statuses=${ra.status},${rb.status}`,
  );
  check(
    "loser gets 409 OUT_OF_STOCK listing the item with its available count",
    rejected.length === 1 &&
      errorCode(rejected[0]) === "OUT_OF_STOCK" &&
      rejected[0].body.error.details?.items?.length === 1 &&
      rejected[0].body.error.details.items[0].product_id === target.productId &&
      rejected[0].body.error.details.items[0].available === 0,
    rejected.length ? JSON.stringify(rejected[0].body.error) : "no loser",
  );
  check(
    "stock never goes negative and reserved returns to 0",
    after.stock === 0 && after.reserved === 0,
    JSON.stringify(after),
  );
  check("exactly one order was created", (await ordersForTestEmails()) === ordersBefore + 1);

  await invariant("test 1", target.productId);
  check("the failed checkout left its cart behind", (await cartCount(b)) === 1);
  await api("DELETE", "/api/cart", { sessionId: b });
  check("clearing the failed cart removes it", (await cartCount(b)) === 0);
}

async function test2OwnLiveHold() {
  section("Test 2: the shopper's own live hold is consumed, no double count");
  const s = session();
  await resetRow(target.productId, 5);
  const customer = { name: "Aarav Test", email: email(), phone: "+919111111111" };

  await addItem(s, target.productId, 2);
  const res = await checkout(s, { customer });
  const after = await rowOf(target.productId);

  assertOrderShape(res, {
    fulfilment: "pickup",
    total: Number((price * 2).toFixed(2)),
    customer,
    items: [{ product_id: target.productId, qty: 2 }],
  });
  check(
    "stock and reserved both drop by qty (5/2 -> 3/0), no double count",
    after.stock === 3 && after.reserved === 0,
    JSON.stringify(after),
  );
  check("the cart is deleted at the end", (await cartCount(s)) === 0);
  check("cart_items are gone with the cart", (await cartLines(s)).length === 0);

  const fetched = await api("GET", `/api/orders/${res.body.id}`);
  check(
    "GET /api/orders/:id returns the same shape and values",
    fetched.status === 200 && JSON.stringify(fetched.body) === JSON.stringify(res.body),
    codeDetail(fetched),
  );
  await invariant("test 2", target.productId);
}

async function test3ExpiredActiveHold() {
  section("Test 3: expired-but-ACTIVE hold must not block its own checkout");
  const s = session();
  await resetRow(target.productId, 3);

  await addItem(s, target.productId, 2);
  await ageActiveHold(s, target.productId);
  const { rows: aged } = await pool.query(
    `SELECT status, (expires_at < now()) AS past
     FROM reservations r JOIN carts c ON c.id = r.cart_id
     WHERE c.session_id = $1 AND r.product_id = $2`,
    [s, target.productId],
  );
  check(
    "set up: the hold is still ACTIVE but already expired",
    aged.length === 1 && aged[0].status === "ACTIVE" && aged[0].past === true,
    JSON.stringify(aged),
  );

  const before = await maxOutboxId();
  const res = await checkout(s);
  const after = await rowOf(target.productId);
  const events = (await outboxSince(before)).filter((row) => row.key === `${target.productId}:${target.storeId}`);
  const reasons = events.filter((row) => row.topic === "inventory.changed").map((row) => row.payload.reason);

  check("checkout succeeds (200), not EMPTY_CART/OUT_OF_STOCK", res.status === 200, codeDetail(res));
  check(
    "the expired hold was released and the unit taken directly (3/2 -> 1/0)",
    after.stock === 1 && after.reserved === 0,
    JSON.stringify(after),
  );
  check("an EXPIRE inventory.changed row was written", reasons.includes("EXPIRE"), reasons.join(",") || "none");
  check("the ORDER inventory.changed row was written too", reasons.includes("ORDER"), reasons.join(",") || "none");
  await invariant("test 3", target.productId);
}

async function test4Idempotency() {
  section("Test 4: idempotency — sequential, concurrent, and across sessions");
  await resetRow(target.productId, 5);

  const s1 = session();
  await addItem(s1, target.productId, 1);
  const key1 = "seq-key-1";
  const first = await checkout(s1, { key: key1 });
  const second = await checkout(s1, { key: key1 });
  const storedKey1 = `${s1}:${key1}`;
  check("first use of the key returns 200 with an order", first.status === 200 && !!first.body.id, codeDetail(first));
  check(
    "the key is stored scoped to the session",
    (await orderCountByKey(storedKey1)) === 1 && (await orderCountByKey(key1)) === 0,
    `stored=${storedKey1}`,
  );
  check(
    "replaying the key returns the same order id",
    second.status === 200 && second.body.id === first.body.id,
    `ids=${first.body?.id},${second.body?.id}`,
  );
  check("stock was decremented once", (await rowOf(target.productId)).stock === 4);

  // Same key fired twice at the same time.
  await resetRow(target.productId, 5);
  const s2 = session();
  await addItem(s2, target.productId, 1);
  const key2 = "race-key-2";
  const [c1, c2] = await Promise.all([
    checkout(s2, { key: key2 }),
    checkout(s2, { key: key2 }),
  ]);
  check(
    "concurrent identical keys both return 200",
    c1.status === 200 && c2.status === 200,
    `${c1.status}/${c2.status}`,
  );
  check(
    "concurrent identical keys return the same order id",
    !!c1.body?.id && c1.body.id === c2.body?.id,
    `ids=${c1.body?.id},${c2.body?.id}`,
  );
  check(
    "concurrent identical keys decrement stock once",
    (await rowOf(target.productId)).stock === 4,
    JSON.stringify(await rowOf(target.productId)),
  );
  check(
    "only one order row exists for that key",
    (await orderCountByKey(`${s2}:${key2}`)) === 1,
  );

  // A different session reusing the raw key must not get the first session's order.
  const s3 = session();
  await addItem(s3, target.productId, 1);
  const other = await checkout(s3, { key: key2 });
  check(
    "same raw key from another session creates its own order",
    other.status === 200 && other.body.id !== c1.body.id,
    `ids=${c1.body?.id},${other.body?.id}`,
  );
  check(
    "both session-scoped keys exist, distinct",
    (await orderCountByKey(`${s2}:${key2}`)) === 1 &&
      (await orderCountByKey(`${s3}:${key2}`)) === 1,
  );
  check("stock reflects both checkouts", (await rowOf(target.productId)).stock === 3);
  await invariant("test 4", target.productId);
}

async function test5OutOfStockRollback() {
  section("Test 5: out of stock rolls back fully and lists every failing item");
  const s = session();
  await resetRow(target.productId, 1);
  await resetRow(second.productId, 1);

  await addItem(s, target.productId, 1);
  await addItem(s, second.productId, 1);
  await releaseHold(s, target.productId);
  await releaseHold(s, second.productId);
  await setStockOnly(target.productId, 0);
  await setStockOnly(second.productId, 0);

  const ordersBefore = await ordersForTestEmails();
  const outboxBefore = await maxOutboxId();
  const res = await checkout(s);
  const details = res.body?.error?.details?.items ?? [];
  const after = await outboxSince(outboxBefore);
  const lines = await cartLines(s);

  check(
    "checkout returns 409 OUT_OF_STOCK",
    res.status === 409 && errorCode(res) === "OUT_OF_STOCK",
    codeDetail(res),
  );
  check(
    "every failing item is listed with product_id, name and available",
    details.length === 2 &&
      details.map((item) => item.product_id).join(",") ===
        [target.productId, second.productId].sort((x, y) => x - y).join(",") &&
      details.every((item) => typeof item.name === "string" && item.available === 0),
    JSON.stringify(details),
  );
  check("no order row was created", (await ordersForTestEmails()) === ordersBefore);
  check("no outbox rows were written", after.length === 0, `${after.length} rows`);
  check(
    "the cart is untouched (2 lines, qty 1 each)",
    lines.length === 2 && lines.every((line) => line.qty === 1) && (await cartCount(s)) === 1,
    JSON.stringify(lines),
  );
  check(
    "stock/reserved stay at 0/0",
    JSON.stringify(await rowOf(target.productId)) === JSON.stringify({ stock: 0, reserved: 0 }) &&
      JSON.stringify(await rowOf(second.productId)) === JSON.stringify({ stock: 0, reserved: 0 }),
  );
  await invariant("test 5 (first product)", target.productId);
  await invariant("test 5 (second product)", second.productId);
  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test6AlertAtCheckout() {
  section("Test 6: a checkout that lands on the threshold opens exactly one alert");
  const { rows } = await pool.query("SELECT low_stock_threshold FROM products WHERE id = $1", [
    target.productId,
  ]);
  const threshold = Number(rows[0].low_stock_threshold);
  const s = session();

  await resetRow(target.productId, threshold + 2);
  await addItem(s, target.productId, 1);
  const setUp = await rowOf(target.productId);
  check(
    "set up: no alert while available is above the threshold",
    (await openAlerts(target.productId)).length === 0 &&
      setUp.stock - setUp.reserved > threshold,
    `threshold=${threshold} stock=${setUp.stock} reserved=${setUp.reserved}`,
  );
  await setStockOnly(target.productId, threshold + 1);
  check(
    "set up: available sits exactly on the threshold before checkout",
    (await openAlerts(target.productId)).length === 0,
    JSON.stringify(await rowOf(target.productId)),
  );

  const res = await checkout(s);
  const alerts = await openAlerts(target.productId);
  check("checkout succeeds", res.status === 200, codeDetail(res));
  check(
    "stock ends exactly on the threshold",
    (await rowOf(target.productId)).stock === threshold,
    JSON.stringify(await rowOf(target.productId)),
  );
  check(
    "exactly one OPEN alert with stock_level = threshold",
    alerts.length === 1 && alerts[0].stock_level === threshold,
    JSON.stringify(alerts),
  );
  await invariant("test 6", target.productId);
}

async function test7OutboxPayloads() {
  section("Test 7: order.placed and inventory.changed (ORDER) payloads");
  const s = session();
  await resetRow(target.productId, 6);
  const customer = { name: "Meera Test", email: email(), phone: "+919222222222" };

  await addItem(s, target.productId, 2);
  const before = await maxOutboxId();
  const res = await checkout(s, { key: "outbox-key", fulfilment: "delivery", customer });
  const rows = await outboxSince(before);
  const placed = rows.filter((row) => row.topic === "order.placed");
  const changed = rows.filter((row) => row.topic === "inventory.changed");
  const payload = placed[0]?.payload ?? {};
  const inv = changed[0]?.payload ?? {};
  const finalRow = await rowOf(target.productId);

  check(
    "one order.placed row keyed by order_id",
    placed.length === 1 && placed[0].key === res.body?.id,
    `${placed.length} rows`,
  );
  check(
    "order.placed payload has the section 5 fields",
    payload.order_id === res.body?.id &&
      payload.store_id === target.storeId &&
      payload.city === storeCity &&
      payload.fulfilment === "delivery" &&
      payload.total === Number((price * 2).toFixed(2)) &&
      payload.customer?.name === customer.name &&
      payload.customer?.email === customer.email &&
      payload.customer?.phone === customer.phone &&
      payload.items?.length === 1 &&
      payload.items[0].product_id === target.productId &&
      payload.items[0].qty === 2 &&
      typeof payload.items[0].name === "string" &&
      payload.items[0].price === price &&
      typeof payload.placed_at === "string",
    JSON.stringify(payload),
  );

  check(
    "one inventory.changed row keyed by product:store",
    changed.length === 1 && changed[0].key === `${target.productId}:${target.storeId}`,
    `${changed.length} rows`,
  );
  check(
    "inventory.changed payload has reason ORDER and the section 5 fields",
    inv.reason === "ORDER" &&
      inv.product_id === target.productId &&
      inv.store_id === target.storeId &&
      inv.city === storeCity &&
      inv.stock === finalRow.stock &&
      inv.reserved === finalRow.reserved &&
      inv.available === finalRow.stock - finalRow.reserved &&
      typeof inv.low_stock_threshold === "number" &&
      typeof inv.changed_at === "string",
    JSON.stringify(inv),
  );
  await invariant("test 7", target.productId);
}

async function test8Validation() {
  section("Test 8: validation errors, EMPTY_CART and ORDER_NOT_FOUND");

  const fresh = session();
  const noCart = await checkout(fresh);
  check(
    "no cart -> 400 EMPTY_CART",
    noCart.status === 400 && errorCode(noCart) === "EMPTY_CART",
    codeDetail(noCart),
  );

  const emptied = session();
  await resetRow(target.productId, 5);
  await addItem(emptied, target.productId, 1);
  await addItem(emptied, target.productId, 0);
  check("set up: a cart row exists with no lines", (await cartCount(emptied)) === 1);
  const empty = await checkout(emptied);
  check(
    "cart with no lines -> 400 EMPTY_CART",
    empty.status === 400 && errorCode(empty) === "EMPTY_CART",
    codeDetail(empty),
  );

  const cases = [
    ["empty name", { name: "  ", email: email(), phone: "+919000000000" }, "pickup"],
    ["invalid email", { name: "X", email: "not-an-email", phone: "+919000000000" }, "pickup"],
    ["empty phone", { name: "X", email: email(), phone: "" }, "pickup"],
    ["bad fulfilment", { name: "X", email: email(), phone: "+919000000000" }, "drone"],
  ];
  for (const [label, customer, fulfilment] of cases) {
    const res = await checkout(session(), { customer, fulfilment });
    check(
      `${label} -> 400 BAD_REQUEST`,
      res.status === 400 && errorCode(res) === "BAD_REQUEST",
      codeDetail(res),
    );
  }

  const missingCustomer = await api("POST", "/api/checkout", {
    sessionId: session(),
    body: { fulfilment: "pickup" },
  });
  check(
    "missing customer -> 400 BAD_REQUEST",
    missingCustomer.status === 400 && errorCode(missingCustomer) === "BAD_REQUEST",
    codeDetail(missingCustomer),
  );

  const ordersBefore = await ordersForTestEmails();

  const longKey = await checkout(session(), { key: "k".repeat(129) });
  check(
    "Idempotency-Key over 128 chars -> 400 BAD_REQUEST",
    longKey.status === 400 && errorCode(longKey) === "BAD_REQUEST",
    codeDetail(longKey),
  );

  const noSession = await api("POST", "/api/checkout", {
    body: { customer: { name: "X", email: email(), phone: "+919000000000" }, fulfilment: "pickup" },
  });
  check(
    "missing X-Session-Id -> 400 MISSING_SESSION",
    noSession.status === 400 && errorCode(noSession) === "MISSING_SESSION",
    codeDetail(noSession),
  );

  const malformed = await api("GET", "/api/orders/not-a-uuid");
  const unknown = await api("GET", "/api/orders/00000000-0000-4000-8000-000000000000");
  check(
    "GET /api/orders/:id with a malformed id -> 404 ORDER_NOT_FOUND",
    malformed.status === 404 && errorCode(malformed) === "ORDER_NOT_FOUND",
    codeDetail(malformed),
  );
  check(
    "GET /api/orders/:id with an unknown id -> 404 ORDER_NOT_FOUND",
    unknown.status === 404 && errorCode(unknown) === "ORDER_NOT_FOUND",
    codeDetail(unknown),
  );
  check("validation did not create orders", (await ordersForTestEmails()) === ordersBefore);
  check("stock was never touched by these attempts", (await rowOf(target.productId)).stock === 5);
  await api("DELETE", "/api/cart", { sessionId: emptied });
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
    "SELECT product_id, store_id FROM store_stock ORDER BY product_id, store_id LIMIT 1",
  );
  target = {
    productId: targetRow.rows[0].product_id,
    storeId: targetRow.rows[0].store_id,
  };
  const secondRow = await pool.query(
    "SELECT product_id FROM store_stock WHERE store_id = $1 AND product_id <> $2 ORDER BY product_id LIMIT 1",
    [target.storeId, target.productId],
  );
  second = { productId: secondRow.rows[0].product_id, storeId: target.storeId };
  storeCity = (
    await pool.query("SELECT city FROM stores WHERE id = $1", [target.storeId])
  ).rows[0].city;
  price = Number(
    (await pool.query("SELECT price FROM products WHERE id = $1", [target.productId])).rows[0].price,
  );

  for (const meta of [target, second]) {
    const stockRow = await pool.query(
      "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
      [meta.productId, target.storeId],
    );
    meta.original = {
      stock: Number(stockRow.rows[0].stock),
      reserved: Number(stockRow.rows[0].reserved),
    };
    const alertRow = await pool.query(
      `SELECT stock_level FROM alerts
       WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN' LIMIT 1`,
      [meta.productId, target.storeId],
    );
    meta.originalAlert = alertRow.rows[0] ?? null;
    meta.alertBaseline = Number(
      (await pool.query("SELECT COALESCE(max(id), 0) AS id FROM alerts")).rows[0].id,
    );
  }

  console.log(
    `Testing products ${target.productId} and ${second.productId} at store ${target.storeId} (${storeCity}) via ${API}`,
  );

  try {
    await test1RaceForOneUnit();
    await test2OwnLiveHold();
    await test3ExpiredActiveHold();
    await test4Idempotency();
    await test5OutOfStockRollback();
    await test6AlertAtCheckout();
    await test7OutboxPayloads();
    await test8Validation();
  } finally {
    // Drop test carts (releasing any leftover holds), then their orders and customers.
    for (const s of sessions) {
      await api("DELETE", "/api/cart", { sessionId: s }).catch(() => {});
    }
    await pool.query("DELETE FROM carts WHERE session_id = ANY($1)", [sessions]);
    await pool.query(
      `DELETE FROM orders WHERE customer_id IN
         (SELECT id FROM customers WHERE email LIKE $1)`,
      [TEST_EMAIL_LIKE],
    );
    await pool.query("DELETE FROM customers WHERE email LIKE $1", [TEST_EMAIL_LIKE]);

    // Restore both stock rows and the OPEN alerts exactly as they were.
    for (const meta of [target, second]) {
      await pool.query(
        "UPDATE store_stock SET stock = $1, reserved = $2 WHERE product_id = $3 AND store_id = $4",
        [meta.original.stock, meta.original.reserved, meta.productId, target.storeId],
      );
      await pool.query(
        "DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND id > $3",
        [meta.productId, target.storeId, meta.alertBaseline],
      );
      if (meta.originalAlert) {
        await pool.query(
          `INSERT INTO alerts (product_id, store_id, stock_level, status)
           VALUES ($1, $2, $3, 'OPEN') ON CONFLICT DO NOTHING`,
          [meta.productId, target.storeId, meta.originalAlert.stock_level],
        );
      }
    }
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
  console.error("test:checkout crashed:", err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
