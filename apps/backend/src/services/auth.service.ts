import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { PrismaClient, Role } from "@prisma/client";
import { signAccessToken, signRefreshToken } from "../middleware/authGuard";
import { writeAudit } from "../middleware/auditLog";

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET as string;

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

async function isAdminEmail(email: string) {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function seedAdminIfNeeded() {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const email of list) {
    const exists = await prisma.member.findUnique({ where: { email } });
    if (!exists) {
      const tempPw = process.env.DEFAULT_ADMIN_PASSWORD ?? crypto.randomBytes(12).toString("hex");
      const hash = await hashPassword(tempPw);
      await prisma.member.create({
        data: { email, passwordHash: hash, role: Role.ADMIN },
      });
      console.log(`[auth] seeded admin ${email} — password = ${tempPw} (set DEFAULT_ADMIN_PASSWORD env to choose)`);
    } else if (exists.role !== Role.ADMIN) {
      await prisma.member.update({ where: { id: exists.id }, data: { role: Role.ADMIN } });
      console.log(`[auth] promoted ${email} to admin`);
    }
  }
}

export async function registerMember(params: {
  email: string;
  password: string;
  privacyConsent: boolean;
  ip?: string;
  userAgent?: string;
}) {
  if (!params.privacyConsent) {
    const err: any = new Error("Privacy consent is required");
    err.statusCode = 400;
    throw err;
  }
  const email = params.email.toLowerCase().trim();
  const existing = await prisma.member.findUnique({ where: { email } });
  if (existing) {
    const err: any = new Error("Email already registered");
    err.statusCode = 409;
    throw err;
  }
  const passwordHash = await hashPassword(params.password);
  const role = (await isAdminEmail(email)) ? Role.ADMIN : Role.MEMBER;
  const member = await prisma.member.create({
    data: {
      email,
      passwordHash,
      role,
      privacyConsentAt: new Date(),
    },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  await writeAudit({
    memberId: member.id,
    actorId: member.id,
    action: "REGISTER",
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  return member;
}

export async function loginMember(params: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}) {
  const email = params.email.toLowerCase().trim();
  const member = await prisma.member.findUnique({ where: { email } });
  if (!member) {
    const err: any = new Error("Invalid credentials");
    err.statusCode = 401;
    throw err;
  }
  const ok = await verifyPassword(params.password, member.passwordHash);
  if (!ok) {
    const err: any = new Error("Invalid credentials");
    err.statusCode = 401;
    throw err;
  }
  const access = signAccessToken({ id: member.id, role: member.role });
  const refreshToken = signRefreshToken({ id: member.id });
  const refreshHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  const ttlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 7);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);

  await prisma.refreshSession.create({
    data: {
      memberId: member.id,
      tokenHash: refreshHash,
      ip: params.ip,
      userAgent: params.userAgent,
      expiresAt,
    },
  });
  await prisma.member.update({
    where: { id: member.id },
    data: { lastActiveAt: new Date() },
  });
  await writeAudit({
    memberId: member.id,
    actorId: member.id,
    action: "LOGIN",
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });
  return { access, refresh: refreshToken, member: { id: member.id, email: member.email, role: member.role } };
}

export async function refreshAccessToken(refreshToken: string) {
  if (!refreshToken) {
    const err: any = new Error("Missing refresh token");
    err.statusCode = 401;
    throw err;
  }
  const refreshHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash: refreshHash },
    include: { member: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    const err: any = new Error("Invalid refresh token");
    err.statusCode = 401;
    throw err;
  }
  const decoded = jwt.verify(refreshToken, JWT_SECRET) as any;
  if (decoded.id !== session.memberId) {
    const err: any = new Error("Token mismatch");
    err.statusCode = 401;
    throw err;
  }
  const access = signAccessToken({ id: session.member.id, role: session.member.role });
  await writeAudit({
    memberId: session.member.id,
    actorId: session.member.id,
    action: "REFRESH_TOKEN",
  });
  return { access };
}

export async function logoutAll(memberId: string) {
  await prisma.refreshSession.updateMany({
    where: { memberId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await writeAudit({ memberId, actorId: memberId, action: "REVOKE_TOKENS" });
}
