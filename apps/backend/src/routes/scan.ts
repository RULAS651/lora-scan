import { Router, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { ScanAngle, Role } from "@prisma/client";
import {
  createScanSession,
  appendScanImage,
  finalizeAndSubmitTraining,
} from "../services/lora.service";
import { deIdentifyFace, downscaleForTraining } from "../services/privacy.service";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

const MAX_MB = Number(process.env.SCAN_MAX_FILE_SIZE_MB ?? 8);
const upload = multer({
  storage: multer.memoryStorage(), // keep in memory only — no plaintext disk
  limits: {
    fileSize: MAX_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype);
    cb(ok ? null : (Object.assign(new Error("Only JPEG/PNG allowed"), { statusCode: 400 }) as any), ok);
  },
});

const AngleEnum = z.nativeEnum(ScanAngle);

// POST /api/scan/sessions — start a new DRAFT session
router.post("/sessions", async (req: Request, res, next) => {
  try {
    const s = await createScanSession(req.user!.id);
    res.status(201).json({ id: s.id, triggerWord: s.triggerWord, status: s.status });
  } catch (e) { next(e); }
});

// GET /api/scan/sessions — my sessions (brief list)
router.get("/sessions", async (req, res, next) => {
  try {
    const items = await prisma.scanSession.findMany({
      where: { memberId: req.user!.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        images: { where: { deletedAt: null }, select: { angle: true, id: true, width: true, height: true } },
        _count: { select: { images: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

// POST /api/scan/sessions/:id/image — upload one slice (multipart/form-data: file + angle)
router.post(
  "/sessions/:id/image",
  upload.single("file"),
  async (req: Request, res, next) => {
    try {
      const angle = AngleEnum.parse(req.body?.angle ?? "OTHER");
      const forceDeId = req.body?.deIdentify === "true" || req.body?.deIdentify === true;

      const member = await prisma.member.findUnique({ where: { id: req.user!.id } });
      const doDeIdentify = forceDeId || !!member?.deIdentifyDefault;

      if (!req.file) {
        const e: any = new Error("Missing file field 'file'"); e.statusCode = 400; throw e;
      }
      // Downscale to training-res first to save storage/bandwidth.
      const { buffer: scaled, width, height } = await downscaleForTraining(req.file.buffer, 1024);
      const finalBuf = doDeIdentify ? await deIdentifyFace(scaled) : scaled;
      const img = await appendScanImage({
        memberId: req.user!.id,
        scanSessionId: req.params.id,
        angle,
        plaintextBuffer: finalBuf,
        deIdentify: doDeIdentify,
        width, height,
      });
      res.status(201).json({ id: img.id, angle: img.angle, size: img.blobSizeBytes, deIdentified: img.deIdentified });
    } catch (e) { next(e); }
  }
);

// POST /api/scan/sessions/:id/finalize — submit for LoRA training
const FinalizeBody = z.object({
  steps: z.number().int().positive().optional(),
  rank: z.number().int().positive().optional(),
  learningRate: z.number().positive().optional(),
});
router.post("/sessions/:id/finalize", async (req, res, next) => {
  try {
    const body = FinalizeBody.parse(req.body ?? {});
    const out = await finalizeAndSubmitTraining({
      memberId: req.user!.id,
      scanSessionId: req.params.id,
      trainingOpts: body,
    });
    res.json({
      loraId: out.lora.id,
      jobId: out.job.id,
      runpodId: out.runpodResult?.id,
      status: out.lora.status,
      mock: !!out.runpodResult?.mock,
    });
  } catch (e) { next(e); }
});

// DELETE /api/scan/sessions/:id — member cancels/deletes a session
router.delete("/sessions/:id", async (req, res, next) => {
  try {
    const { wipeScanSession } = await import("../services/privacy.service");
    const sess = await prisma.scanSession.findUnique({ where: { id: req.params.id } });
    if (!sess) return res.status(404).json({ error: "Not found" });
    await wipeScanSession({
      scanSessionId: sess.id,
      actorId: req.user!.id,
      actorIsAdmin: req.user!.role === Role.ADMIN,
      ownerMemberId: sess.memberId,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
