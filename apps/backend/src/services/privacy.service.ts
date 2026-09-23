import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient, ScanSessionStatus, LoRAStatus } from "@prisma/client";
import { writeAudit } from "../middleware/auditLog";
import sharp from "sharp";

const prisma = new PrismaClient();

const STORAGE_ROOT = path.resolve(__dirname, "../../storage");
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16; // GCM auth tag length

// ===== Key management ====================================================

function loadKeys() {
  const curB64 = process.env.ENCRYPTION_KEY;
  if (!curB64) throw new Error("ENCRYPTION_KEY env is required (32-byte base64)");
  const keys = [Buffer.from(curB64, "base64")];
  if (keys[0].length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  const prevB64 = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (prevB64) {
    const prev = Buffer.from(prevB64, "base64");
    if (prev.length !== 32) throw new Error("ENCRYPTION_KEY_PREVIOUS must be 32 bytes");
    keys.push(prev);
  }
  return keys;
}

// ===== Member-scoped key derivation ======================================
// Derive a per-member key with HKDF so the master key isn't used directly.
function deriveMemberKey(masterKey: Buffer, memberId: string) {
  // hkdfSync, not createHkdf (which does not exist), and it hands back an
  // ArrayBuffer -- everything downstream expects a Buffer.
  return Buffer.from(
    crypto.hkdfSync("sha256", masterKey, Buffer.from("member-key-salt"), Buffer.from(memberId), 32),
  );
}

// ===== Low-level crypto ==================================================

function aesGcmEncrypt(plaintext: Buffer, memberKey: Buffer) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", memberKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout on disk: [ 1 byte version | 12 bytes IV | 16 bytes TAG | ciphertext ]
  const version = Buffer.from([1]);
  return Buffer.concat([version, iv, tag, ciphertext]);
}

function aesGcmDecrypt(blob: Buffer, memberKey: Buffer) {
  if (blob[0] !== 1) throw new Error("Unknown blob version");
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", memberKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ===== High-level blob storage ===========================================

export type BlobKind = "scan_image" | "lora_safetensors";

function blobRelPath(kind: BlobKind, memberId: string, filename: string) {
  // partition by member id for easy wipe
  return path.posix.join(kind, memberId.slice(0, 2), memberId, filename);
}

function absPath(rel: string) {
  return path.join(STORAGE_ROOT, ...rel.split(path.posix.sep));
}

async function ensureDirFor(absFile: string) {
  const d = path.dirname(absFile);
  await fs.mkdir(d, { recursive: true });
}

export interface EncryptAndStoreResult {
  blobPath: string;
  blobSha256: string;
  blobSizeBytes: number;
}

/**
 * Encrypt a plaintext buffer per-member and write it to storage.
 * The plaintext is NEVER written to disk.
 */
export async function encryptAndStore(params: {
  plaintext: Buffer;
  kind: BlobKind;
  memberId: string;
  filename: string;
}): Promise<EncryptAndStoreResult> {
  const [masterKey] = loadKeys();
  const memberKey = deriveMemberKey(masterKey, params.memberId);
  const ciphertext = aesGcmEncrypt(params.plaintext, memberKey);

  const rel = blobRelPath(params.kind, params.memberId, params.filename);
  const abs = absPath(rel);
  await ensureDirFor(abs);
  await fs.writeFile(abs, ciphertext);

  const sha = crypto.createHash("sha256").update(ciphertext).digest("hex");
  return {
    blobPath: rel,
    blobSha256: sha,
    blobSizeBytes: ciphertext.length,
  };
}

/**
 * Decrypt and return plaintext buffer.  NEVER cached on disk.
 * Throws if callerId !== owner of the blob AND caller is not admin.
 */
export async function decryptAndRead(params: {
  blobPath: string;
  ownerMemberId: string;
  callerId: string;
  callerIsAdmin: boolean;
}): Promise<Buffer> {
  if (params.callerId !== params.ownerMemberId && !params.callerIsAdmin) {
    const err: any = new Error("Access denied: caller is not blob owner or admin");
    err.statusCode = 403;
    throw err;
  }
  const abs = absPath(params.blobPath);
  let ciphertext: Buffer;
  try {
    ciphertext = await fs.readFile(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      const err: any = new Error("Blob not found (possibly purged)");
      err.statusCode = 410;
      throw err;
    }
    throw e;
  }
  const masterKeys = loadKeys();
  let lastErr: unknown = null;
  for (const mk of masterKeys) {
    try {
      const memberKey = deriveMemberKey(mk, params.ownerMemberId);
      return aesGcmDecrypt(ciphertext, memberKey);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Decrypt failed");
}

/**
 * Hard delete a specific encrypted blob on disk + in DB.
 */
export async function purgeBlob(relPath: string) {
  const abs = absPath(relPath);
  try { await fs.unlink(abs); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
}

// ===== Face de-identification (opt-in) ===================================
// Uses Sharp to pixelate the detected face region.
// MediaPipe face detection is optional; if unavailable we pixelate the
// center 60% of the image as a fallback.
export async function deIdentifyFace(input: Buffer, faceBbox?: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const imgW = meta.width ?? 512;
  const imgH = meta.height ?? 512;
  const bbox = faceBbox ?? {
    x: Math.round(imgW * 0.2),
    y: Math.round(imgH * 0.15),
    w: Math.round(imgW * 0.6),
    h: Math.round(imgH * 0.7),
  };
  const cloned = await sharp(input).toBuffer();
  const faceCrop = await sharp(cloned)
    .extract({ left: clamp(bbox.x, 0, imgW - 1), top: clamp(bbox.y, 0, imgH - 1),
               width: clamp(bbox.w, 1, imgW - bbox.x), height: clamp(bbox.h, 1, imgH - bbox.y) })
    .resize(16, 16, { kernel: "nearest" })
    .resize(bbox.w, bbox.h, { kernel: "nearest" })
    .png()
    .toBuffer();

  const composed = await sharp(cloned)
    .composite([{ input: faceCrop, left: bbox.x, top: bbox.y }])
    .toFormat("jpeg", { quality: 90 })
    .toBuffer();
  return composed;
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

// ===== Scan image resize (LoRA training doesn't need hi-res) =============
export async function downscaleForTraining(buf: Buffer, maxPx = 1024): Promise<{ buffer: Buffer; width: number; height: number }> {
  const s = sharp(buf);
  const meta = await s.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const longSide = Math.max(w, h);
  if (longSide <= maxPx) {
    return { buffer: buf, width: w, height: h };
  }
  const scale = maxPx / longSide;
  const out = await s.resize(Math.round(w * scale), Math.round(h * scale), { fit: "inside" }).toFormat("jpeg", { quality: 92 }).toBuffer();
  const outMeta = await sharp(out).metadata();
  return { buffer: out, width: outMeta.width ?? 0, height: outMeta.height ?? 0 };
}

// ===== TTL scheduling + purge sweeper ====================================

export function scheduleScanPurge(scanSessionId: string, hoursFromNow: number) {
  const when = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  return prisma.scanSession.update({
    where: { id: scanSessionId },
    data: { purgeScheduledAt: when },
  });
}

/**
 * Walk all ScanSessions whose purgeScheduledAt has passed and
 * (1) delete the on-disk encrypted blobs,
 * (2) mark ScanImage rows deleted,
 * (3) bump session status to PURGED,
 * (4) write audit log.
 * Runs hourly via cron from server.ts
 */
export async function runPurgeExpiredScans() {
  const now = new Date();
  const due = await prisma.scanSession.findMany({
    where: {
      purgeScheduledAt: { lte: now },
      status: { notIn: ["DELETED", "PURGED"] },
      deletedAt: null,
    },
    include: { images: true, member: { select: { id: true } } },
  });
  for (const sess of due) {
    try {
      for (const img of sess.images) {
        if (!img.deletedAt) {
          try { await purgeBlob(img.blobPath); } catch (e) { console.error("[purge] blob:", e); }
          await prisma.scanImage.update({ where: { id: img.id }, data: { deletedAt: now } });
        }
      }
      await prisma.scanSession.update({
        where: { id: sess.id },
        data: { status: ScanSessionStatus.PURGED, updatedAt: now },
      });
      await writeAudit({
        memberId: sess.member.id,
        actorId: null,
        action: "SCAN_SESSION_PURGE_TTL",
        targetId: sess.id,
        metadata: { reason: "ttl-expired" },
      });
    } catch (e) {
      console.error(`[purge] session ${sess.id}:`, e);
    }
  }
}

// ===== Member / Admin hard delete ========================================

export async function wipeScanSession(params: {
  scanSessionId: string;
  actorId: string;
  actorIsAdmin: boolean;
  ownerMemberId: string;
  reason?: string;
}) {
  if (params.actorId !== params.ownerMemberId && !params.actorIsAdmin) {
    const err: any = new Error("Forbidden"); err.statusCode = 403; throw err;
  }
  const sess = await prisma.scanSession.findUnique({
    where: { id: params.scanSessionId },
    include: { images: true },
  });
  if (!sess) { const e: any = new Error("Not found"); e.statusCode = 404; throw e; }
  for (const img of sess.images) {
    if (!img.deletedAt) {
      try { await purgeBlob(img.blobPath); } catch {}
      await prisma.scanImage.update({ where: { id: img.id }, data: { deletedAt: new Date() } });
    }
  }
  await prisma.scanSession.update({
    where: { id: sess.id },
    data: { status: ScanSessionStatus.DELETED, deletedAt: new Date(), updatedAt: new Date() },
  });
  await writeAudit({
    memberId: params.ownerMemberId,
    actorId: params.actorId,
    action: params.actorIsAdmin ? "ADMIN_FORCE_DELETE_SCANS" : "MEMBER_SELF_DELETE",
    targetId: sess.id,
    reason: params.reason ?? null,
  });
}

export async function wipeLoRA(params: {
  loraId: string;
  actorId: string;
  actorIsAdmin: boolean;
  ownerMemberId: string;
  reason?: string;
}) {
  if (params.actorId !== params.ownerMemberId && !params.actorIsAdmin) {
    const err: any = new Error("Forbidden"); err.statusCode = 403; throw err;
  }
  const lora = await prisma.loRA.findUnique({ where: { id: params.loraId } });
  if (!lora) { const e: any = new Error("Not found"); e.statusCode = 404; throw e; }
  if (lora.blobPath) {
    try { await purgeBlob(lora.blobPath); } catch {}
  }
  await prisma.loRA.update({
    where: { id: lora.id },
    data: { status: LoRAStatus.DELETED, deletedAt: new Date(), blobPath: null, updatedAt: new Date() },
  });
  await writeAudit({
    memberId: params.ownerMemberId,
    actorId: params.actorId,
    action: params.actorIsAdmin ? "ADMIN_FORCE_DELETE_LORA" : "LORA_REVOKE",
    targetId: lora.id,
    reason: params.reason ?? null,
  });
}

export async function wipeMemberAccount(params: {
  memberId: string;
  actorId: string;
  actorIsAdmin: boolean;
  reason?: string;
}) {
  if (params.actorId !== params.memberId && !params.actorIsAdmin) {
    const err: any = new Error("Forbidden"); err.statusCode = 403; throw err;
  }
  const loras = await prisma.loRA.findMany({ where: { memberId: params.memberId } });
  for (const l of loras) {
    await wipeLoRA({ loraId: l.id, actorId: params.actorId, actorIsAdmin: params.actorIsAdmin, ownerMemberId: params.memberId, reason: params.reason ?? "wipe-account" });
  }
  const sessions = await prisma.scanSession.findMany({ where: { memberId: params.memberId } });
  for (const s of sessions) {
    await wipeScanSession({ scanSessionId: s.id, actorId: params.actorId, actorIsAdmin: params.actorIsAdmin, ownerMemberId: params.memberId, reason: params.reason ?? "wipe-account" });
  }
  await prisma.member.update({
    where: { id: params.memberId },
    data: { email: `deleted-${params.memberId}@invalid.invalid`, passwordHash: "-", lastActiveAt: new Date() },
  });
  await writeAudit({
    memberId: params.memberId,
    actorId: params.actorId,
    action: params.actorIsAdmin ? "ADMIN_WIPE_MEMBER" : "MEMBER_WIPE_ACCOUNT",
    reason: params.reason ?? null,
  });
}
