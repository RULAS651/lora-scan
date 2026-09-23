import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";

export interface AuthedUser {
  id: string;
  role: Role;
  tokenType: "access";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env is required");
}

export function signAccessToken(payload: { id: string; role: Role }) {
  const ttlMin = Number(process.env.JWT_ACCESS_TTL_MINUTES ?? 15);
  return jwt.sign(
    { ...payload, tokenType: "access" as const },
    JWT_SECRET,
    { expiresIn: `${ttlMin}m` }
  );
}

export function signRefreshToken(payload: { id: string }) {
  const ttlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 7);
  return jwt.sign(
    { ...payload, tokenType: "refresh" as const },
    JWT_SECRET,
    { expiresIn: `${ttlDays}d` }
  );
}

export interface AuthGuardOptions {
  allowedRoles: Role[];
}

export function authGuard(opts: AuthGuardOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded.tokenType !== "access") {
        return res.status(401).json({ error: "Wrong token type" });
      }
      if (!opts.allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: "Insufficient role" });
      }
      req.user = {
        id: decoded.id,
        role: decoded.role,
        tokenType: "access",
      };
      next();
    } catch (e) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}
