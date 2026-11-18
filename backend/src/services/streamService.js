import { pool } from "../db/pool.js";
import { addStockClient } from "../realtime/stockStream.js";
import { httpError } from "./errors.js";

/**
 * Track where stock changed (PLAN 5, 6). Validates the store, opens the SSE
 * response and registers the client. The route only parses `store_id`.
 */

const HEARTBEAT_MS = 20000;

export async function openStockStream({ storeId, req, res }) {
  const { rowCount } = await pool.query("SELECT 1 FROM stores WHERE id = $1", [storeId]);
  if (rowCount === 0) {
    throw httpError(400, "INVALID_STORE", `Store ${storeId} does not exist`);
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const remove = addStockClient(storeId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    remove();
  }

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}
