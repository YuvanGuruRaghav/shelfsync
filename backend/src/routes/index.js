import { Router } from "express";

import cartRoutes from "./cartRoutes.js";
import catalogRoutes from "./catalogRoutes.js";
import checkoutRoutes from "./checkoutRoutes.js";
import searchRoutes from "./searchRoutes.js";
import streamRoutes from "./streamRoutes.js";

const router = Router();

router.use(catalogRoutes);
router.use(searchRoutes);
router.use(cartRoutes);
router.use(checkoutRoutes);
router.use(streamRoutes);

export default router;
