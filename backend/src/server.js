import cors from "cors";
import express from "express";

import config from "./config.js";

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

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
});

// Error handler: keeps the `{ error: { code, message } }` contract for every failure.
app.use((err, _req, res, _next) => {
  const status = Number(err.status ?? err.statusCode ?? 500);
  const code =
    typeof err.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : "INTERNAL_ERROR";
  if (status >= 500) console.error("[api] unhandled error", err);
  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? "Internal server error" : err.message,
    },
  });
});

app.listen(config.port, () => {
  console.log(`ShelfSync API listening on http://localhost:${config.port}`);
});
