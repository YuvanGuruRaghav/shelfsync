import { Router } from "express";

import { getProduct, listCategories, listProducts, listStores } from "../services/catalogService.js";
import { assertPriceRange, parseAmount, parseInteger, parseText } from "../services/params.js";
import { asyncHandler } from "./asyncHandler.js";

const router = Router();

router.get(
  "/stores",
  asyncHandler(async (_req, res) => {
    res.json(await listStores());
  }),
);

router.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    res.json(await listCategories());
  }),
);

router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const storeId = parseInteger(req.query.store_id, "store_id", { min: 1 });
    const category = parseText(req.query.category, "category") || null;
    const minPrice = parseAmount(req.query.min_price, "min_price", { fallback: 0 });
    const maxPrice = parseAmount(req.query.max_price, "max_price", { fallback: 1_000_000 });
    assertPriceRange(minPrice, maxPrice);
    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 100, fallback: 20 });
    const offset = parseInteger(req.query.offset, "offset", { min: 0, fallback: 0 });

    res.json(await listProducts({ storeId, category, minPrice, maxPrice, limit, offset }));
  }),
);

router.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const productId = parseInteger(req.params.id, "id", { min: 1 });
    const storeId = parseInteger(req.query.store_id, "store_id", { min: 1 });
    res.json(await getProduct(productId, { storeId }));
  }),
);

export default router;
