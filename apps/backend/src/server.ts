import dotenv from "dotenv";
dotenv.config({ path: `${process.cwd()}/../../.env` });
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";

import { PrismaClient, Role } from "@prisma/client";
export const prisma = new PrismaClient();

import authRouter from "./routes/auth";
import membersRouter from "./routes/members";
import scanRouter from "./routes/scan";
import loraRouter from "./routes/lora";
import adminRouter from "./routes/admin";
import webhookRouter from "./routes/webhooks";

import { authGuard } from "./middleware/authGuard";
import { seedAdminIfNeeded } from "./services/auth.service";
import { runPurgeExpiredScans } from "./services/privacy.service";

const PORT = Number(process.env.BACKEND_PORT ?? 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

// Rate limits
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth requests, please try again later" },
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload requests" },
});

// Health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), version: "0.1.0" });
});

// Public routes
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/webhooks", webhookRouter);

// Protected routes
app.use("/api/members", authGuard({ allowedRoles: [Role.MEMBER, Role.ADMIN] }), membersRouter);
app.use("/api/scan",    authGuard({ allowedRoles: [Role.MEMBER, Role.ADMIN] }), uploadLimiter, scanRouter);
app.use("/api/lora",    authGuard({ allowedRoles: [Role.MEMBER, Role.ADMIN] }), loraRouter);
app.use("/api/admin",   authGuard({ allowedRoles: [Role.ADMIN] }), adminRouter);

// Error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[SERVER ERROR]", err);
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({
    error: err.message ?? "Internal server error",
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  });
});

async function bootstrap() {
  await seedAdminIfNeeded();

  // Hourly sweep of expired scan images
  cron.schedule("0 * * * *", () => {
    runPurgeExpiredScans().catch((e) => console.error("[PURGE] failed", e));
  });
  // Also run once shortly after boot
  setTimeout(() => {
    runPurgeExpiredScans().catch((e) => console.error("[PURGE] initial failed", e));
  }, 15_000);

  app.listen(PORT, () => {
    console.log(`[backend] listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((e) => {
  console.error("Bootstrap failed:", e);
  process.exit(1);
});
