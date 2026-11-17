import { Router } from "express";

import catalogRoutes from "./catalogRoutes.js";
import searchRoutes from "./searchRoutes.js";

const router = Router();

router.use(catalogRoutes);
router.use(searchRoutes);

export default router;
