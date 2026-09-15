import { Router, type IRouter } from "express";
import healthRouter from "./health";
import replaysRouter from "./replays";
import providersRouter from "./providers";
import networkRouter from "./network";
import agentsRouter from "./agents";
import genesisRouter from "./genesis";
import genesisLaunchesRouter from "./genesis-launches";

const router: IRouter = Router();

router.use(healthRouter);
router.use(replaysRouter);
router.use(providersRouter);
router.use(networkRouter);
router.use(agentsRouter);
router.use(genesisRouter);
router.use(genesisLaunchesRouter);

export default router;
