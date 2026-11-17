/**
 * Cart + reservation concurrency checks (PLAN 4.2, 4.3, 5).
 *
 * Talks to the running API and to the database through pool.js. Sets up its own
 * inventory row, uses fresh session ids and restores the row afterwards.
 * Run with the API up: `npm run test:cart`. Exit code 1 if anything fails.
 */
import config from "../src/config.js";
import { pool } from "../src/db/pool.js";

if (config.databaseSsl) {
  console.error("Refusing to run test:cart with DATABASE_SSL=true — this script resets a stock row.");
  process.exit(1);
}

const API = process.env.API_URL ?? `http://localhost:${config.port}`;
const failures = [];
const sessions = [];

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

async function api(method, path, { sessionId, body } = {}) {
  const headers = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
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

function putItem(sessionId, qty, store = null) {
  return api("PUT", "/api/cart/items", {
    sessionId,
    body: { product_id: productId, qty, store_id: store ?? storeId },
  });
}

function errorCode(res) {
  return res.body?.error?.code ?? null;
}

function codeDetail(res) {
  return res.body?.error ? `${res.status} ${res.body.error.code}` : `${res.status}`;
}

// ---------------------------------------------------------------- db helpers

let productId;
let storeId;
let otherStoreId;
let original;
let originalAlert;
let alertBaseline = 0;

async function resetRow(stock = 5) {
  await pool.query("UPDATE store_stock SET stock = $1, reserved = 0 WHERE product_id = $2 AND store_id = $3", [
    stock,
    productId,
    storeId,
  ]);
  await pool.query("DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'", [
    productId,
    storeId,
  ]);
}

async function reservedNow() {
  const { rows } = await pool.query(
    "SELECT reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
    [productId, storeId],
  );
  return rows[0].reserved;
}

async function openAlerts() {
  const { rows } = await pool.query(
    `SELECT stock_level FROM alerts
     WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'`,
    [productId, storeId],
  );
  return rows;
}

async function cartRows(sessionId) {
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM carts WHERE session_id = $1", [
    sessionId,
  ]);
  return rows[0].count;
}

async function maxOutboxId() {
  const { rows } = await pool.query("SELECT COALESCE(max(id), 0) AS id FROM outbox");
  return Number(rows[0].id);
}

async function inventoryEventsSince(id) {
  const { rows } = await pool.query(
    `SELECT payload->>'reason' AS reason
     FROM outbox
     WHERE topic = 'inventory.changed' AND id > $1 AND key = $2`,
    [id, `${productId}:${storeId}`],
  );
  return rows.map((row) => row.reason);
}

/** The invariant that must hold after every scenario. */
async function invariantState() {
  const { rows } = await pool.query(
    `SELECT ss.stock, ss.reserved,
            COALESCE((
              SELECT SUM(r.qty) FROM reservations r
              WHERE r.product_id = $1 AND r.store_id = $2 AND r.status = 'ACTIVE'
            ), 0)::int AS active_qty
     FROM store_stock ss
     WHERE ss.product_id = $1 AND ss.store_id = $2`,
    [productId, storeId],
  );
  const row = rows[0];
  return {
    inRange: row.reserved >= 0 && row.reserved <= row.stock,
    matches: row.reserved === row.active_qty,
    rangeDetail: `stock=${row.stock} reserved=${row.reserved}`,
    sumDetail: `reserved=${row.reserved} active=${row.active_qty}`,
  };
}

async function invariant(label) {
  const state = await invariantState();
  check(`invariant ${label}: 0 <= reserved <= stock`, state.inRange, state.rangeDetail);
  check(
    `invariant ${label}: reserved = SUM(ACTIVE reservation qty)`,
    state.matches,
    state.sumDetail,
  );
  return state.inRange && state.matches;
}

// ------------------------------------------------------------------- checks

async function test1Sequence() {
  section("Test 1: set semantics (2 -> 3 -> 1 -> 0)");
  const s = session();
  await resetRow(5);

  const empty = await api("GET", "/api/cart", { sessionId: s });
  check(
    "GET /api/cart for a fresh session returns the empty body",
    empty.status === 200 &&
      empty.body.store_id === null &&
      empty.body.city === null &&
      Array.isArray(empty.body.items) &&
      empty.body.items.length === 0 &&
      empty.body.total === 0 &&
      empty.body.expires_at === null,
    JSON.stringify(empty.body),
  );
  check("GET /api/cart did not create a cart row", (await cartRows(s)) === 0);

  let res = await putItem(s, 2);
  check(
    "PUT qty=2 -> 200, reserved=2, held=true",
    res.status === 200 && (await reservedNow()) === 2 && res.body.items[0].qty === 2 && res.body.items[0].held === true,
    codeDetail(res),
  );
  check(
    "cart line carries price, line_total and available",
    res.body.items[0].line_total === res.body.items[0].price * 2 &&
      res.body.items[0].available === 3 &&
      res.body.total === res.body.items[0].line_total &&
      typeof res.body.expires_at === "string",
    JSON.stringify(res.body.items[0]),
  );

  res = await putItem(s, 3);
  check("PUT qty=3 -> reserved=3", res.status === 200 && (await reservedNow()) === 3, codeDetail(res));

  res = await putItem(s, 1);
  check("PUT qty=1 -> reserved=1", res.status === 200 && (await reservedNow()) === 1, codeDetail(res));

  res = await putItem(s, 0);
  check(
    "PUT qty=0 -> reserved=0 and cart empty",
    res.status === 200 && (await reservedNow()) === 0 && res.body.items.length === 0 && res.body.expires_at === null,
    codeDetail(res),
  );

  await invariant("test 1");
}

async function test2Race() {
  section("Test 2: two sessions race for qty=2 with stock=3");
  await resetRow(3);
  const a = session();
  const b = session();

  const [ra, rb] = await Promise.all([putItem(a, 2), putItem(b, 2)]);
  const winners = [ra, rb].filter((r) => r.status === 200);
  const losers = [ra, rb].filter((r) => r.status === 409);
  const reserved = await reservedNow();

  check(
    "exactly one request wins",
    winners.length === 1 && losers.length === 1,
    `statuses=${ra.status},${rb.status}`,
  );
  check(
    "loser gets 409 INSUFFICIENT_STOCK with details.available=1",
    losers.length === 1 &&
      errorCode(losers[0]) === "INSUFFICIENT_STOCK" &&
      losers[0].body.error.details?.available === 1,
    losers.length ? JSON.stringify(losers[0].body.error) : "no loser",
  );
  check("reserved ends at 2", reserved === 2, `reserved=${reserved}`);

  await invariant("test 2");
  await Promise.all([api("DELETE", "/api/cart", { sessionId: a }), api("DELETE", "/api/cart", { sessionId: b })]);
  check("cleanup released the hold", (await reservedNow()) === 0, `reserved=${await reservedNow()}`);
}

async function test3Stampede() {
  section("Test 3: 20 sessions stampede for qty=1 with stock=5");
  await resetRow(5);
  const racers = Array.from({ length: 20 }, () => session());

  const results = await Promise.all(racers.map((s) => putItem(s, 1)));
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 409 && errorCode(r) === "INSUFFICIENT_STOCK");
  const reserved = await reservedNow();

  check("exactly 5 succeed", ok.length === 5, `ok=${ok.length}`);
  check("exactly 15 get 409 INSUFFICIENT_STOCK", rejected.length === 15, `rejected=${rejected.length}`);
  check("reserved ends at 5", reserved === 5, `reserved=${reserved}`);

  await invariant("test 3");
  await Promise.all(racers.map((s) => api("DELETE", "/api/cart", { sessionId: s })));
  check("cleanup released the holds", (await reservedNow()) === 0, `reserved=${await reservedNow()}`);
}

async function test4SameSession() {
  section("Test 4: same session, 10 identical PUTs of qty=2 fired at once");
  await resetRow(5);
  const s = session();

  const results = await Promise.all(Array.from({ length: 10 }, () => putItem(s, 2)));
  const reserved = await reservedNow();

  check("all 10 requests return 200", results.every((r) => r.status === 200), results.map(codeDetail).join(","));
  check("reserved is 2, no double counting", reserved === 2, `reserved=${reserved}`);
  check("cart has one line of qty 2", results.at(-1).body.items.length === 1 && results.at(-1).body.items[0].qty === 2);

  await invariant("test 4");
  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test5StoreMismatch() {
  section("Test 5: different store on a non-empty cart");
  await resetRow(5);
  const s = session();

  const first = await putItem(s, 1);
  const mismatch = await putItem(s, 1, otherStoreId);

  check("first item lands in the cart", first.status === 200, codeDetail(first));
  check(
    "other store returns 409 CART_STORE_MISMATCH with details.store_id",
    mismatch.status === 409 &&
      errorCode(mismatch) === "CART_STORE_MISMATCH" &&
      mismatch.body.error.details?.store_id === storeId,
    JSON.stringify(mismatch.body?.error ?? mismatch.body),
  );

  const second = await putItem(s, 1);
  check("same store still works afterwards", second.status === 200 && second.body.items[0].qty === 1);

  await invariant("test 5");
  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test6ClearCart() {
  section("Test 6: DELETE /api/cart releases everything");
  await resetRow(5);
  const s = session();
  await putItem(s, 2);
  const before = await maxOutboxId();

  const cleared = await api("DELETE", "/api/cart", { sessionId: s });
  check(
    "clear returns the empty cart body",
    cleared.status === 200 && cleared.body.store_id === null && cleared.body.items.length === 0 && cleared.body.total === 0,
    JSON.stringify(cleared.body),
  );
  check("reserved is back to the starting value", (await reservedNow()) === 0, `reserved=${await reservedNow()}`);

  const reasons = await inventoryEventsSince(before);
  check("a RELEASE inventory.changed row was written", reasons.includes("RELEASE"), reasons.join(",") || "none");

  const again = await api("DELETE", "/api/cart", { sessionId: s });
  check("clearing twice is idempotent", again.status === 200 && again.body.items.length === 0);

  await invariant("test 6");
}

async function test7Alerts() {
  section("Test 7: low-stock alert opens and resolves");
  const { rows } = await pool.query("SELECT low_stock_threshold FROM products WHERE id = $1", [productId]);
  const threshold = rows[0].low_stock_threshold;
  const stock = threshold + 5;
  await resetRow(stock);
  const s = session();

  check("no OPEN alert to start with", (await openAlerts()).length === 0);
  const res = await putItem(s, 5);
  const open = await openAlerts();

  check(
    `reserving down to available=${threshold} opens exactly one alert`,
    res.status === 200 && open.length === 1 && open[0].stock_level === threshold,
    `status=${res.status} alerts=${JSON.stringify(open)}`,
  );

  await api("DELETE", "/api/cart", { sessionId: s });
  check("releasing resolves the alert", (await openAlerts()).length === 0);

  await invariant("test 7");
}

async function test8Outbox() {
  section("Test 8: inventory.changed outbox rows match the operations");
  await resetRow(6);
  const s = session();
  const before = await maxOutboxId();

  await putItem(s, 2); // RESERVE
  await putItem(s, 3); // RESERVE
  await putItem(s, 0); // RELEASE

  const reasons = await inventoryEventsSince(before);
  const reserves = reasons.filter((r) => r === "RESERVE").length;
  const releases = reasons.filter((r) => r === "RELEASE").length;

  check("2 RESERVE rows", reserves === 2, `reasons=${reasons.join(",")}`);
  check("1 RELEASE row", releases === 1, `reasons=${reasons.join(",")}`);

  const { rows } = await pool.query(
    `SELECT payload FROM outbox
     WHERE topic = 'inventory.changed' AND id > $1 AND key = $2
     ORDER BY id DESC LIMIT 1`,
    [before, `${productId}:${storeId}`],
  );
  const payload = rows[0]?.payload ?? {};
  check(
    "payload carries product_id, store_id, city, stock, reserved, available, low_stock_threshold, reason, changed_at",
    ["product_id", "store_id", "city", "stock", "reserved", "available", "low_stock_threshold", "reason", "changed_at"].every(
      (field) => payload[field] !== undefined,
    ),
    JSON.stringify(payload),
  );

  await invariant("test 8");
  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test9DeleteRace() {
  section("Test 9: DELETE /api/cart races PUT qty=1, 20 rounds");
  await resetRow(5);
  const ROUNDS = 20;
  const unexpected = [];
  const roundFailures = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const s = session();
    // Start from a committed cart so the PUT's INSERT conflicts and the DELETE can remove
    // the row between that INSERT and the locking SELECT — the retry path.
    await putItem(s, 1);

    const [cleared, held] = await Promise.all([
      api("DELETE", "/api/cart", { sessionId: s }),
      putItem(s, 1),
    ]);

    for (const res of [cleared, held]) {
      if (res.status >= 500 || res.status !== 200) {
        unexpected.push(`round ${round}: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }

    const state = await invariantState();
    if (!state.inRange || !state.matches) {
      roundFailures.push(`round ${round}: ${state.rangeDetail} ${state.sumDetail}`);
    }

    await api("DELETE", "/api/cart", { sessionId: s });
  }

  check(
    `no round returned a 5xx or unexpected status over ${ROUNDS} rounds`,
    unexpected.length === 0,
    unexpected.slice(0, 3).join(" | "),
  );
  check(
    `invariant held after each of the ${ROUNDS} rounds`,
    roundFailures.length === 0,
    roundFailures.slice(0, 3).join(" | "),
  );
  await invariant("test 9");
}

async function test10BooleanFields() {
  section("Test 10: boolean ids/quantities are rejected");
  const s = session();
  const base = { product_id: productId, qty: 1, store_id: storeId };

  const qtyTrue = await api("PUT", "/api/cart/items", { sessionId: s, body: { ...base, qty: true } });
  check(
    "qty: true -> 400 BAD_REQUEST",
    qtyTrue.status === 400 && errorCode(qtyTrue) === "BAD_REQUEST",
    JSON.stringify(qtyTrue.body),
  );

  const productFalse = await api("PUT", "/api/cart/items", {
    sessionId: s,
    body: { ...base, product_id: false },
  });
  check(
    "product_id: false -> 400 BAD_REQUEST",
    productFalse.status === 400 && errorCode(productFalse) === "BAD_REQUEST",
    JSON.stringify(productFalse.body),
  );

  const storeTrue = await api("PUT", "/api/cart/items", { sessionId: s, body: { ...base, store_id: true } });
  check(
    "store_id: true -> 400 BAD_REQUEST",
    storeTrue.status === 400 && errorCode(storeTrue) === "BAD_REQUEST",
    JSON.stringify(storeTrue.body),
  );

  check("rejected bodies created no cart and no hold", (await cartRows(s)) === 0 && (await reservedNow()) === 0);
  await invariant("test 10");
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

  const target = await pool.query(
    `SELECT product_id, store_id FROM store_stock ORDER BY product_id, store_id LIMIT 1`,
  );
  productId = target.rows[0].product_id;
  storeId = target.rows[0].store_id;
  otherStoreId = (await pool.query("SELECT id FROM stores WHERE id <> $1 ORDER BY id LIMIT 1", [storeId])).rows[0].id;

  const stockRow = await pool.query(
    "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
    [productId, storeId],
  );
  original = stockRow.rows[0];
  const alertRow = await pool.query(
    `SELECT stock_level FROM alerts WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN' LIMIT 1`,
    [productId, storeId],
  );
  originalAlert = alertRow.rows[0] ?? null;
  alertBaseline = Number((await pool.query("SELECT COALESCE(max(id), 0) AS id FROM alerts")).rows[0].id);

  console.log(
    `Testing product ${productId} at store ${storeId} (other store ${otherStoreId}) via ${API}`,
  );

  try {
    await test1Sequence();
    await test2Race();
    await test3Stampede();
    await test4SameSession();
    await test5StoreMismatch();
    await test6ClearCart();
    await test7Alerts();
    await test8Outbox();
    await test9DeleteRace();
    await test10BooleanFields();
  } finally {
    // Clean up: drop the test carts, restore the stock row and the original OPEN alert.
    for (const s of sessions) {
      await api("DELETE", "/api/cart", { sessionId: s }).catch(() => {});
    }
    await pool.query("DELETE FROM carts WHERE session_id = ANY($1)", [sessions]);
    await pool.query(
      "UPDATE store_stock SET stock = $1, reserved = $2 WHERE product_id = $3 AND store_id = $4",
      [original.stock, original.reserved, productId, storeId],
    );
    await pool.query(
      "DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND id > $3",
      [productId, storeId, alertBaseline],
    );
    if (originalAlert) {
      await pool.query(
        `INSERT INTO alerts (product_id, store_id, stock_level, status)
         VALUES ($1, $2, $3, 'OPEN') ON CONFLICT DO NOTHING`,
        [productId, storeId, originalAlert.stock_level],
      );
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
  console.error("test:cart crashed:", err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
