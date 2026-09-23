import { PrismaClient, JobStatus, LoRAStatus, ScanSessionStatus, ScanAngle } from "@prisma/client";
import crypto from "crypto";
import {
  encryptAndStore,
  scheduleScanPurge,
  decryptAndRead,
} from "./privacy.service";
import {
  loadBaseWorkflow,
  patchWorkflowImages,
  patchWorkflowTrigger,
  LoRATrainingParams,
} from "./comfy.service";
import {
  submitTrainingJob,
  getJobStatus,
  fetchLoRAArtifact,
} from "./runpod.service";
import { writeAudit } from "../middleware/auditLog";

const prisma = new PrismaClient();

const MANDATORY_ANGLES: ScanAngle[] = [
  ScanAngle.FRONT,
  ScanAngle.ANGLE_45L,
  ScanAngle.ANGLE_45R,
  ScanAngle.PROFILE_L,
  ScanAngle.PROFILE_R,
];

const MAX_IMG = Number(process.env.SCAN_MAX_IMAGES_PER_SESSION ?? 15);

function genTriggerWord() {
  return "sks" + crypto.randomBytes(4).toString("hex");
}

// ===== Scan session lifecycle ============================================

export async function createScanSession(memberId: string) {
  const count = await prisma.scanSession.count({ where: { memberId, deletedAt: null } });
  const triggerWord = genTriggerWord();
  const session = await prisma.scanSession.create({
    data: { memberId, triggerWord },
  });
  await writeAudit({ memberId, actorId: memberId, action: "SCAN_SESSION_CREATE", targetId: session.id, metadata: { index: count + 1 } });
  return session;
}

export async function appendScanImage(params: {
  memberId: string;
  scanSessionId: string;
  angle: ScanAngle;
  plaintextBuffer: Buffer;
  deIdentify: boolean;
  width?: number;
  height?: number;
}) {
  const sess = await prisma.scanSession.findUnique({ where: { id: params.scanSessionId } });
  if (!sess) { const e: any = new Error("Scan session not found"); e.statusCode = 404; throw e; }
  if (sess.memberId !== params.memberId) { const e: any = new Error("Forbidden"); e.statusCode = 403; throw e; }
  if (sess.status !== ScanSessionStatus.DRAFT) {
    const e: any = new Error(`Scan session is already ${sess.status}, not DRAFT`);
    e.statusCode = 409; throw e;
  }
  const count = await prisma.scanImage.count({ where: { scanSessionId: params.scanSessionId, deletedAt: null } });
  if (count >= MAX_IMG) { const e: any = new Error(`Max ${MAX_IMG} images per session`); e.statusCode = 413; throw e; }

  const stored = await encryptAndStore({
    plaintext: params.plaintextBuffer,
    kind: "scan_image",
    memberId: params.memberId,
    filename: `${params.scanSessionId}_${params.angle}_${Date.now()}.jpg.enc`,
  });
  const img = await prisma.scanImage.create({
    data: {
      scanSessionId: params.scanSessionId,
      angle: params.angle,
      blobPath: stored.blobPath,
      blobSha256: stored.blobSha256,
      blobSizeBytes: stored.blobSizeBytes,
      width: params.width,
      height: params.height,
      deIdentified: params.deIdentify,
    },
  });
  await writeAudit({
    memberId: params.memberId,
    actorId: params.memberId,
    action: "SCAN_IMAGE_UPLOAD",
    targetId: params.scanSessionId,
    metadata: { angle: params.angle, size: stored.blobSizeBytes },
  });
  return img;
}

export async function finalizeAndSubmitTraining(params: {
  memberId: string;
  scanSessionId: string;
  trainingOpts?: Partial<LoRATrainingParams>;
}) {
  const sess = await prisma.scanSession.findUnique({
    where: { id: params.scanSessionId },
    include: { images: { where: { deletedAt: null } }, member: true },
  });
  if (!sess) { const e: any = new Error("Not found"); e.statusCode = 404; throw e; }
  if (sess.memberId !== params.memberId) { const e: any = new Error("Forbidden"); e.statusCode = 403; throw e; }
  if (sess.status !== ScanSessionStatus.DRAFT && sess.status !== ScanSessionStatus.FAILED) {
    const e: any = new Error("Session not in DRAFT/FAILED state"); e.statusCode = 409; throw e;
  }
  const presentAngles = new Set(sess.images.map((i) => i.angle));
  const missing = MANDATORY_ANGLES.filter((a) => !presentAngles.has(a));
  if (missing.length > 0) {
    const e: any = new Error(`Missing mandatory angles: ${missing.join(", ")}`);
    e.statusCode = 400;
    throw e;
  }

  // Decrypt all images in-memory to build workflow payloads.
  // Decrypted buffers are never written to disk.
  const imageBuffers: { buffer: Buffer; filename: string }[] = [];
  for (const img of sess.images) {
    const buf = await decryptAndRead({
      blobPath: img.blobPath,
      ownerMemberId: sess.memberId,
      callerId: params.memberId,
      callerIsAdmin: false,
    });
    imageBuffers.push({ buffer: buf, filename: `${img.angle}_${img.id}.jpg` });
  }

  const trigger = sess.triggerWord;
  const deIdentified = sess.images.some((i) => i.deIdentified);

  // Build & patch workflow
  let workflow = await loadBaseWorkflow();
  const patched = await patchWorkflowImages(workflow, { images: imageBuffers });
  workflow = patchWorkflowTrigger(patched.workflow, {
    triggerWord: trigger,
    steps: params.trainingOpts?.steps ?? 2000,
    rank: params.trainingOpts?.rank ?? 16,
    learningRate: params.trainingOpts?.learningRate ?? 1e-4,
    outputName: `lora_${trigger}`,
    ...params.trainingOpts,
  });

  // Create LoRA metadata row + job row
  const lora = await prisma.loRA.create({
    data: {
      memberId: sess.memberId,
      scanSessionId: sess.id,
      triggerWord: trigger,
      status: LoRAStatus.TRAINING,
      trainingSteps: params.trainingOpts?.steps ?? 2000,
      rank: params.trainingOpts?.rank ?? 16,
      learningRate: params.trainingOpts?.learningRate ?? 1e-4,
    },
  });
  const job = await prisma.trainingJob.create({
    data: {
      memberId: sess.memberId,
      scanSessionId: sess.id,
      status: JobStatus.QUEUED,
      provider: "RUNPOD",
      workflowJson: workflow,
    },
  });

  // Dispatch
  let runpodResult: any = null;
  try {
    runpodResult = await submitTrainingJob({
      workflow,
      triggerWord: trigger,
      memberId: sess.memberId,
      scanSessionId: sess.id,
    });
  } catch (e) {
    await prisma.trainingJob.update({ where: { id: job.id }, data: { status: JobStatus.FAILED, errorMessage: String(e), finishedAt: new Date() } });
    await prisma.loRA.update({ where: { id: lora.id }, data: { status: LoRAStatus.FAILED } });
    await prisma.scanSession.update({ where: { id: sess.id }, data: { status: ScanSessionStatus.FAILED, deIdentified } });
    // give the member 72h retry window
    await scheduleScanPurge(sess.id, Number(process.env.SCAN_TTL_AFTER_FAIL_HOURS ?? 72));
    throw e;
  }

  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { runpodJobId: runpodResult.id, status: JobStatus.RUNNING, startedAt: new Date() },
  });
  await prisma.scanSession.update({
    where: { id: sess.id },
    data: { status: ScanSessionStatus.TRAINING, deIdentified, updatedAt: new Date() },
  });

  await writeAudit({
    memberId: params.memberId,
    actorId: params.memberId,
    action: "SCAN_SESSION_FINALIZE",
    targetId: sess.id,
    metadata: { jobId: job.id, runpodId: runpodResult.id },
  });
  await writeAudit({ memberId: params.memberId, actorId: params.memberId, action: "LORA_CREATE", targetId: lora.id });

  // Scheduler: for mock runs we immediately finalize the artifact so E2E flows work
  if (runpodResult.mock || runpodResult.status === "COMPLETED") {
    await completeTrainingFromRunPod({
      scanSessionId: sess.id,
      success: true,
      // mock: no real file, store zero-byte placeholder
      artifactBuffer: Buffer.alloc(0),
    });
  }

  return { scanSession: sess, job, lora, runpodResult };
}

// ===== Training completion handler (called by webhook + polling) =========

export async function completeTrainingFromRunPod(params: {
  scanSessionId: string;
  success: boolean;
  artifactBuffer?: Buffer;
  artifactUrl?: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
}) {
  const sess = await prisma.scanSession.findUnique({
    where: { id: params.scanSessionId },
    include: { job: true, lora: true },
  });
  if (!sess) return null;

  if (!params.success) {
    await prisma.trainingJob.update({
      where: { id: sess.job!.id },
      data: { status: JobStatus.FAILED, errorMessage: params.errorMessage ?? "runpod failed", finishedAt: new Date() },
    });
    if (sess.lora) await prisma.loRA.update({ where: { id: sess.lora.id }, data: { status: LoRAStatus.FAILED } });
    await prisma.scanSession.update({ where: { id: sess.id }, data: { status: ScanSessionStatus.FAILED } });
    const ttl = Number(process.env.SCAN_TTL_AFTER_FAIL_HOURS ?? 72);
    await scheduleScanPurge(sess.id, ttl);
    return { ok: false, ttlHours: ttl };
  }

  let buf = params.artifactBuffer;
  if (!buf && params.artifactUrl) {
    buf = await fetchLoRAArtifact(params.artifactUrl);
  }
  if (!buf) buf = Buffer.alloc(0);

  // Encrypt & store LoRA blob
  const stored = await encryptAndStore({
    plaintext: buf,
    kind: "lora_safetensors",
    memberId: sess.memberId,
    filename: `${sess.triggerWord}.safetensors.enc`,
  });
  const sha = buf.length > 0
    ? crypto.createHash("sha256").update(buf).digest("hex")
    : undefined;

  if (sess.lora) {
    await prisma.loRA.update({
      where: { id: sess.lora.id },
      data: {
        status: LoRAStatus.READY,
        blobPath: stored.blobPath,
        blobSha256: sha ?? stored.blobSha256,
        blobSizeBytes: buf.length || stored.blobSizeBytes,
        updatedAt: new Date(),
      },
    });
  }
  if (sess.job) {
    await prisma.trainingJob.update({
      where: { id: sess.job.id },
      data: { status: JobStatus.SUCCEEDED, finishedAt: new Date() },
    });
  }
  await prisma.scanSession.update({
    where: { id: sess.id },
    data: { status: ScanSessionStatus.COMPLETE, updatedAt: new Date() },
  });

  // Schedule raw scan images for TTL deletion
  const ttl = Number(process.env.SCAN_TTL_AFTER_TRAIN_HOURS ?? 24);
  await scheduleScanPurge(sess.id, ttl);
  return { ok: true, ttlHours: ttl, stored };
}

// ===== Queries ===========================================================

export function listMemberLoRAs(memberId: string) {
  return prisma.loRA.findMany({
    where: { memberId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { scanSession: { select: { id: true, status: true, deIdentified: true, images: { where: { deletedAt: null }, select: { angle: true } } } } },
  });
}

export function getLoRADetail(memberId: string, loraId: string) {
  return prisma.loRA.findFirst({
    where: { id: loraId, memberId, deletedAt: null },
    include: {
      scanSession: { include: { job: true, images: { where: { deletedAt: null }, select: { id: true, angle: true, width: true, height: true } } } },
    },
  });
}

export async function getMemberDashboardSummary(memberId: string) {
  const loras = await prisma.loRA.groupBy({
    by: ["status"],
    where: { memberId, deletedAt: null },
    _count: true,
  });
  const sessions = await prisma.scanSession.count({ where: { memberId, deletedAt: null } });
  const storageBytes = (await prisma.scanImage.aggregate({
    where: { scanSession: { memberId, deletedAt: null }, deletedAt: null },
    _sum: { blobSizeBytes: true },
  })._sum.blobSizeBytes ?? 0) + (
    await prisma.loRA.aggregate({
      where: { memberId, deletedAt: null }, _sum: { blobSizeBytes: true },
    })._sum.blobSizeBytes ?? 0
  );
  return {
    loraCounts: Object.fromEntries(loras.map((g) => [g.status, g._count])) as Record<string, number>,
    scanSessions: sessions,
    storageBytes,
  };
}
