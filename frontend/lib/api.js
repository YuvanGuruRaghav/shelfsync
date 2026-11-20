import { API_URL } from "./config";
import { getSessionId } from "./session";

/**
 * The single API client (PLAN section 7).
 *
 * - Base URL: NEXT_PUBLIC_API_URL, via lib/config.
 * - X-Session-Id is attached on every client-side call. Server components get null
 *   from getSessionId(), so the header is simply absent there.
 * - X-Admin-Key is attached only when `admin: true`; the key lives in sessionStorage
 *   and is set by the admin page in Step 10.
 * - Every failure becomes an Error with { status, code, message, details } from the
 *   `{ error: {...} }` contract in section 6.
 */

const ADMIN_KEY_STORAGE = "shelfsync.admin_key";

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function getAdminKey() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setAdminKey(key) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  } catch {
    // Ignored: the admin page reports a failed request instead.
  }
}

export function clearAdminKey() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    // Ignored.
  }
}

function buildQuery(params) {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

async function request(path, { method = "GET", query, body, admin = false, headers = {} } = {}) {
  const url = `${API_URL}${path}${buildQuery(query)}`;
  const requestHeaders = { Accept: "application/json", ...headers };

  const sessionId = getSessionId();
  if (sessionId) requestHeaders["X-Session-Id"] = sessionId;
  if (admin) {
    const adminKey = getAdminKey();
    if (adminKey) requestHeaders["X-Admin-Key"] = adminKey;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: `Cannot reach the ShelfSync API at ${API_URL}.`,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = data && typeof data === "object" && data.error ? data.error : {};
    throw new ApiError({
      status: response.status,
      code: error.code || "INTERNAL_ERROR",
      message: error.message || `Request failed with status ${response.status}`,
      details: error.details,
    });
  }

  return data;
}

export const api = {
  // Public
  health: () => request("/api/health"),
  getStores: () => request("/api/stores"),
  getCategories: () => request("/api/categories"),
  getProducts: (params = {}) => request("/api/products", { query: params }),
  getProduct: (id, params = {}) => request(`/api/products/${encodeURIComponent(id)}`, { query: params }),
  search: (params = {}) => request("/api/search", { query: params }),
  stockStreamUrl: (storeId) => `${API_URL}/api/stream/stock?store_id=${encodeURIComponent(storeId)}`,

  // Cart (Step 10 UI)
  getCart: () => request("/api/cart"),
  setCartItem: ({ product_id, qty, store_id }) =>
    request("/api/cart/items", { method: "PUT", body: { product_id, qty, store_id } }),
  removeCartItem: (productId) => request(`/api/cart/items/${encodeURIComponent(productId)}`, { method: "DELETE" }),
  clearCart: () => request("/api/cart", { method: "DELETE" }),

  // Checkout + orders (Step 10 UI)
  checkout: ({ customer, fulfilment, idempotencyKey }) =>
    request("/api/checkout", {
      method: "POST",
      body: { customer, fulfilment },
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    }),
  getOrder: (id) => request(`/api/orders/${encodeURIComponent(id)}`),

  // Admin (Step 10 UI; key comes from sessionStorage)
  listAlerts: (status = "OPEN") => request("/api/admin/alerts", { query: { status }, admin: true }),
  listEvents: (limit = 50) => request("/api/admin/events", { query: { limit }, admin: true }),
  restock: ({ product_id, store_id, add }) =>
    request("/api/admin/stock", { method: "POST", admin: true, body: { product_id, store_id, add } }),
  updateProduct: (id, fields) =>
    request(`/api/admin/products/${encodeURIComponent(id)}`, { method: "PATCH", admin: true, body: fields }),
};

export default api;
