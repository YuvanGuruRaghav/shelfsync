import express from "express";

import config from "./config.js";

const app = express();

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "shelfsync-backend",
    eventProvider: config.eventProvider,
    searchProvider: config.searchProvider,
  });
});

app.listen(config.port, () => {
  console.log(`ShelfSync API listening on http://localhost:${config.port}`);
});
