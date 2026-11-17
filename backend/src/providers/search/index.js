import config from "../../config.js";
import { pool } from "../../db/pool.js";

/**
 * Search provider interface:
 *   search({ q, city, category, minPrice, maxPrice, limit }) => Promise<Product[]>
 *
 * SEARCH_PROVIDER=postgres   — pg_trgm fuzzy matching, city-aware ranking (default)
 * SEARCH_PROVIDER=opensearch — same interface, real OpenSearch once Aiven is provisioned
 */

// Shoppers type Hinglish. Normalise before matching.
const TERM_ALIASES = {
  blutooth: "bluetooth",
  blootooth: "bluetooth",
  hedphone: "headphone",
  headfone: "headphone",
  headphone: "headphone",
  earfone: "earbuds",
  earphne: "earbuds",
  earbud: "earbuds",
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

const postgresSearch = {
  name: "postgres",

  async search({ q = "", city = null, category = null, minPrice = 0, maxPrice = 1_000_000, limit = 40 }) {
    const { terms, priceSort } = parseQuery(q);
    const priceDirection = priceSort === "desc" ? "DESC" : "ASC";
    const categoryFilter = category || null;

    if (terms.length === 0) {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.description, p.category, p.price, p.image_url,
                p.low_stock_threshold,
                0::float AS score,
                COALESCE(SUM(CASE WHEN st.city = $1 THEN ss.stock - ss.reserved ELSE 0 END), 0) AS city_available,
                COALESCE(SUM(ss.stock - ss.reserved), 0) AS total_available
         FROM products p
         JOIN store_stock ss ON ss.product_id = p.id
         JOIN stores st ON st.id = ss.store_id
         WHERE ($2::text IS NULL OR p.category = $2)
           AND p.price >= $3 AND p.price <= $4
         GROUP BY p.id
         ORDER BY (COALESCE(SUM(CASE WHEN st.city = $1 THEN ss.stock - ss.reserved ELSE 0 END), 0) > 0) DESC,
                  p.price ${priceDirection}, p.name ASC
         LIMIT $5`,
        [city, categoryFilter, minPrice, maxPrice, limit],
      );
      return rows;
    }

    const { rows } = await pool.query(
      `WITH matched AS (
         SELECT p.id, p.name, p.description, p.category, p.price, p.image_url, p.low_stock_threshold,
                MAX(GREATEST(
                  similarity(p.name, t.term),
                  word_similarity(t.term, p.description),
                  similarity(p.category, t.term)
                )) AS score
         FROM products p
         CROSS JOIN unnest($1::text[]) AS t(term)
         WHERE ($2::text IS NULL OR p.category = $2)
           AND p.price >= $3 AND p.price <= $4
           AND (
             similarity(p.name, t.term) > 0.2
             OR word_similarity(t.term, p.description) > 0.55
             OR similarity(p.category, t.term) > 0.3
             OR lower(p.name) LIKE '%' || lower(t.term) || '%'
             OR lower(p.category) LIKE '%' || lower(t.term) || '%'
           )
         GROUP BY p.id
       )
       SELECT m.*,
              COALESCE(SUM(CASE WHEN st.city = $5 THEN ss.stock - ss.reserved ELSE 0 END), 0) AS city_available,
              COALESCE(SUM(ss.stock - ss.reserved), 0) AS total_available
       FROM matched m
       JOIN store_stock ss ON ss.product_id = m.id
       JOIN stores st ON st.id = ss.store_id
       GROUP BY m.id, m.name, m.description, m.category, m.price, m.image_url, m.low_stock_threshold, m.score
       ORDER BY (COALESCE(SUM(CASE WHEN st.city = $5 THEN ss.stock - ss.reserved ELSE 0 END), 0) > 0) DESC,
                m.score DESC, m.price ${priceDirection}
       LIMIT $6`,
      [terms, categoryFilter, minPrice, maxPrice, city, limit],
    );
    return rows;
  },
};

const opensearchSearch = {
  name: "opensearch",

  async search({ q = "", city = null, category = null, minPrice = 0, maxPrice = 1_000_000, limit = 40 }) {
    const { terms, priceSort } = parseQuery(q);
    let client;
    try {
      const { Client } = await import("@opensearch-project/opensearch");
      client = new Client({ node: process.env.OPENSEARCH_URL });
    } catch {
      throw new Error(
        "SEARCH_PROVIDER=opensearch requires the @opensearch-project/opensearch package and OPENSEARCH_URL. Use SEARCH_PROVIDER=postgres for local dev.",
      );
    }

    const must = terms.length
      ? [{ multi_match: { query: terms.join(" "), fields: ["name^3", "category^2", "description"], fuzziness: "AUTO" } }]
      : [{ match_all: {} }];

    const body = {
      size: limit,
      query: {
        bool: {
          must,
          filter: [
            { range: { price: { gte: minPrice, lte: maxPrice } } },
            ...(category ? [{ term: { category } }] : []),
          ],
        },
      },
      sort: [
        { _script: { type: "number", order: "desc", script: { source: "doc['city_available'].size()>0 && doc['city'].value=='" + (city ?? "") + "' ? 1 : 0" } } },
        { price: { order: priceSort === "desc" ? "desc" : "asc" } },
      ],
    };

    const res = await client.search({ index: "products", body });
    return res.body.hits.hits.map((hit) => ({ ...hit._source, score: hit._score }));
  },
};

const providers = { postgres: postgresSearch, opensearch: opensearchSearch };

export function getSearchProvider() {
  const provider = providers[config.searchProvider];
  if (!provider) throw new Error(`Unknown SEARCH_PROVIDER "${config.searchProvider}" (expected postgres|opensearch)`);
  return provider;
}
