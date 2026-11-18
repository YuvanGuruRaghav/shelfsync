/**
 * Workers + consumers + SSE checks (PLAN 2.1, 4.2, 4.4, 5, 6).
 *
 * Talks to the running API and to the database through pool.js. Sets up its own
 * inventory rows, uses fresh session ids, and restores everything afterwards.
 * Run with the API up (workers and consumers boot with it): `npm run test:events`.
 * Exit code 1 if anything fails.
 */
import crypto from "node:crypto";

import config from "../src/config.js";
import { pool, withTransaction } from "../src/db/pool.js";
import { relayBatch } from "../src/workers/outboxRelay.js";
import { runReservationExpiryTick } from "../src/workers/reservationExpiry.js";

if (config.databaseSsl) {
  console.error("Refusing to run test:events with DATABASE_SSL=true — this script resets stock rows.");
  process.exit(1);
}

const API = process.env.API_URL ?? `http://localhost:${config.port}`;
const failures = [];
const sessions = [];
const checkoutEmails = [];
const TEST_EMAIL_LIKE = "test-events-%@example.com";
const OUTBOX_RELAY_WAIT_MS = 5000;
const EXPIRY_WAIT_MS = 35000;

let target; // { productId, storeId, city, threshold }
let other; // a different store (different product is fine) for the SSE isolation check
let emailCounter = 0;

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

async function waitFor(predicate, timeoutMs, everyMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

function session() {
  const id = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sessions.push(id);
  return id;
}

function email() {
  emailCounter += 1;
  const value = `test-events-${Date.now().toString(36)}-${emailCounter}@example.com`;
  checkoutEmails.push(value);
  return value;
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

function errorCode(res) {
  return res.body?.error?.code ?? null;
}

function codeDetail(res) {
  return res.body?.error ? `${res.status} ${res.body.error.code}` : `${res.status}`;
}

function putItem(sessionId, productId, storeId, qty) {
  return api("PUT", "/api/cart/items", {
    sessionId,
    body: { product_id: productId, qty, store_id: storeId },
  });
}

function checkout(sessionId, customer) {
  return api("POST", "/api/checkout", {
    sessionId,
    body: {
      customer: customer ?? { name: "Events Test", email: email(), phone: "+919000000000" },
      fulfilment: "pickup",
    },
  });
}

// ---------------------------------------------------------------- db helpers

async function resetRow(productId, storeId, stock) {
  await pool.query(
    "UPDATE store_stock SET stock = $1, reserved = 0 WHERE product_id = $2 AND store_id = $3",
    [stock, productId, storeId],
  );
  await pool.query("DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN'", [
    productId,
    storeId,
  ]);
}

async function rowOf(productId, storeId) {
  const { rows } = await pool.query(
    "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
    [productId, storeId],
  );
  return { stock: Number(rows[0].stock), reserved: Number(rows[0].reserved) };
}

async function maxOutboxId() {
  const { rows } = await pool.query("SELECT COALESCE(max(id), 0) AS id FROM outbox");
  return Number(rows[0].id);
}

async function outboxRowsSince(id) {
  const { rows } = await pool.query(
    `SELECT id, event_id, topic, key, payload, published_at
     FROM outbox WHERE id > $1 ORDER BY id`,
    [id],
  );
  return rows;
}

async function cartIdFor(sessionId) {
  const { rows } = await pool.query("SELECT id FROM carts WHERE session_id = $1", [sessionId]);
  return rows[0]?.id ?? null;
}

async function holdInfo(cartId, productId, storeId) {
  const { rows } = await pool.query(
    `SELECT r.status, r.qty, r.expires_at < now() AS past,
            (SELECT count(*)::int FROM cart_items ci
             WHERE ci.cart_id = r.cart_id AND ci.product_id = r.product_id) AS cart_lines
     FROM reservations r
     WHERE r.cart_id = $1 AND r.product_id = $2 AND r.store_id = $3
     ORDER BY r.created_at DESC LIMIT 1`,
    [cartId, productId, storeId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    qty: Number(row.qty),
    past: row.past,
    cartLines: Number(row.cart_lines),
  };
}

async function activeQty(productId, storeId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(qty), 0)::int AS qty FROM reservations
     WHERE product_id = $1 AND store_id = $2 AND status = 'ACTIVE'`,
    [productId, storeId],
  );
  return Number(rows[0].qty);
}

async function outboxFullyDrained(timeoutMs = 10000) {
  return waitFor(
    async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL",
      );
      return rows[0].count === 0;
    },
    timeoutMs,
  );
}

// ------------------------------------------------------------------- checks

async function test1OutboxPublish() {
  section("Test 1: a cart change creates an outbox row published within ~3s");
  await resetRow(target.productId, target.storeId, 10);
  const s = session();
  const before = await maxOutboxId();

  const res = await putItem(s, target.productId, target.storeId, 2);
  check("cart change succeeded", res.status === 200, codeDetail(res));

  const rows = (await outboxRowsSince(before)).filter(
    (row) => row.topic === "inventory.changed" && row.key === `${target.productId}:${target.storeId}`,
  );
  check("one inventory.changed outbox row was written", rows.length === 1, `${rows.length} rows`);
  if (rows.length === 0) return;

  const row = rows[0];
  const started = Date.now();
  const published = await waitFor(async () => {
    const { rows: current } = await pool.query("SELECT published_at FROM outbox WHERE id = $1", [row.id]);
    return current[0]?.published_at ?? null;
  }, 3000, 100);

  check(
    "the relay set published_at within 3s",
    Boolean(published),
    published ? `${Date.now() - started}ms` : `still unpublished after ${Date.now() - started}ms`,
  );

  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test2RelayFailure() {
  section("Test 2: a publish failure stops the batch; the retry loses nothing and keeps order");
  const drained = await outboxFullyDrained();
  check("set up: the outbox is drained before the scenario", Boolean(drained));

  const eventIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const delivered = [];
  let calls = 0;
  const failingPublisher = {
    async publish(event) {
      calls += 1;
      if (event.eventId === eventIds[1]) throw new Error("simulated broker outage");
      delivered.push(event.eventId);
    },
  };

  // Insert the three rows inside the same transaction as the relay batch so the
  // server's own relay cannot pick them up before the simulated failure happens.
  const result = await withTransaction(async (client) => {
    for (let index = 0; index < eventIds.length; index += 1) {
      await client.query(
        `INSERT INTO outbox (event_id, topic, key, payload)
         VALUES ($1, 'test.relay', $2, $3::jsonb)`,
        [eventIds[index], `relay-test-${index + 1}`, JSON.stringify({ seq: index + 1 })],
      );
    }
    return relayBatch(client, failingPublisher);
  });

  check(
    "the batch stopped at the failing row (1 published, then stopped)",
    result.published === 1 && result.stopped === true,
    JSON.stringify(result),
  );
  check(
    "the published event was the first one and the failing one was not delivered",
    delivered.length === 1 && delivered[0] === eventIds[0] && calls === 2,
    `delivered=${delivered.length} calls=${calls}`,
  );

  const { rows: afterFailure } = await pool.query(
    `SELECT id, event_id, published_at FROM outbox WHERE event_id = ANY($1::uuid[]) ORDER BY id`,
    [eventIds],
  );
  check(
    "the failing row and the later row stayed unpublished",
    afterFailure.length === 3 &&
      afterFailure[0].published_at !== null &&
      afterFailure[1].published_at === null &&
      afterFailure[2].published_at === null,
    JSON.stringify(afterFailure.map((row) => row.published_at !== null)),
  );

  const retried = await waitFor(async () => {
    const { rows } = await pool.query(
      `SELECT event_id, published_at FROM outbox WHERE event_id = ANY($1::uuid[]) ORDER BY id`,
      [eventIds],
    );
    return rows.every((row) => row.published_at !== null) ? rows : null;
  }, OUTBOX_RELAY_WAIT_MS, 150);

  check("after the outage both remaining rows were published", Boolean(retried));
  if (retried) {
    const byId = new Map(retried.map((row) => [row.event_id, row.published_at]));
    check(
      "retry preserved order (row 2 published before row 3)",
      new Date(byId.get(eventIds[1])) <= new Date(byId.get(eventIds[2])),
      `${byId.get(eventIds[1])} <= ${byId.get(eventIds[2])}`,
    );
    check(
      "none of the three events was lost",
      eventIds.every((id) => byId.has(id)),
      `${byId.size}/${eventIds.length}`,
    );
  }

  await pool.query("DELETE FROM outbox WHERE event_id = ANY($1::uuid[])", [eventIds]);
}

async function test3Expiry() {
  section("Test 3: the expiry worker releases an expired ACTIVE hold within ~35s");
  await resetRow(target.productId, target.storeId, 10);
  const s = session();
  await putItem(s, target.productId, target.storeId, 3);

  const cartId = await cartIdFor(s);
  await pool.query(
    `UPDATE reservations SET expires_at = now() - interval '1 minute'
     WHERE cart_id = $1 AND product_id = $2 AND store_id = $3 AND status = 'ACTIVE'`,
    [cartId, target.productId, target.storeId],
  );

  const seeded = await holdInfo(cartId, target.productId, target.storeId);
  check(
    "set up: the hold is still ACTIVE but already past expires_at",
    seeded?.status === "ACTIVE" && seeded.past === true,
    JSON.stringify(seeded),
  );
  check("set up: reserved is 3", (await rowOf(target.productId, target.storeId)).reserved === 3);
  const before = await maxOutboxId();

  const started = Date.now();
  const done = await waitFor(async () => {
    const hold = await holdInfo(cartId, target.productId, target.storeId);
    const row = await rowOf(target.productId, target.storeId);
    return hold?.status === "EXPIRED" && row.reserved === 0 ? { hold, row } : null;
  }, EXPIRY_WAIT_MS, 250);

  check(
    "the reservation became EXPIRED and reserved dropped to 0",
    Boolean(done),
    done
      ? `after ${Date.now() - started}ms`
      : `still ${JSON.stringify(await holdInfo(cartId, target.productId, target.storeId))} after ${Date.now() - started}ms`,
  );

  const hold = await holdInfo(cartId, target.productId, target.storeId);
  check("cart items stayed after the hold expired", hold?.cartLines === 1, JSON.stringify(hold));

  const reasons = (await outboxRowsSince(before))
    .filter((row) => row.topic === "inventory.changed" && row.key === `${target.productId}:${target.storeId}`)
    .map((row) => row.payload.reason);
  check("an EXPIRE inventory.changed row exists", reasons.includes("EXPIRE"), reasons.join(",") || "none");
  check("the EXPIRE row published too", await waitFor(async () => {
    const rows = (await outboxRowsSince(before)).filter(
      (row) => row.topic === "inventory.changed" && row.payload?.reason === "EXPIRE",
    );
    return rows.length > 0 && rows.every((row) => row.published_at !== null);
  }, OUTBOX_RELAY_WAIT_MS, 150));

  await api("DELETE", "/api/cart", { sessionId: s });
}

async function test4CheckoutRace() {
  section("Test 4: checkout racing the expiry worker never goes negative");
  const ROUNDS = 5;
  const problems = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    await resetRow(target.productId, target.storeId, 2);
    const s = session();
    await putItem(s, target.productId, target.storeId, 2);

    const cartId = await cartIdFor(s);
    await pool.query(
      `UPDATE reservations SET expires_at = now() - interval '1 minute'
       WHERE cart_id = $1 AND product_id = $2 AND store_id = $3 AND status = 'ACTIVE'`,
      [cartId, target.productId, target.storeId],
    );

    // The worker runs in this process too, so the race is guaranteed rather than timed.
    const [checkoutRes] = await Promise.all([checkout(s), runReservationExpiryTick()]);
    const row = await rowOf(target.productId, target.storeId);
    const active = await activeQty(target.productId, target.storeId);

    if (checkoutRes.status !== 200) {
      problems.push(`round ${round}: checkout ${checkoutRes.status} ${errorCode(checkoutRes)}`);
    }
    if (!(row.stock >= 0 && row.reserved >= 0 && row.reserved <= row.stock)) {
      problems.push(`round ${round}: stock=${row.stock} reserved=${row.reserved}`);
    }
    if (row.reserved !== active) {
      problems.push(`round ${round}: reserved=${row.reserved} active=${active}`);
    }
    if (row.stock !== 0 || row.reserved !== 0) {
      problems.push(`round ${round}: expected 0/0, got ${row.stock}/${row.reserved}`);
    }
  }

  check(
    `all ${ROUNDS} checkout-vs-worker races succeeded with a valid stock row`,
    problems.length === 0,
    problems.slice(0, 4).join(" | "),
  );
}

async function test5IdempotentConsumers() {
  section("Test 5: replaying the same event id runs the side effect once");
  const eventId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const payload = {
    order_id: orderId,
    store_id: target.storeId,
    city: target.city,
    fulfilment: "pickup",
    total: 1,
    customer: { name: "Idem Test", email: email(), phone: "+919000000001" },
    items: [],
    placed_at: new Date().toISOString(),
  };
  const before = await maxOutboxId();

  // Two outbox rows, one event id: the relay publishes both, the consumer must act once.
  await pool.query(
    `INSERT INTO outbox (event_id, topic, key, payload)
     VALUES ($1, 'order.placed', $2, $3::jsonb), ($1, 'order.placed', $2, $3::jsonb)`,
    [eventId, orderId, JSON.stringify(payload)],
  );

  const rows = (await outboxRowsSince(before)).filter((row) => row.event_id === eventId);
  check("two outbox rows carry the same event id", rows.length === 2, `${rows.length} rows`);

  const published = await waitFor(async () => {
    const { rows: current } = await pool.query(
      "SELECT published_at FROM outbox WHERE event_id = $1",
      [eventId],
    );
    return current.length === 2 && current.every((row) => row.published_at !== null);
  }, OUTBOX_RELAY_WAIT_MS, 150);
  check("both duplicate rows were published", Boolean(published));

  const { rows: processed } = await pool.query(
    "SELECT count(*)::int AS count FROM processed_events WHERE consumer = 'notification' AND event_id = $1",
    [eventId],
  );
  check(
    "processed_events has exactly one notification row for the event id",
    processed[0].count === 1,
    `count=${processed[0].count}`,
  );

  await pool.query("DELETE FROM processed_events WHERE event_id = $1", [eventId]);
  await pool.query("DELETE FROM outbox WHERE event_id = $1", [eventId]);
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

async function test6Sse() {
  section("Test 6: SSE pushes inventory.changed only to the matching store");
  await resetRow(target.productId, target.storeId, 10);
  await resetRow(other.productId, other.storeId, 10);

  const controller = new AbortController();
  const res = await fetch(`${API}/api/stream/stock?store_id=${target.storeId}`, {
    signal: controller.signal,
  });
  check(
    "stream responds 200 with text/event-stream",
    res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    `${res.status} ${res.headers.get("content-type")}`,
  );

  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closing = false;

  const pump = (async () => {
    try {
      while (!closing) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const parsed = parseSseBlock(block);
          if (parsed) events.push(parsed);
        }
      }
    } catch (err) {
      if (!closing) throw err;
    }
  })();

  await sleep(300); // let the connection open before generating an event
  const s = session();
  const put = await putItem(s, target.productId, target.storeId, 1);
  check("store 1 cart change succeeded", put.status === 200, codeDetail(put));

  const expectedAvailable = 9;
  const received = await waitFor(
    () =>
      events.find(
        (entry) =>
          entry.event === "stock" &&
          entry.data.product_id === target.productId &&
          entry.data.store_id === target.storeId,
      ),
    3000,
    100,
  );

  check("received a stock event for store 1 within 3s", Boolean(received), JSON.stringify(events));
  if (received) {
    check(
      "event data is { product_id, store_id, available, low } with the right available",
      received.data.available === expectedAvailable &&
        received.data.low === (expectedAvailable <= target.threshold) &&
        Object.keys(received.data).sort().join(",") === "available,low,product_id,store_id",
      JSON.stringify(received.data),
    );
  }

  const beforeOther = events.length;
  const s2 = session();
  const otherPut = await putItem(s2, other.productId, other.storeId, 1);
  check("store 2 cart change succeeded", otherPut.status === 200, codeDetail(otherPut));

  await sleep(2500);
  const leaked = events
    .slice(beforeOther)
    .filter((entry) => entry.data.store_id === other.storeId || entry.data.store_id !== target.storeId);
  check(
    "a change at store 2 is NOT delivered on the store 1 stream",
    leaked.length === 0,
    JSON.stringify(leaked),
  );

  closing = true;
  controller.abort();
  await pump.catch(() => {});

  await api("DELETE", "/api/cart", { sessionId: s });
  await api("DELETE", "/api/cart", { sessionId: s2 });
}

async function test7Notification() {
  section("Test 7: order.placed triggers the notification consumer");
  await resetRow(target.productId, target.storeId, 5);
  const s = session();
  await putItem(s, target.productId, target.storeId, 1);

  const customer = { name: "Notify Test", email: email(), phone: "+919000000002" };
  const res = await checkout(s, customer);
  check("checkout succeeded and returned an order", res.status === 200 && !!res.body?.id, codeDetail(res));
  if (res.status !== 200) return;

  const { rows } = await pool.query(
    `SELECT event_id FROM outbox
     WHERE topic = 'order.placed' AND key = $1
     ORDER BY id DESC LIMIT 1`,
    [res.body.id],
  );
  const eventId = rows[0]?.event_id ?? null;
  check("an order.placed outbox row exists for the order", Boolean(eventId));

  const processed = await waitFor(async () => {
    const { rows: current } = await pool.query(
      "SELECT 1 FROM processed_events WHERE consumer = 'notification' AND event_id = $1",
      [eventId],
    );
    return current.length === 1;
  }, OUTBOX_RELAY_WAIT_MS, 150);

  check(
    "the notification consumer processed the event (mock email + SMS logged)",
    Boolean(processed),
  );
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
    `SELECT ss.product_id, ss.store_id, s.city, p.low_stock_threshold
     FROM store_stock ss
     JOIN stores s ON s.id = ss.store_id
     JOIN products p ON p.id = ss.product_id
     ORDER BY ss.product_id, ss.store_id
     LIMIT 1`,
  );
  target = {
    productId: targetRow.rows[0].product_id,
    storeId: targetRow.rows[0].store_id,
    city: targetRow.rows[0].city,
    threshold: Number(targetRow.rows[0].low_stock_threshold),
  };

  const otherRow = await pool.query(
    `SELECT product_id, store_id FROM store_stock
     WHERE store_id <> $1 AND stock - reserved >= 2
     ORDER BY store_id, product_id LIMIT 1`,
    [target.storeId],
  );
  if (otherRow.rows.length === 0) {
    console.error("Seed data has no second store with available stock; cannot run test:events.");
    await pool.end();
    process.exitCode = 1;
    return;
  }
  other = { productId: otherRow.rows[0].product_id, storeId: otherRow.rows[0].store_id };

  // Snapshot both rows so everything can be restored.
  for (const meta of [target, other]) {
    const snapshot = await pool.query(
      "SELECT stock, reserved FROM store_stock WHERE product_id = $1 AND store_id = $2",
      [meta.productId, meta.storeId],
    );
    meta.original = {
      stock: Number(snapshot.rows[0].stock),
      reserved: Number(snapshot.rows[0].reserved),
    };
    const alertRow = await pool.query(
      `SELECT stock_level FROM alerts
       WHERE product_id = $1 AND store_id = $2 AND status = 'OPEN' LIMIT 1`,
      [meta.productId, meta.storeId],
    );
    meta.originalAlert = alertRow.rows[0] ?? null;
    meta.alertBaseline = Number(
      (await pool.query("SELECT COALESCE(max(id), 0) AS id FROM alerts")).rows[0].id,
    );
  }

  console.log(
    `Testing product ${target.productId} at store ${target.storeId} (${target.city}) and product ${other.productId} at store ${other.storeId} via ${API}`,
  );

  try {
    await test1OutboxPublish();
    await test2RelayFailure();
    await test3Expiry();
    await test4CheckoutRace();
    await test5IdempotentConsumers();
    await test6Sse();
    await test7Notification();
  } finally {
    for (const s of sessions) {
      await api("DELETE", "/api/cart", { sessionId: s }).catch(() => {});
    }
    await pool.query("DELETE FROM carts WHERE session_id = ANY($1)", [sessions]);
    await pool.query(
      `DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE $1)`,
      [TEST_EMAIL_LIKE],
    );
    await pool.query("DELETE FROM customers WHERE email LIKE $1", [TEST_EMAIL_LIKE]);

    for (const meta of [target, other]) {
      await pool.query(
        "UPDATE store_stock SET stock = $1, reserved = $2 WHERE product_id = $3 AND store_id = $4",
        [meta.original.stock, meta.original.reserved, meta.productId, meta.storeId],
      );
      await pool.query(
        "DELETE FROM alerts WHERE product_id = $1 AND store_id = $2 AND id > $3",
        [meta.productId, meta.storeId, meta.alertBaseline],
      );
      if (meta.originalAlert) {
        await pool.query(
          `INSERT INTO alerts (product_id, store_id, stock_level, status)
           VALUES ($1, $2, $3, 'OPEN') ON CONFLICT DO NOTHING`,
          [meta.productId, meta.storeId, meta.originalAlert.stock_level],
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
  console.error("test:events crashed:", err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
