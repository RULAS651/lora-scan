"use client";

import { useCallback, useMemo, useState } from "react";
import {
  SHOT_PLAN,
  PLAN_TOTAL,
  readinessMessage,
  type DistanceKey,
  type SetVerdict,
  type PhotoVerdict,
} from "@lora-scan/face-qc";
import api from "@/lib/api";
import type { CaptureResult } from "@/components/FaceScanner";
import type { AngleKey } from "@/components/AngleGuide";

export type SessionStatus = "DRAFT" | "FINALIZED" | "TRAINING" | "COMPLETE" | "FAILED" | "PURGED" | "DELETED";

export interface ScanImage {
  id: string;
  angle: string;
  distance?: DistanceKey;
  source?: "UPLOAD" | "CAMERA" | "VIDEO";
  qcSeverity?: string;
}
export interface ScanSession {
  id: string;
  triggerWord: string;
  status: SessionStatus;
  images: ScanImage[];
}

export interface FinalizeResult {
  loraId: string;
  jobId: string;
  runpodId?: string;
  status: string;
  mock?: boolean;
  usable?: number;
  forced?: boolean;
}

export interface CoverageRow {
  id: string;
  label: string;
  want: number;
  got: number;
  done: boolean;
}

export interface Readiness {
  sessionId: string;
  status: SessionStatus;
  summary: SetVerdict;
  coverage: CoverageRow[];
  message: string;
}

/**
 * One capture slot: an angle at a distance.
 *
 * NOT just five head shots. Full-body frames are the only thing that teaches
 * build, proportion and skin tone, and a set without them produces a face that
 * sits on a body which drifts. The trade-off is that those frames, along with
 * true profiles and backs, are exactly what a frontal face detector cannot
 * read — hence `faceExpected`, which tells the capture UI not to block on a
 * miss it asked for.
 */
export interface Slot {
  groupId: string;
  angle: AngleKey;
  distance: DistanceKey;
  label: string;
  hint: string;
  faceExpected: boolean;
}

/** Expand the shot plan into one slot per frame the user should take. */
export const SLOTS: Slot[] = SHOT_PLAN.flatMap((g) =>
  Array.from({ length: g.count }, (_, i) => {
    const angle = g.angles[i % g.angles.length] as AngleKey;
    return {
      groupId: g.id,
      angle,
      distance: g.distance,
      label: `${g.label} — ${angle.replace(/_/g, " ").toLowerCase()}`,
      hint: g.hint,
      faceExpected: g.faceExpected,
    };
  }),
);

export const TOTAL_SLOTS = PLAN_TOTAL;

export function useScanSession() {
  const [session, setSession] = useState<ScanSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  /** The server's verdict on the most recent upload. */
  const [lastVerdict, setLastVerdict] = useState<PhotoVerdict | null>(null);

  const start = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<ScanSession>("/scan/sessions");
      setSession({ ...r.data, images: [] });
      return r.data;
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
      throw e;
    } finally { setBusy(false); }
  }, []);

  /**
   * Upload one frame.
   *
   * A 422 means the server's framing check refused it. That is not a transport
   * failure and must not be swallowed as one: the caller gets the verdict back
   * so it can show the reason and offer "use it anyway", which re-sends with
   * `acceptAnyway`.
   */
  const uploadAngle = useCallback(
    async (
      angle: AngleKey,
      capture: CaptureResult,
      deIdentify: boolean,
      opts: { distance?: DistanceKey; acceptAnyway?: boolean } = {},
    ) => {
      if (!session) throw new Error("No scan session");
      setBusy(true); setError(null);
      try {
        const fd = new FormData();
        fd.append("file", new File([capture.bytes], `${angle}.jpg`, { type: "image/jpeg" }));
        fd.append("angle", angle);
        fd.append("distance", opts.distance ?? "CLOSEUP");
        fd.append("source", "CAMERA");
        fd.append("deIdentify", String(deIdentify));
        if (opts.acceptAnyway) fd.append("acceptAnyway", "true");

        const r = await api.post<{
          id: string; angle: string; distance: DistanceKey;
          size: number; deIdentified: boolean; verdict: PhotoVerdict;
        }>(`/scan/sessions/${session.id}/image`, fd);

        setLastVerdict(r.data.verdict ?? null);
        setSession((s) => s ? {
          ...s,
          images: [...s.images, {
            id: r.data.id, angle: r.data.angle,
            distance: r.data.distance, source: "CAMERA",
            qcSeverity: r.data.verdict?.severity,
          }],
        } : s);
        return r.data;
      } catch (e: any) {
        const data = e?.response?.data;
        if (e?.response?.status === 422 && data?.verdict) {
          setLastVerdict(data.verdict as PhotoVerdict);
          setError(data.message ?? "That framing was rejected.");
          const rejected: any = new Error(data.message ?? "Framing rejected");
          rejected.verdict = data.verdict;
          rejected.overridable = !!data.overridable;
          throw rejected;
        }
        setError(data?.error ?? e.message);
        throw e;
      } finally { setBusy(false); }
    },
    [session],
  );

  /** Ask the server whether the set is good enough to train. */
  const refreshReadiness = useCallback(async () => {
    if (!session) return null;
    try {
      const r = await api.get<Readiness>(`/scan/sessions/${session.id}/readiness`);
      setReadiness(r.data);
      return r.data;
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
      return null;
    }
  }, [session]);

  /** Which slots still have nothing in them. */
  const missingSlots = useMemo(() => {
    if (!session) return SLOTS;
    const counts = new Map<string, number>();
    for (const img of session.images) {
      const key = `${img.distance ?? "CLOSEUP"}:${img.angle}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return SLOTS.filter((slot) => {
      const key = `${slot.distance}:${slot.angle}`;
      const left = counts.get(key) ?? 0;
      if (left > 0) { counts.set(key, left - 1); return false; }
      return true;
    });
  }, [session]);

  /** Kept for callers that only care about angles, not the full plan. */
  const missingAngles = useMemo(
    () => Array.from(new Set(missingSlots.map((s) => s.angle))),
    [missingSlots],
  );

  const progress = useMemo(() => {
    const taken = session?.images.length ?? 0;
    const usable = readiness?.summary.usable ?? 0;
    return {
      taken,
      total: TOTAL_SLOTS,
      usable,
      ready: readiness?.summary.ready ?? false,
      message: readiness?.message ?? readinessMessage(usable),
    };
  }, [session, readiness]);

  const finalize = useCallback(
    async (opts?: { steps?: number; rank?: number; learningRate?: number; force?: boolean }) => {
      if (!session) throw new Error("No scan session");
      setBusy(true); setError(null);
      try {
        const r = await api.post<FinalizeResult>(`/scan/sessions/${session.id}/finalize`, opts ?? {});
        return r.data;
      } catch (e: any) {
        const data = e?.response?.data;
        if (e?.response?.status === 422 && data?.error === "set_not_ready") {
          // Not a crash: the set is short. Surfaced with `overridable` so the
          // UI can offer to train anyway rather than dead-ending.
          setError(data.message);
          const notReady: any = new Error(data.message);
          notReady.notReady = true;
          notReady.usable = data.usable;
          notReady.minUsable = data.minUsable;
          notReady.overridable = !!data.overridable;
          throw notReady;
        }
        setError(data?.error ?? e.message);
        throw e;
      } finally { setBusy(false); }
    },
    [session],
  );

  return {
    session, busy, error, lastVerdict, readiness, progress,
    start, uploadAngle, finalize, refreshReadiness,
    missingSlots, missingAngles, slots: SLOTS,
    setSession,
  };
}

/** Superseded by SLOTS — the plan is no longer one frame per angle. */
export const REQUIRED_ANGLES: AngleKey[] = ["FRONT", "ANGLE_45L", "ANGLE_45R", "PROFILE_L", "PROFILE_R"];
