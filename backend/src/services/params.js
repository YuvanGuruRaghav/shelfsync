import { badRequest } from "./errors.js";

function single(raw, name) {
  if (Array.isArray(raw)) throw badRequest(`${name} must be given once`);
  return raw;
}

function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === "";
}

/** Integer query param with explicit bounds; `fallback` is used when absent. */
export function parseInteger(raw, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  const value = single(raw, name);
  if (isBlank(value)) {
    if (fallback === undefined) return null;
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw badRequest(`${name} must be an integer`);
  if (parsed < min || parsed > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return parsed;
}

/** Non-negative decimal query param (prices); `fallback` is used when absent. */
export function parseAmount(raw, name, { fallback = null } = {}) {
  const value = single(raw, name);
  if (isBlank(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`);
  if (parsed < 0) throw badRequest(`${name} must be zero or greater`);
  return parsed;
}

/** Free-text query param; empty means "no query". */
export function parseText(raw, name) {
  const value = single(raw, name);
  if (isBlank(value)) return "";
  return String(value).trim();
}

export function assertPriceRange(minPrice, maxPrice) {
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw badRequest("min_price must be less than or equal to max_price");
  }
}
