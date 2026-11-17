import { Router } from "express";

import { assertPriceRange, parseAmount, parseInteger, parseText } from "../services/params.js";
import { searchProducts } from "../services/searchService.js";
import { asyncHandler } from "./asyncHandler.js";

const router = Router();

router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = parseText(req.query.q, "q");
    const storeId = parseInteger(req.query.store_id, "store_id", { min: 1 });
    const category = parseText(req.query.category, "category") || null;
    const minPrice = parseAmount(req.query.min_price, "min_price", { fallback: 0 });
    const maxPrice = parseAmount(req.query.max_price, "max_price", { fallback: 1_000_000 });
    assertPriceRange(minPrice, maxPrice);
    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 100, fallback: 20 });

    res.json(await searchProducts({ q, storeId, category, minPrice, maxPrice, limit }));
  }),
);

export default router;
