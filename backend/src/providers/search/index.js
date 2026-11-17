import config from "../../config.js";
import { pool } from "../../db/pool.js";

/**
 * Search provider interface (PLAN section 2.1):
 *   search({ q, storeId, category, minPrice, maxPrice, limit }) => Promise<Item[]>
 *   indexProduct(productId) => Promise<void>
 *   removeProduct(productId) => Promise<void>
 *
 * Items are the browse shape plus `score`: { id, name, description, category,
 * price, image_url, available, low, score }.
 *
 * SEARCH_PROVIDER=postgres   — pg_trgm fuzzy matching, city-aware ranking (default)
 * SEARCH_PROVIDER=opensearch — same interface, real OpenSearch once Aiven is provisioned
 */

// Shoppers type Hinglish. Normalise before matching.
const TERM_ALIASES = {
  blutooth: "bluetooth",
  blootooth: "bluetooth",
  bluetooth: "bluetooth",
  hedphone: "headphone",
  headfone: "headphone",
  headphone: "headphone",
  earfone: "earbuds",
  earphne: "earbuds",
  earbud: "earbuds",
  earphones: "earphones",
  smartwtch: "smart watch",
  laptop: "laptop",
  tv: "monitor",
  shoes: "shoes",
  chappal: "sandal",
  kurta: "tshirt",
  battry: "battery",
  chrger: "charger",
  camra: "camera",
};

// Price-intent words: dropped from the text query, used to sort instead.
const PRICE_INTENT = {
  sasta: "asc",
  sasti: "asc",
  saste: "asc",
  sastaa: "asc",
  cheap: "asc",
  budget: "asc",
  kam: "asc",
  mehnga: "desc",
  mehngi: "desc",
  mehnge: "desc",
  premium: "desc",
  costly: "desc",
};

function parseQuery(q) {
  const tokens = String(q ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let priceSort = null;
  const terms = [];
  for (const token of tokens) {
    if (PRICE_INTENT[token]) {
      priceSort = priceSort ?? PRICE_INTENT[token];
      continue;
    }
    terms.push(TERM_ALIASES[token] ?? token);
  }
  return { terms: [...new Set(terms)], priceSort };
}

/**
 * Fuzzy match: similarity() works on the whole string, word_similarity() finds
 * the best matching word inside a longer name, so "bluetoth" still hits
 * "Noise-Cancelling Bluetooth Headphones".
 */
const MATCH_SQL = `(
  similarity(p.name, t.term) > 0.25
  OR word_similarity(t.term, p.name) > 0.45
  OR similarity(p.description, t.term) > 0.3
  OR word_similarity(t.term, p.description) > 0.55
  OR similarity(p.category, t.term) > 0.35
  OR lower(p.name) LIKE '%' || t.term || '%'
  OR lower(p.description) LIKE '%' || t.term || '%'
  OR lower(p.category) LIKE '%' || t.term || '%'
)`;

const SCORE_SQL = `GREATEST(
  similarity(p.name, t.term),
  word_similarity(t.term, p.name),
  similarity(p.description, t.term),
  word_similarity(t.term, p.description) * 0.9,
  similarity(p.category, t.term)
)`;

// Availability for the requested store, and across all stores when no store is given.
const AVAILABILITY_SQL = `
  COALESCE((SELECT SUM(ss.stock - ss.reserved) FROM store_stock ss WHERE ss.product_id = p.id), 0) AS available_total,
  COALESCE((SELECT ss.stock - ss.reserved FROM store_stock ss WHERE ss.product_id = p.id AND ss.store_id = $1), 0) AS available_store`;

function toItem(row, storeId) {
  const available = Number(storeId === null ? row.available_total : row.available_store);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: Number(row.price),
    image_url: row.image_url,
    available,
    low: storeId === null ? false : available <= row.low_stock_threshold,
    score: Number(row.score),
  };
}

// In-stock in the shopper's city first; falls back to total availability without a store.
const IN_STOCK_FIRST_SQL = `(CASE WHEN $1::int IS NULL THEN (m.available_total > 0) ELSE (m.available_store > 0) END) DESC`;

const postgresSearch = {
  name: "postgres",

  async search({ q = "", storeId = null, category = null, minPrice = 0, maxPrice = 1_000_000, limit = 20 }) {
    const { terms, priceSort } = parseQuery(q);
    const priceDirection = priceSort === "desc" ? "DESC" : "ASC";
    const categoryFilter = category || null;

    if (terms.length === 0) {
      const { rows } = await pool.query(
        `WITH matched AS (
           SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
                  0::float AS score,
                  ${AVAILABILITY_SQL}
           FROM products p
           WHERE ($2::text IS NULL OR p.category = $2)
             AND p.price >= $3 AND p.price <= $4
         )
         SELECT m.id, m.name, m.description, m.category, m.price, m.image_url, m.low_stock_threshold,
                m.score, m.available_total, m.available_store
         FROM matched m
         ORDER BY ${IN_STOCK_FIRST_SQL}, m.price ${priceDirection}, m.id ASC
         LIMIT $5`,
        [storeId, categoryFilter, minPrice, maxPrice, limit],
      );
      return rows.map((row) => toItem(row, storeId));
    }

    // The city lookup is the provider's own concern (ranking boost), never the service's.
    const { rows } = await pool.query(
      `WITH matched AS (
         SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
                MAX(${SCORE_SQL}) AS score,
                ${AVAILABILITY_SQL}
         FROM products p
         CROSS JOIN unnest($2::text[]) AS t(term)
         WHERE ($3::text IS NULL OR p.category = $3)
           AND p.price >= $4 AND p.price <= $5
           AND ${MATCH_SQL}
         GROUP BY p.id
       )
       SELECT m.id, m.name, m.description, m.category, m.price, m.image_url, m.low_stock_threshold,
              m.score, m.available_total, m.available_store
       FROM matched m
       ORDER BY ${IN_STOCK_FIRST_SQL}, m.score DESC, m.price ${priceDirection}, m.id ASC
       LIMIT $6`,
      [storeId, terms, categoryFilter, minPrice, maxPrice, limit],
    );
    return rows.map((row) => toItem(row, storeId));
  },

  // The products table is the index: no-op.
  async indexProduct() {},
  async removeProduct() {},
};

const opensearchSearch = {
  name: "opensearch",

  async search() {
    // TODO(step: search-index consumer): real OpenSearch query, same item shape.
    throw new Error("not implemented yet");
  },

  async indexProduct() {
    // TODO(step: search-index consumer): upsert into the products index.
    throw new Error("not implemented yet");
  },

  async removeProduct() {
    // TODO(step: search-index consumer): delete from the products index.
    throw new Error("not implemented yet");
  },
};

const providers = { postgres: postgresSearch, opensearch: opensearchSearch };

export function getSearchProvider() {
  const provider = providers[config.searchProvider];
  if (!provider) throw new Error(`Unknown SEARCH_PROVIDER "${config.searchProvider}" (expected postgres|opensearch)`);
  return provider;
}
