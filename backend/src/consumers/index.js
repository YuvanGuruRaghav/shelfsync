import crypto from "node:crypto";

import { withTransaction } from "../db/pool.js";
import { getPublisher } from "../providers/publisher/index.js";
import { getSearchProvider } from "../providers/search/index.js";
import { broadcastStock } from "../realtime/stockStream.js";

/**
 * Event consumers (PLAN 4.4, 5).
 *
 * Every consumer records (consumer, event_id) in `processed_events` in the same
 * transaction as its side effects and skips the event when the insert conflicts,
 * so replaying an event id never repeats a side effect.
 */

// `live-stock` must fan out to every server instance, so its Kafka consumer group and
// its processed_events namespace are unique per process; otherwise one instance would
// mark an event processed for all the others.
const LIVE_STOCK_CONSUMER = `live-stock-${crypto.randomBytes(6).toString("hex")}`;

async function markProcessed(client, consumer, eventId) {
  if (!eventId) return true; // outbox rows always carry one; be permissive if not.
  const { rowCount } = await client.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [consumer, eventId],
  );
  return rowCount > 0;
}

/** notification: order.placed -> one mock email and one mock SMS line. */
async function handleOrderPlaced({ eventId, payload }) {
  await withTransaction(async (client) => {
    if (!(await markProcessed(client, "notification", eventId))) return;

    const customer = payload.customer ?? {};
    const name = customer.name ?? "customer";
    console.log(
      `[notification] mock email -> ${customer.email ?? "unknown"}: Hi ${name}, your ShelfSync order ${payload.order_id} is confirmed (total ${payload.total}).`,
    );
    console.log(
      `[notification] mock sms -> ${customer.phone ?? "unknown"}: Order ${payload.order_id} confirmed. We will update you when it is ready.`,
    );
  });
}

/** search-index: product.updated -> searchProvider.indexProduct. */
async function handleProductUpdated({ eventId, payload }, searchProvider) {
  await withTransaction(async (client) => {
    if (!(await markProcessed(client, "search-index", eventId))) return;
    await searchProvider.indexProduct(payload.product_id);
  });
}

/** live-stock: inventory.changed -> push to SSE clients watching that store. */
async function handleInventoryChanged({ eventId, payload }) {
  await withTransaction(async (client) => {
    if (!(await markProcessed(client, LIVE_STOCK_CONSUMER, eventId))) return;
    broadcastStock(payload);
  });
}

/**
 * Register the three consumers on boot. Subscriptions are provider calls outside any
 * transaction; the handlers themselves own their transactions.
 */
export async function registerConsumers() {
  const publisher = getPublisher();
  const searchProvider = getSearchProvider();

  await publisher.subscribe("order.placed", "notification", handleOrderPlaced);
  await publisher.subscribe("product.updated", "search-index", (event) =>
    handleProductUpdated(event, searchProvider),
  );
  await publisher.subscribe("inventory.changed", LIVE_STOCK_CONSUMER, handleInventoryChanged);

  console.log("[consumers] notification, search-index and live-stock registered");
}
