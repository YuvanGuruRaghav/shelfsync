/** Build an error the API error handler can turn into `{ error: { code, message } }`. */
export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** Query-param failures are always 400 BAD_REQUEST with a readable message. */
export function badRequest(message) {
  return httpError(400, "BAD_REQUEST", message);
}
