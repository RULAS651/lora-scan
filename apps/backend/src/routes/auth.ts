import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  registerMember,
  loginMember,
  refreshAccessToken,
  logoutAll,
} from "../services/auth.service";

const router = Router();

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  privacyConsent: z.boolean().refine((v) => v === true, { message: "Consent must be given" }),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().max(128),
});

const RefreshBody = z.object({ refresh: z.string().min(1) });

router.post("/register", async (req: Request, res: Response, next) => {
  try {
    const body = RegisterBody.parse(req.body);
    const member = await registerMember({
      ...body,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ member });
  } catch (e) {
    next(e);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const tokens = await loginMember({
      ...body,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(tokens);
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refresh } = RefreshBody.parse(req.body);
    const out = await refreshAccessToken(refresh);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    let decoded: any = null;
    try { decoded = require("jsonwebtoken").verify(token, process.env.JWT_SECRET as string); } catch {}
    if (decoded?.id) {
      await logoutAll(decoded.id);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
