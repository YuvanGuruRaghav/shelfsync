import { Router } from "express";

import { badRequest } from "../services/errors.js";
import { parseInteger } from "../services/params.js";
import { openStockStream } from "../services/streamService.js";
import { asyncHandler } from "./asyncHandler.js";

const router = Router();

router.get(
  "/stream/stock",
  asyncHandler(async (req, res) => {
    const storeId = parseInteger(req.query.store_id, "store_id", { min: 1 });
    if (storeId === null) throw badRequest("store_id is required");

    await openStockStream({ storeId, req, res });
  }),
);

export default router;
