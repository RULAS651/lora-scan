import { Router, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { ScanAngle, ScanDistance, ImageSource, Role } from "@prisma/client";
import {
  PHOTO_GUIDANCE,
  VIDEO_GUIDANCE,
  SHOT_PLAN,
  PLAN_TOTAL,
  checkSet,
  readinessMessage,
  type PhotoVerdict,
} from "@lora-scan/face-qc";
import {
  createScanSession,
  appendScanImage,
  finalizeAndSubmitTraining,
} from "../services/lora.service";
import { deIdentifyFace, downscaleForTraining } from "../services/privacy.service";
import { qcPhoto, qcSet, shouldRefuse, activeThresholds } from "../services/photoQc.service";
import { getFaceDetector } from "../services/faceDetect.service";
import { scanVideo, spreadOverTime } from "../services/videoShoot.service";
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

/** Dry-run QC takes a whole set at once; nothing here is stored. */
const QC_MAX_FILES = Number(process.env.SCAN_QC_MAX_FILES ?? 60);
const qcUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: QC_MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype);
    cb(ok ? null : (Object.assign(new Error("Only JPEG/PNG allowed"), { statusCode: 400 }) as any), ok);
  },
});

const MAX_VIDEO_MB = Number(process.env.SCAN_MAX_VIDEO_SIZE_MB ?? 200);
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("video/");
    cb(ok ? null : (Object.assign(new Error("Upload a video file"), { statusCode: 400 }) as any), ok);
  },
});

const AngleEnum = z.nativeEnum(ScanAngle);
const DistanceEnum = z.nativeEnum(ScanDistance);

/** Angles a frontal detector genuinely cannot read — a miss there is expected. */
const FACELESS_ANGLES: ScanAngle[] = [ScanAngle.PROFILE_L, ScanAngle.PROFILE_R, ScanAngle.BACK];

function faceExpectedFor(angle: ScanAngle, distance: ScanDistance): boolean {
  if (FACELESS_ANGLES.includes(angle)) return false;
  // A distant full-body frame often reads, but not reliably; never block on it.
  if (distance === ScanDistance.FULL_BODY) return false;
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/scan/guidance — the shot plan, the rules and the live thresholds.
//
// Served rather than hardcoded in the client so the capture UI, this API and
// any bot front-end cannot drift apart on what a good photo is.
// ---------------------------------------------------------------------------
router.get("/guidance", (_req, res) => {
  const detector = getFaceDetector();
  res.json({
    photo: PHOTO_GUIDANCE,
    video: VIDEO_GUIDANCE,
    plan: SHOT_PLAN,
    planTotal: PLAN_TOTAL,
    thresholds: activeThresholds(),
    detector: { name: detector.name, authoritative: detector.authoritative },
  });
});

// ---------------------------------------------------------------------------
// POST /api/scan/qc — check photos WITHOUT storing them.
//
// Cheap next to a training run, and the failure it catches (face fills the
// frame -> zero detections -> a LoRA of a stranger) is invisible otherwise.
// Answered synchronously: a check that returns a job id nobody polls is a
// button that reports nothing.
// ---------------------------------------------------------------------------
router.post("/qc", qcUpload.array("files", QC_MAX_FILES), async (req: Request, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      const e: any = new Error("Attach at least one image as 'files'"); e.statusCode = 400; throw e;
    }
    const verdict = await qcSet(
      files.map((f) => ({ buffer: f.buffer, label: f.originalname || "photo.jpg" })),
    );
    res.json({ ...verdict, message: readinessMessage(verdict.usable, activeThresholds()) });
  } catch (e) { next(e); }
});

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
        images: {
          where: { deletedAt: null },
          select: {
            angle: true, distance: true, source: true, id: true,
            width: true, height: true, qcSeverity: true,
          },
        },
        _count: { select: { images: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// GET /api/scan/sessions/:id/readiness — is this set good enough to train?
//
// Read back from the QC recorded at upload. Counts usable FACES rather than
// demanding zero rejections: the shot plan asks for profiles, backs and
// full-body frames that a frontal detector cannot read, so a rule of "ready =
// nothing rejected" would make the documented plan impossible to satisfy.
// ---------------------------------------------------------------------------
router.get("/sessions/:id/readiness", async (req, res, next) => {
  try {
    const sess = await prisma.scanSession.findUnique({ where: { id: req.params.id } });
    if (!sess || sess.deletedAt) return res.status(404).json({ error: "Not found" });
    if (sess.memberId !== req.user!.id && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const images = await prisma.scanImage.findMany({
      where: { scanSessionId: sess.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

    const verdicts: PhotoVerdict[] = images.map((img) => ({
      file: img.id,
      severity: (img.qcSeverity as PhotoVerdict["severity"]) ?? "unknown",
      ok: img.qcSeverity !== "reject",
      width: img.width ?? 0,
      height: img.height ?? 0,
      faces: img.qcFaces ?? undefined,
      facePx: img.qcFacePx ?? undefined,
      faceAreaPct: img.qcFaceAreaPct ?? undefined,
      strong:
        img.qcSeverity !== "reject" &&
        (img.qcFacePx ?? 0) >= activeThresholds().minFacePx,
      reasons: img.qcReasons ? (JSON.parse(img.qcReasons) as string[]) : [],
    }));

    const summary = checkSet(verdicts, activeThresholds());

    // Coverage against the plan, so the UI can say WHICH group is short rather
    // than only that the total is low.
    const have = new Map<string, number>();
    for (const img of images) {
      const key = `${img.distance}:${img.angle}`;
      have.set(key, (have.get(key) ?? 0) + 1);
    }
    const coverage = SHOT_PLAN.map((g) => {
      const got = g.angles.reduce((n, a) => n + (have.get(`${g.distance}:${a}`) ?? 0), 0);
      return { id: g.id, label: g.label, want: g.count, got, done: got >= g.count };
    });

    res.json({
      sessionId: sess.id,
      status: sess.status,
      summary,
      coverage,
      message: readinessMessage(summary.usable, activeThresholds()),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// POST /api/scan/sessions/:id/image — upload one slice
// (multipart/form-data: file + angle [+ distance, source, deIdentify])
//
// QC runs BEFORE storage. The browser gate cannot be trusted here: it is
// skipped entirely on the file-upload path, and it runs a different detector
// than the trainer, so a photo can look fine in the camera view and still
// contribute nothing to the run.
// ---------------------------------------------------------------------------
router.post(
  "/sessions/:id/image",
  upload.single("file"),
  async (req: Request, res, next) => {
    try {
      const angle = AngleEnum.parse(req.body?.angle ?? "OTHER");
      const distance = DistanceEnum.parse(req.body?.distance ?? "CLOSEUP");
      const source = req.body?.source === "CAMERA" ? ImageSource.CAMERA : ImageSource.UPLOAD;
      const forceDeId = req.body?.deIdentify === "true" || req.body?.deIdentify === true;
      // Escape hatch for a frame the user insists on despite the verdict —
      // recorded, never silent.
      const override = req.body?.acceptAnyway === "true" || req.body?.acceptAnyway === true;

      const member = await prisma.member.findUnique({ where: { id: req.user!.id } });
      const doDeIdentify = forceDeId || !!member?.deIdentifyDefault;

      if (!req.file) {
        const e: any = new Error("Missing file field 'file'"); e.statusCode = 400; throw e;
      }

      // Downscale to training-res first to save storage/bandwidth. QC runs on
      // the SAME buffer that gets stored, so the verdict describes what the
      // trainer will actually see rather than a larger original.
      const { buffer: scaled, width, height } = await downscaleForTraining(req.file.buffer, 1024);

      const detector = getFaceDetector();
      const verdict = await qcPhoto({
        buffer: scaled,
        label: req.file.originalname || `${angle}.jpg`,
      });

      const faceExpected = faceExpectedFor(angle, distance);
      if (!override && shouldRefuse(verdict, { faceExpected })) {
        return res.status(422).json({
          error: "framing_rejected",
          message: verdict.reasons[0],
          verdict,
          // The client can retry with acceptAnyway=true; the flag is surfaced
          // here so a UI can offer "use it anyway" instead of a dead end.
          overridable: true,
        });
      }

      const finalBuf = doDeIdentify ? await deIdentifyFace(scaled) : scaled;
      const img = await appendScanImage({
        memberId: req.user!.id,
        scanSessionId: req.params.id,
        angle,
        distance,
        source,
        plaintextBuffer: finalBuf,
        deIdentify: doDeIdentify,
        width, height,
        qc: verdict,
        qcDetector: detector.name,
        qcAuthoritative: detector.authoritative,
      });

      res.status(201).json({
        id: img.id,
        angle: img.angle,
        distance: img.distance,
        size: img.blobSizeBytes,
        deIdentified: img.deIdentified,
        verdict,
        accepted_despite_verdict: override && verdict.severity === "reject",
      });
    } catch (e) { next(e); }
  }
);

// ---------------------------------------------------------------------------
// POST /api/scan/sessions/:id/video — the video shoot
// (multipart/form-data: file [+ keep, fps, distance, deIdentify])
//
// One slow turn in front of a camera becomes a set. Asking someone for 25
// deliberate photos loses most of them partway through; asking for a 20-second
// turn does not. Every extracted frame passes the same framing rules — coming
// from a video buys no leniency.
// ---------------------------------------------------------------------------
const VideoQuery = z.object({
  keep: z.coerce.number().int().min(1).max(60).optional(),
  fps: z.coerce.number().positive().max(10).optional(),
});

router.post(
  "/sessions/:id/video",
  videoUpload.single("file"),
  async (req: Request, res, next) => {
    try {
      if (!req.file) {
        const e: any = new Error("Missing video field 'file'"); e.statusCode = 400; throw e;
      }
      const { keep = 20, fps } = VideoQuery.parse(req.body ?? {});
      const distance = DistanceEnum.parse(req.body?.distance ?? "UPPER_BODY");
      const forceDeId = req.body?.deIdentify === "true" || req.body?.deIdentify === true;
      const dryRun = req.body?.dryRun === "true" || req.body?.dryRun === true;

      const member = await prisma.member.findUnique({ where: { id: req.user!.id } });
      const doDeIdentify = forceDeId || !!member?.deIdentifyDefault;

      const scan = await scanVideo(req.file.buffer, fps ? { fps } : {});

      // Spread the kept frames across the whole clip rather than taking the
      // top N by face size: a 1.5fps sample of a slow turn produces runs of
      // near-identical frames, and a set full of one pose has learned one pose.
      const chosen = spreadOverTime(scan.keepers, keep);

      if (dryRun) {
        return res.json({
          extracted: scan.extracted,
          fps: scan.fps,
          usable: scan.keepers.length,
          would_keep: chosen.length,
          summary: scan.summary,
          frames: scan.all.map((f) => ({ index: f.index, verdict: f.verdict })),
        });
      }

      const detector = getFaceDetector();
      const stored: any[] = [];
      for (const frame of chosen) {
        const { buffer: scaled, width, height } = await downscaleForTraining(frame.buffer, 1024);
        const finalBuf = doDeIdentify ? await deIdentifyFace(scaled) : scaled;
        const img = await appendScanImage({
          memberId: req.user!.id,
          scanSessionId: req.params.id,
          // A turn passes through every angle and the frame index does not say
          // which; OTHER is honest. Angle is a hint for coverage reporting, and
          // a wrong label is worse than an absent one.
          angle: ScanAngle.OTHER,
          distance,
          source: ImageSource.VIDEO,
          plaintextBuffer: finalBuf,
          deIdentify: doDeIdentify,
          width, height,
          qc: frame.verdict,
          qcDetector: detector.name,
          qcAuthoritative: detector.authoritative,
        });
        stored.push({ id: img.id, index: frame.index, verdict: frame.verdict });
      }

      res.status(201).json({
        extracted: scan.extracted,
        fps: scan.fps,
        usable: scan.keepers.length,
        stored: stored.length,
        images: stored,
        summary: scan.summary,
      });
    } catch (e) { next(e); }
  }
);

// POST /api/scan/sessions/:id/finalize — submit for LoRA training
const FinalizeBody = z.object({
  steps: z.number().int().positive().optional(),
  rank: z.number().int().positive().optional(),
  learningRate: z.number().positive().optional(),
  /** Train on a set QC says is short. Recorded in the response. */
  force: z.boolean().optional(),
});
router.post("/sessions/:id/finalize", async (req, res, next) => {
  try {
    const body = FinalizeBody.parse(req.body ?? {});

    // Refuse to burn a training run on a set that cannot teach a face. This is
    // the cheapest possible place to catch it — after training, the only
    // remedy is to shoot again and pay again.
    const images = await prisma.scanImage.findMany({
      where: { scanSessionId: req.params.id, deletedAt: null },
      select: { qcSeverity: true, qcFacePx: true },
    });
    const t = activeThresholds();
    const usable = images.filter((i) => i.qcSeverity !== "reject").length;
    // Sets uploaded before QC existed have no severity at all; do not block
    // those on a check that never ran.
    const checked = images.some((i) => i.qcSeverity && i.qcSeverity !== "unknown");
    if (!body.force && checked && usable < t.minUsable) {
      return res.status(422).json({
        error: "set_not_ready",
        message: readinessMessage(usable, t),
        usable,
        minUsable: t.minUsable,
        overridable: true,
      });
    }

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
      usable,
      forced: !!body.force && usable < t.minUsable,
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
