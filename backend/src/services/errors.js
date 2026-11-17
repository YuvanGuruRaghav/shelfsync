/**
 * Build an error the API error handler can turn into `{ error: { code, message, details? } }`.
 * `details` is only surfaced for status < 500 (see server.js).
 */
export function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/** Query-param failures are always 400 BAD_REQUEST with a readable message. */
export function badRequest(message, details) {
  return httpError(400, "BAD_REQUEST", message, details);
}
