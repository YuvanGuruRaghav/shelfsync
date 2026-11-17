import { httpError } from "../services/errors.js";

const SESSION_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Every cart route needs a client-generated session id. */
export function requireSession(req, _res, next) {
  const sessionId = req.get("X-Session-Id");
  if (typeof sessionId !== "string" || !SESSION_PATTERN.test(sessionId)) {
    return next(
      httpError(
        400,
        "MISSING_SESSION",
        "X-Session-Id header is required: 8-64 characters of A-Z, a-z, 0-9 or -",
      ),
    );
  }
  req.sessionId = sessionId;
  return next();
}
