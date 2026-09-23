import { Router, Request, Response } from "express";
import { z } from "zod";
import { completeTrainingFromRunPod } from "../services/lora.service";

const router = Router();

// POST /api/webhooks/runpod — signed callback from RunPod serverless
// Body shape depends on your serverless handler; we accept any JSON and look
// for the common fields: status, output, error, scanSessionId query param.
const RunpodBody = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
  output: z.any().optional(),
  error: z.any().optional(),
}).passthrough();

router.post("/runpod", async (req: Request, res: Response, next) => {
  try {
    const scanSessionId = z.string().parse(req.query.session);
    const body = RunpodBody.parse(req.body);

    const isSuccess = body.status === "COMPLETED" || (!body.status && !body.error);
    const errorMessage = body.error ? (typeof body.error === "string" ? body.error : JSON.stringify(body.error)) : undefined;

    // output.loraDownloadUrl or output.url are common conventions
    const artifactUrl =
      (body.output && (body.output.loraDownloadUrl ?? body.output.url ?? body.output.downloadUrl)) as string | undefined;

    await completeTrainingFromRunPod({
      scanSessionId,
      success: isSuccess,
      artifactUrl,
      errorMessage,
      metadata: { raw: body },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
