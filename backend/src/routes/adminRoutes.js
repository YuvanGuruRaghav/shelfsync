import { Router } from "express";

import { listAlerts, listEvents, restock, updateProduct } from "../services/adminService.js";
import { parseInteger, parseText } from "../services/params.js";
import { asyncHandler } from "./asyncHandler.js";
import { requireAdmin } from "./requireAdmin.js";

const router = Router();

router.use("/admin", requireAdmin);

router.get(
  "/admin/alerts",
  asyncHandler(async (req, res) => {
    const status = parseText(req.query.status, "status") || "OPEN";
    res.json(await listAlerts({ status }));
  }),
);

router.get(
  "/admin/events",
  asyncHandler(async (req, res) => {
    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 200, fallback: 50 });
    res.json(await listEvents({ limit }));
  }),
);

router.post(
  "/admin/stock",
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    res.json(
      await restock({
        productId: body.product_id,
        storeId: body.store_id,
        add: body.add,
      }),
    );
  }),
);

router.patch(
  "/admin/products/:id",
  asyncHandler(async (req, res) => {
    const productId = parseInteger(req.params.id, "id", { min: 1 });
    res.json(await updateProduct(productId, req.body ?? {}));
  }),
);

export default router;
