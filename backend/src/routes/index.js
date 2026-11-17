import { Router } from "express";

import cartRoutes from "./cartRoutes.js";
import catalogRoutes from "./catalogRoutes.js";
import searchRoutes from "./searchRoutes.js";

const router = Router();

router.use(catalogRoutes);
router.use(searchRoutes);
router.use(cartRoutes);

export default router;
