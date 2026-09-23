import { Request, Response, NextFunction } from "express";
import { PrismaClient, AuditAction } from "@prisma/client";

const prisma = new PrismaClient();

type Resolved = {
  action: AuditAction;
  targetId?: string | null;
  extra?: Record<string, any>;
};

export type AuditDecideFn = (
  req: Request,
  res: Response
) => Resolved | Promise<Resolved> | null;

/**
 * Attach an audit log entry AFTER the response has finished.
 * Pass a decide fn that returns the action + target id based on req/res.
 */
export function auditLog(decide: AuditDecideFn) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", async () => {
      try {
        const resolved = await decide(req, res);
        if (!resolved) return;
        const memberId = req.user?.id ?? null;
        const actorId = memberId;
        await prisma.auditLog.create({
          data: {
            memberId,
            actorId,
            action: resolved.action,
            targetId: resolved.targetId ?? undefined,
            ip: req.ip ?? undefined,
            userAgent: req.headers["user-agent"] ?? undefined,
            metadata: resolved.extra ?? undefined,
          },
        });
      } catch (e) {
        console.error("[audit] write failed:", e);
      }
    });
    next();
  };
}

/**
 * One-off audit writer (for use in service layer, outside request lifecycle).
 */
export async function writeAudit(params: {
  memberId?: string | null;
  actorId?: string | null;
  action: AuditAction;
  targetId?: string | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, any> | null;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        memberId: params.memberId ?? undefined,
        actorId: params.actorId ?? undefined,
        action: params.action,
        targetId: params.targetId ?? undefined,
        reason: params.reason ?? undefined,
        ip: params.ip ?? undefined,
        userAgent: params.userAgent ?? undefined,
        metadata: params.metadata ?? undefined,
      },
    });
  } catch (e) {
    console.error("[audit] service write failed:", e);
  }
}
