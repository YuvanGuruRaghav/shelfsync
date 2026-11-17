import { Router } from "express";

import { checkout, getOrder } from "../services/checkoutService.js";
import { asyncHandler } from "./asyncHandler.js";
import { requireSession } from "./requireSession.js";

const router = Router();

router.post(
  "/checkout",
  requireSession,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    res.json(
      await checkout({
        sessionId: req.sessionId,
        customer: body.customer,
        fulfilment: body.fulfilment,
        idempotencyKey: req.get("Idempotency-Key") ?? null,
      }),
    );
  }),
);

router.get(
  "/orders/:id",
  asyncHandler(async (req, res) => {
    res.json(await getOrder(req.params.id));
  }),
);

export default router;
