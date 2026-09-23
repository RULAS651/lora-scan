/**
 * Framing thresholds for training-set face QC.
 *
 * These numbers exist because of one counter-intuitive detector behaviour, and
 * getting them wrong is expensive in a way that is invisible until the trained
 * LoRA comes back wrong:
 *
 *   A face that FILLS the frame makes the detector find ZERO faces.
 *
 * SCRFD/RetinaFace-family detectors (InsightFace `buffalo_l`, PuLID's
 * `antelopev2`, MediaPipe BlazeFace) are all trained on images where a face
 * occupies a modest fraction of the frame. A wall of skin has no head-shaped
 * context left to match against, so the detector returns an empty list. Nothing
 * downstream errors: identity validation iterates an empty array, the trainer
 * gets no face embedding, and training completes "successfully" on a set that
 * taught it almost nothing about this person. The result is a confident
 * stranger.
 *
 * So "send close-ups" needs an upper bound as well as a lower one. The user who
 * follows the instruction most enthusiastically produces exactly the photo that
 * breaks it, and that user must not be the one who gets the worst result.
 *
 * Every value is overridable so a deployment can retune without a code change,
 * but the defaults are the ones that have been measured against a real
 * InsightFace stack — treat them as the known-good baseline, not as guesses.
 */

export interface Thresholds {
  /** Fraction of frame AREA the face box may occupy before it is "too tight". */
  maxFaceAreaFrac: number;
  /** Below this the face carries too little pixel detail to teach identity. */
  minFaceAreaFrac: number;
  /**
   * Minimum clear margin on each side, as a fraction of frame width/height.
   * A box touching an edge means the head is cropped, so the detector never
   * sees a whole head and the LoRA learns a partial one.
   */
  minEdgeMarginFrac: number;
  /** Shortest image edge below which detail is gone regardless of framing. */
  minDimension: number;
  /**
   * Face size in pixels across. Reported per photo for diagnosis. Small faces
   * are survivable when the trainer adds a full-resolution face crop for every
   * face photo, so by default this never gates readiness — see `minStrong`.
   */
  minFacePx: number;
  /**
   * How many photos must show a face at `minFacePx` or larger before the set
   * counts as ready. Default 0 = do not gate on it. Raise only if your trainer
   * does NOT add face crops; the average phone upload is small and the product
   * has to take it.
   */
  minStrong: number;
  /** Usable photos needed before a set may be submitted for training. */
  minUsable: number;
  /** The set size that actually produces good results. */
  idealTotal: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  // Past roughly this, detection starts failing; well past it, it always does.
  maxFaceAreaFrac: 0.45,
  minFaceAreaFrac: 0.005,
  minEdgeMarginFrac: 0.02,
  minDimension: 512,
  minFacePx: 160,
  minStrong: 0,
  minUsable: 15,
  idealTotal: 25,
};

/** Read overrides from an env-like bag. Unset or unparseable keys keep the default. */
export function thresholdsFromEnv(
  env: Record<string, string | undefined> = {},
  base: Thresholds = DEFAULT_THRESHOLDS,
): Thresholds {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxFaceAreaFrac: num('QC_MAX_FACE_AREA', base.maxFaceAreaFrac),
    minFaceAreaFrac: num('QC_MIN_FACE_AREA', base.minFaceAreaFrac),
    minEdgeMarginFrac: num('QC_MIN_EDGE_MARGIN', base.minEdgeMarginFrac),
    minDimension: num('QC_MIN_DIMENSION', base.minDimension),
    minFacePx: num('QC_MIN_FACE_PX', base.minFacePx),
    minStrong: num('QC_MIN_STRONG', base.minStrong),
    minUsable: num('QC_MIN_USABLE', base.minUsable),
    idealTotal: num('QC_IDEAL_TOTAL', base.idealTotal),
  };
}
