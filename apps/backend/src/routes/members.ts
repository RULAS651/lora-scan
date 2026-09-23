import { Router, Request, Response } from "express";
import { z } from "zod";
import { PrismaClient, Role } from "@prisma/client";
import { getMemberDashboardSummary, wipeMemberAccount } from "../services/lora.service";
import { auditLog } from "../middleware/auditLog";
import { writeAudit } from "../middleware/auditLog";

const prisma = new PrismaClient();
const router = Router();

const WipeBody = z.object({ reason: z.string().optional() });

// GET /api/members/me — profile + summary
router.get("/me",
  auditLog(() => null),
  async (req: Request, res: Response, next) => {
    try {
      const m = await prisma.member.findUnique({
        where: { id: req.user!.id },
        select: { id: true, email: true, role: true, deIdentifyDefault: true, ttlHoursOverride: true, createdAt: true, lastActiveAt: true, privacyConsentAt: true },
      });
      if (!m) return res.status(404).json({ error: "Not found" });
      const summary = await getMemberDashboardSummary(m.id);
      res.json({ member: m, summary });
    } catch (e) { next(e); }
  }
);

// PATCH /api/members/me — update privacy defaults
const PatchBody = z.object({
  deIdentifyDefault: z.boolean().optional(),
  ttlHoursOverride: z.number().int().min(1).max(24 * 30).nullable().optional(),
});
router.patch("/me", async (req, res, next) => {
  try {
    const body = PatchBody.parse(req.body);
    const updated = await prisma.member.update({
      where: { id: req.user!.id },
      data: body,
      select: { id: true, deIdentifyDefault: true, ttlHoursOverride: true },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// POST /api/members/me/wipe-account — GDPR/CCPA "right to erasure"
router.post("/me/wipe-account", async (req, res, next) => {
  try {
    const body = WipeBody.parse(req.body);
    await wipeMemberAccount({
      memberId: req.user!.id,
      actorId: req.user!.id,
      actorIsAdmin: req.user!.role === Role.ADMIN,
      reason: body.reason,
    });
    // also revoke all sessions
    await prisma.refreshSession.updateMany({ where: { memberId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/members/me/audits — view my own audit trail (last 200)
router.get("/me/audits", async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { memberId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, action: true, targetId: true, reason: true, createdAt: true, metadata: true },
    });
    res.json({ items: logs });
  } catch (e) { next(e); }
});

export default router;
