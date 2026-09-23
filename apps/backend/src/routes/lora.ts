import { Router, Request, Response } from "express";
import { PrismaClient, Role, LoRAStatus } from "@prisma/client";
import { listMemberLoRAs, getLoRADetail } from "../services/lora.service";
import { decryptAndRead, wipeLoRA } from "../services/privacy.service";
import { z } from "zod";
import { writeAudit } from "../middleware/auditLog";

const prisma = new PrismaClient();
const router = Router();

// GET /api/lora — member's LoRA library
router.get("/", async (req, res, next) => {
  try {
    const items = await listMemberLoRAs(req.user!.id);
    res.json({ items });
  } catch (e) { next(e); }
});

// GET /api/lora/:id — detail
router.get("/:id", async (req, res, next) => {
  try {
    const lora = await getLoRADetail(req.user!.id, req.params.id);
    if (!lora) return res.status(404).json({ error: "Not found" });
    res.json(lora);
  } catch (e) { next(e); }
});

// GET /api/lora/:id/download — stream encrypted→decrypted safetensors
router.get("/:id/download", async (req, res, next) => {
  try {
    const lora = await prisma.loRA.findFirst({ where: { id: req.params.id, memberId: req.user!.id, deletedAt: null } });
    if (!lora) return res.status(404).json({ error: "Not found" });
    if (lora.status !== LoRAStatus.READY || !lora.blobPath) return res.status(409).json({ error: "LoRA not ready" });

    const buf = await decryptAndRead({
      blobPath: lora.blobPath,
      ownerMemberId: lora.memberId,
      callerId: req.user!.id,
      callerIsAdmin: req.user!.role === Role.ADMIN,
    });
    await writeAudit({
      memberId: req.user!.id,
      actorId: req.user!.id,
      action: "LORA_DOWNLOAD",
      targetId: lora.id,
      metadata: { bytes: buf.length },
    });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${lora.triggerWord}.safetensors"`);
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  } catch (e) { next(e); }
});

// DELETE /api/lora/:id — member revokes/deletes their LoRA + associated scans
router.delete("/:id", async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const lora = await prisma.loRA.findFirst({ where: { id: req.params.id, memberId: req.user!.id, deletedAt: null } });
    if (!lora) return res.status(404).json({ error: "Not found" });
    await wipeLoRA({
      loraId: lora.id,
      actorId: req.user!.id,
      actorIsAdmin: req.user!.role === Role.ADMIN,
      ownerMemberId: lora.memberId,
      reason: body.reason,
    });
    // Also wipe the raw scan images that produced this LoRA (optional but recommended by privacy plan)
    const { wipeScanSession } = await import("../services/privacy.service");
    await wipeScanSession({
      scanSessionId: lora.scanSessionId,
      actorId: req.user!.id,
      actorIsAdmin: req.user!.role === Role.ADMIN,
      ownerMemberId: lora.memberId,
      reason: body.reason ?? "lora-deleted-cascade",
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/lora/:id/revoke — set status to REVOKED (artifact stays for audit, cannot download)
router.post("/:id/revoke", async (req, res, next) => {
  try {
    const lora = await prisma.loRA.findFirst({ where: { id: req.params.id, memberId: req.user!.id, deletedAt: null } });
    if (!lora) return res.status(404).json({ error: "Not found" });
    await prisma.loRA.update({ where: { id: lora.id }, data: { status: LoRAStatus.REVOKED, updatedAt: new Date() } });
    await writeAudit({ memberId: req.user!.id, actorId: req.user!.id, action: "LORA_REVOKE", targetId: lora.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
