import crypto from "node:crypto";

import config from "../config.js";
import { httpError } from "../services/errors.js";

/**
 * Admin auth (PLAN 6, Admin): every /api/admin/* route requires `X-Admin-Key` to
 * equal env `ADMIN_KEY`. Both values are hashed first so timingSafeEqual always
 * compares equal-length buffers and the comparison leaks neither the key length
 * nor its bytes. An empty `ADMIN_KEY` rejects every request.
 */
function keysMatch(provided, expected) {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function requireAdmin(req, _res, next) {
  const provided = req.get("X-Admin-Key");
  if (!config.adminKey || typeof provided !== "string" || !keysMatch(provided, config.adminKey)) {
    next(httpError(401, "UNAUTHORIZED", "A valid X-Admin-Key header is required"));
    return;
  }
  next();
}
