import { Router } from "express";

import { badRequest } from "../services/errors.js";
import { clearCart, getCart, removeCartItem, setCartItem } from "../services/cartService.js";
import { parseInteger } from "../services/params.js";
import { asyncHandler } from "./asyncHandler.js";
import { requireSession } from "./requireSession.js";

const router = Router();

router.use("/cart", requireSession);

function requiredInteger(raw, name, bounds) {
  const value = parseInteger(raw, name, bounds);
  if (value === null) throw badRequest(`${name} is required`);
  return value;
}

router.get(
  "/cart",
  asyncHandler(async (req, res) => {
    res.json(await getCart(req.sessionId));
  }),
);

router.put(
  "/cart/items",
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const productId = requiredInteger(body.product_id, "product_id", { min: 1 });
    const qty = requiredInteger(body.qty, "qty", { min: 0, max: 20 });
    const storeId = requiredInteger(body.store_id, "store_id", { min: 1 });

    res.json(await setCartItem({ sessionId: req.sessionId, productId, qty, storeId }));
  }),
);

router.delete(
  "/cart/items/:product_id",
  asyncHandler(async (req, res) => {
    const productId = parseInteger(req.params.product_id, "product_id", { min: 1 });
    res.json(await removeCartItem({ sessionId: req.sessionId, productId }));
  }),
);

router.delete(
  "/cart",
  asyncHandler(async (req, res) => {
    res.json(await clearCart(req.sessionId));
  }),
);

export default router;
