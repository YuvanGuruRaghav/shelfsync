import cors from "cors";
import express from "express";

import config from "./config.js";
import { registerConsumers } from "./consumers/index.js";
import { pool } from "./db/pool.js";
import apiRoutes from "./routes/index.js";
import { startOutboxRelay } from "./workers/outboxRelay.js";
import { startReservationExpiry } from "./workers/reservationExpiry.js";

const app = express();

app.use(
  cors({
    origin: config.corsOrigin,
    allowedHeaders: ["X-Session-Id", "X-Admin-Key", "Idempotency-Key", "Content-Type"],
  }),
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shelfsync-backend",
    eventProvider: config.eventProvider,
    searchProvider: config.searchProvider,
  });
});

app.use("/api", apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
});

// Error handler: keeps the `{ error: { code, message, details? } }` contract for every failure.
app.use((err, _req, res, _next) => {
  const status = Number(err.status ?? err.statusCode ?? 500);
  // Server errors never leak an internal code; client errors keep theirs (or BAD_REQUEST for
  // framework errors such as malformed JSON).
  const code =
    status >= 500
      ? "INTERNAL_ERROR"
      : typeof err.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(err.code)
        ? err.code
        : "BAD_REQUEST";
  if (status >= 500) console.error("[api] unhandled error", err);
  const error = {
    code,
    message: status >= 500 ? "Internal server error" : err.message,
  };
  // `details` is only exposed for client errors, and only when the thrower provided it.
  if (status < 500 && err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
    error.details = err.details;
  }
  res.status(status).json({ error });
});

const server = app.listen(config.port, () => {
  console.log(`ShelfSync API listening on http://localhost:${config.port}`);
});

// Workers and consumers start with the server. Each loop catches its own errors, so a
// failed tick never crashes the process; shutdown stops the timers and the pool.
const outboxRelay = startOutboxRelay();
const reservationExpiry = startReservationExpiry();

registerConsumers().catch((err) => {
  console.error("[consumers] registration failed; the API keeps running", err);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  outboxRelay.stop();
  reservationExpiry.stop();

  const closed = new Promise((resolve) => server.close(resolve));
  // Long-lived SSE connections would otherwise keep the close pending forever.
  server.closeAllConnections?.();
  await closed;
  await pool.end().catch((err) => console.error("[server] error closing the pool", err));

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
