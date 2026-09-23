import { Router, Request, Response } from "express";
import { z } from "zod";
import { PrismaClient, Role, JobStatus } from "@prisma/client";
import { cancelJob } from "../services/runpod.service";
import { wipeLoRA, wipeScanSession, wipeMemberAccount } from "../services/privacy.service";
import { completeTrainingFromRunPod } from "../services/lora.service";

const prisma = new PrismaClient();
const router = Router();

// ----- Members -----------------------------------------------------------
router.get("/members", async (req, res, next) => {
  try {
    const items = await prisma.member.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, email: true, role: true, createdAt: true, lastActiveAt: true,
        _count: { select: { scanSessions: true, loras: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

router.post("/members/:id/wipe", async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    await wipeMemberAccount({
      memberId: req.params.id,
      actorId: req.user!.id,
      actorIsAdmin: true,
      reason: body.reason,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- Jobs --------------------------------------------------------------
router.get("/jobs", async (req, res, next) => {
  try {
    const items = await prisma.trainingJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { member: { select: { id: true, email: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

router.post("/jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = await prisma.trainingJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: "Not found" });
    if (job.runpodJobId) await cancelJob(job.runpodJobId);
    await prisma.trainingJob.update({ where: { id: job.id }, data: { status: JobStatus.CANCELLED, finishedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/jobs/:id/retry", async (req, res, next) => {
  try {
    const job = await prisma.trainingJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: "Not found" });
    if (job.retries >= job.maxRetries) return res.status(409).json({ error: "Max retries reached" });
    // Re-trigger finalize path with the existing scan session:
    const { finalizeAndSubmitTraining } = await import("../services/lora.service");
    await prisma.scanSession.update({ where: { id: job.scanSessionId }, data: { status: "FAILED" } });
    const result = await finalizeAndSubmitTraining({ memberId: job.memberId, scanSessionId: job.scanSessionId });
    await prisma.trainingJob.update({ where: { id: job.id }, data: { retries: job.retries + 1 } });
    res.json(result);
  } catch (e) { next(e); }
});

// ----- Force-delete single assets ---------------------------------------
router.delete("/loras/:loraId", async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    const lora = await prisma.loRA.findUnique({ where: { id: req.params.loraId } });
    if (!lora) return res.status(404).json({ error: "Not found" });
    await wipeLoRA({ loraId: lora.id, actorId: req.user!.id, actorIsAdmin: true, ownerMemberId: lora.memberId, reason: body.reason });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/scans/:sessionId", async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    const s = await prisma.scanSession.findUnique({ where: { id: req.params.sessionId } });
    if (!s) return res.status(404).json({ error: "Not found" });
    await wipeScanSession({ scanSessionId: s.id, actorId: req.user!.id, actorIsAdmin: true, ownerMemberId: s.memberId, reason: body.reason });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- Manual mock completion (dev only, gated behind admin) -------------
router.post("/mock/complete-training/:scanSessionId", async (req, res, next) => {
  try {
    const body = z.object({ success: z.boolean().default(true), errorMessage: z.string().optional() }).parse(req.body ?? {});
    const out = await completeTrainingFromRunPod({
      scanSessionId: req.params.scanSessionId,
      success: body.success,
      errorMessage: body.errorMessage,
      artifactBuffer: body.success ? Buffer.from(`mock-lora-${Date.now()}`) : undefined,
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ----- Audit log ---------------------------------------------------------
const AuditQuery = z.object({
  memberId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
router.get("/audits", async (req, res, next) => {
  try {
    const q = AuditQuery.parse(req.query);
    const items = await prisma.auditLog.findMany({
      where: {
        ...(q.memberId ? { memberId: q.memberId } : {}),
        ...(q.action ? { action: q.action as any } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { member: { select: { email: true } }, actor: { select: { email: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

export default router;
