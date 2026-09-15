import { Router, type IRouter } from "express";
import { ReplayCpuBody, ReplayCpuResponse } from "@isogate/api-zod";
import { runCpuReplay } from "../lib/cpu-replay";

const router: IRouter = Router();

router.post("/replays", (req, res): void => {
  const parsed = ReplayCpuBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Replay input rejected");
    res.status(400).json({ error: "Provide exactly eight byte values and 1 to 32 cycles." });
    return;
  }

  const result = runCpuReplay(parsed.data);
  req.log.info(
    { cycles: result.requestedCycles, digestPrefix: result.digest.slice(0, 12) },
    "CPU replay completed",
  );
  res.json(ReplayCpuResponse.parse(result));
});

export default router;