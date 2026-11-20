import config from "../config.js";
import { withTransaction } from "../db/pool.js";
import { getPublisher } from "../providers/publisher/index.js";

/**
 * Outbox relay worker (PLAN 2.1, 4, rule 3).
 *
 * Polls unpublished outbox rows oldest-first, publishes each one through the publisher
 * provider with the row's `event_id` as the event id, then stamps `published_at`.
 * Delivery is at-least-once, so every consumer must be idempotent (4.4).
 *
 * This is the ONLY module allowed to call a provider while a transaction is open:
 * the row locks and the publish happen in the same transaction so concurrent relay
 * instances never publish the same row. Keep it tiny.
 */

const BATCH_SIZE = 50;

/**
 * Publish one batch of unpublished rows using an open transaction client.
 * A publish failure stops the batch: the failing row and every later row stay
 * unpublished and are retried on the next tick. Rows published earlier in the
 * batch keep their `published_at` (the caller commits this transaction normally).
 */
export async function relayBatch(client, publisher) {
  const { rows } = await client.query(
    `SELECT id, event_id, topic, key, payload
     FROM outbox
     WHERE published_at IS NULL
     ORDER BY id
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE],
  );

  let published = 0;
  for (const row of rows) {
    try {
      await publisher.publish({
        eventId: row.event_id,
        topic: row.topic,
        key: row.key,
        payload: row.payload,
      });
    } catch (err) {
      console.error(
        `[outbox] publish failed for row ${row.id} (event ${row.event_id}); stopping this batch, retrying next tick`,
        err,
      );
      return { published, stopped: true };
    }

    await client.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
    published += 1;
  }

  return { published, stopped: false };
}

/** One relay tick: one transaction, one batch. */
export async function runOutboxRelayTick(publisher = getPublisher()) {
  return withTransaction((client) => relayBatch(client, publisher));
}

/**
 * Start the interval loop. A failed tick is logged and the next tick simply retries;
 * a worker error must never crash the server.
 */
export function startOutboxRelay({ intervalMs = config.outboxRelayIntervalMs, publisher } = {}) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runOutboxRelayTick(publisher);
    } catch (err) {
      console.error("[outbox] relay tick failed; continuing next tick", err);
    } finally {
      running = false;
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
