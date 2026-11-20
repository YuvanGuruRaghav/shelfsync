const SESSION_KEY = "shelfsync.session_id";
const VALID_SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

let cachedSessionId = null;

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for browsers without randomUUID; still a 36-char UUID-shaped id.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One session id per browser, created on first use and kept in localStorage.
 * Returns null during server rendering so server components never touch storage.
 */
export function getSessionId() {
  if (typeof window === "undefined") return null;
  if (cachedSessionId && VALID_SESSION_ID.test(cachedSessionId)) return cachedSessionId;

  try {
    const stored = window.localStorage.getItem(SESSION_KEY);
    if (stored && VALID_SESSION_ID.test(stored)) {
      cachedSessionId = stored;
      return cachedSessionId;
    }
    const id = randomId().replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);
    if (!VALID_SESSION_ID.test(id)) return null;
    window.localStorage.setItem(SESSION_KEY, id);
    cachedSessionId = id;
    return id;
  } catch {
    // Storage can be blocked (private mode); cart calls then fail with MISSING_SESSION, which is honest.
    return null;
  }
}
