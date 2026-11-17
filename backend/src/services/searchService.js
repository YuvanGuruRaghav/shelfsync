import { pool } from "../db/pool.js";
import { getSearchProvider } from "../providers/search/index.js";
import { httpError } from "./errors.js";

/**
 * Search: validates the store, then delegates ranking to the search provider.
 * Cities are the provider's concern; this service only knows store ids.
 */
export async function searchProducts({ q = "", storeId = null, category = null, minPrice = 0, maxPrice = 1_000_000, limit = 20 }) {
  if (storeId !== null && storeId !== undefined) {
    const { rowCount } = await pool.query("SELECT 1 FROM stores WHERE id = $1", [storeId]);
    if (rowCount === 0) throw httpError(400, "INVALID_STORE", `Store ${storeId} does not exist`);
  }

  const provider = getSearchProvider();
  const items = await provider.search({ q, storeId, category, minPrice, maxPrice, limit });
  return { items };
}
