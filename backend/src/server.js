import cors from "cors";
import express from "express";

import config from "./config.js";
import apiRoutes from "./routes/index.js";

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

app.listen(config.port, () => {
  console.log(`ShelfSync API listening on http://localhost:${config.port}`);
});
