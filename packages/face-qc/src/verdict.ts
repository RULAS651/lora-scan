/**
 * The QC verdict itself: pure geometry in, human-readable judgement out.
 *
 * Deliberately free of any image decoding or model inference so that the
 * browser preview gate and the authoritative server scan reach the SAME
 * conclusion from the same numbers. Two implementations of "is this framing
 * acceptable" drift apart, and when they do the user is told "looks good" by
 * the camera and "rejected" by the upload — which reads as a broken product.
 */

import { DEFAULT_THRESHOLDS, Thresholds } from './thresholds';

export type Severity = 'ok' | 'warn' | 'reject' | 'unknown';

/** One detected face, in pixel coordinates of the frame it came from. */
export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Detector confidence, when it reports one. Not used for gating. */
  score?: number;
}

export interface FrameGeometry {
  /** Label for reporting — a filename, a frame number, an angle id. */
  file: string;
  width: number;
  height: number;
  /**
   * Every face the detector found. An EMPTY array and `undefined` mean
   * different things: empty = the detector ran and found nothing (a real
   * signal), undefined = no detector was available (advisory only).
   */
  faces?: FaceBox[];
}

export interface PhotoVerdict {
  file: string;
  /** False only for `reject`. A `warn` photo is still trained on. */
  ok: boolean;
  severity: Severity;
  width: number;
  height: number;
  faces?: number;
  /** Shortest edge of the subject face box, in pixels. */
  facePx?: number;
  /** Face box area as a percentage of frame area. */
  faceAreaPct?: number;
  /** Clear space between the face box and each edge, as a percentage. */
  marginsPct?: { left: number; right: number; top: number; bottom: number };
  /** Passed QC and the face is large enough to carry fine detail on its own. */
  strong?: boolean;
  /** Plain-language reasons, safe to show a user verbatim. */
  reasons: string[];
}

/** Pick the subject: the largest box. Group shots are warned about separately. */
function largest(faces: FaceBox[]): FaceBox {
  return faces.reduce((best, f) =>
    (f.x2 - f.x1) * (f.y2 - f.y1) > (best.x2 - best.x1) * (best.y2 - best.y1) ? f : best,
  );
}

export function checkFrame(
  geom: FrameGeometry,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PhotoVerdict {
  const { file, width: w, height: h, faces } = geom;
  const reasons: string[] = [];
  let severity: Severity = 'ok';

  if (!(w > 0 && h > 0)) {
    return {
      file, ok: false, severity: 'reject', width: w, height: h,
      reasons: ['could not be read — is it a real JPG or PNG?'],
    };
  }

  if (Math.min(w, h) < thresholds.minDimension) {
    reasons.push(
      `small image (${w}x${h}) — aim for at least ${thresholds.minDimension}px on the short edge`,
    );
    severity = 'warn';
  }

  // No detector on this host. Say so rather than silently passing everything:
  // an unchecked photo and a checked one look identical in the UI otherwise.
  if (faces === undefined) {
    return {
      file, ok: true, severity: 'unknown', width: w, height: h,
      reasons: [...reasons, 'face detector unavailable — framing not checked'],
    };
  }

  if (faces.length === 0) {
    // The branch this whole module exists for. On a photo the user believes is
    // a portrait, "no detection" is far more often "too close" than "nobody in
    // the picture", so the message leads with the fix that actually works.
    return {
      file, ok: false, severity: 'reject', width: w, height: h, faces: 0,
      reasons: [
        ...reasons,
        'no face detected. The usual cause is the face filling the frame — back up ' +
        'so the whole head plus some shoulders are visible. Detectors need to see ' +
        'head shape, not just skin.',
      ],
    };
  }

  const face = largest(faces);
  const fw = Math.max(0, face.x2 - face.x1);
  const fh = Math.max(0, face.y2 - face.y1);
  const frameArea = w * h;
  const areaFrac = frameArea > 0 ? (fw * fh) / frameArea : 0;

  const margins = {
    left: face.x1 / w,
    right: (w - face.x2) / w,
    top: face.y1 / h,
    bottom: (h - face.y2) / h,
  };
  const tight = (Object.keys(margins) as (keyof typeof margins)[])
    .filter((k) => margins[k] < thresholds.minEdgeMarginFrac);

  const facePx = Math.round(Math.min(fw, fh));

  if (areaFrac > thresholds.maxFaceAreaFrac) {
    reasons.push(
      `face fills ${(areaFrac * 100).toFixed(0)}% of the frame — too tight. Back up until ` +
      `the head and shoulders fit with room around them; past roughly ` +
      `${(thresholds.maxFaceAreaFrac * 100).toFixed(0)}% the face detector starts failing entirely.`,
    );
    severity = 'reject';
  } else if (areaFrac < thresholds.minFaceAreaFrac) {
    reasons.push(
      `face is only ${(areaFrac * 100).toFixed(1)}% of the frame — too far away to capture skin detail.`,
    );
    // Only reachable when the area ceiling was NOT hit, so severity is still
    // 'ok' or 'warn' here and this cannot downgrade a reject.
    severity = 'warn';
  }

  if (tight.length > 0) {
    reasons.push(
      `head is cropped at the ${tight.join(', ')} edge${tight.length > 1 ? 's' : ''} — ` +
      'leave a margin on every side.',
    );
    severity = 'reject';
  }

  if (faces.length > 1) {
    reasons.push(
      `${faces.length} faces detected — use photos of one person so the identity does not ` +
      'blend two people.',
    );
    if (severity === 'ok') severity = 'warn';
  }

  return {
    file,
    ok: severity !== 'reject',
    severity,
    width: w,
    height: h,
    faces: faces.length,
    facePx,
    faceAreaPct: Number((areaFrac * 100).toFixed(1)),
    marginsPct: {
      left: Number((margins.left * 100).toFixed(1)),
      right: Number((margins.right * 100).toFixed(1)),
      top: Number((margins.top * 100).toFixed(1)),
      bottom: Number((margins.bottom * 100).toFixed(1)),
    },
    strong: severity !== 'reject' && facePx >= thresholds.minFacePx,
    reasons: reasons.length > 0 ? reasons : ['looks good'],
  };
}

export interface SetVerdict {
  total: number;
  usable: number;
  rejected: number;
  strong: number;
  /** Enough usable face data to train on. */
  ready: boolean;
  minUsable: number;
  idealTotal: number;
  minStrong: number;
  minFacePx: number;
  photos: PhotoVerdict[];
  advice: string[];
}

export function checkSet(
  photos: PhotoVerdict[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): SetVerdict {
  const usable = photos.filter((p) => p.ok);
  const rejected = photos.filter((p) => !p.ok);
  const strong = usable.filter((p) => p.strong);
  const advice: string[] = [];

  if (usable.length < thresholds.minUsable) {
    advice.push(
      `Only ${usable.length} usable photo(s). Aim for ~${thresholds.idealTotal} across the ` +
      'shot groups — identity quality tracks the size and variety of this set more than any ' +
      'training setting.',
    );
  }
  if (thresholds.minStrong > 0 && strong.length < thresholds.minStrong) {
    advice.push(
      `Only ${strong.length} photo(s) show the face at ${thresholds.minFacePx}px across or ` +
      `larger; at least ${thresholds.minStrong} are needed.`,
    );
  }
  if (rejected.length > 0) {
    // Readiness is about having ENOUGH FACE, not about having zero faceless
    // photos. A rule of "ready = enough usable AND nothing rejected" makes a
    // correctly shot set unreachable, because the shot plan deliberately asks
    // for full-body and true-profile frames — exactly the ones a frontal face
    // detector cannot read. Following the instructions would otherwise
    // guarantee "not ready" forever.
    advice.push(
      `${rejected.length} photo(s) have no usable face. They are still trained on — they teach ` +
      'build, hair and clothing rather than the face. A deliberate back, low or side reference ' +
      'belongs here; a close-up that overshot does not.',
    );
  }

  return {
    total: photos.length,
    usable: usable.length,
    rejected: rejected.length,
    strong: strong.length,
    ready:
      usable.length >= thresholds.minUsable &&
      (thresholds.minStrong <= 0 || strong.length >= thresholds.minStrong),
    minUsable: thresholds.minUsable,
    idealTotal: thresholds.idealTotal,
    minStrong: thresholds.minStrong,
    minFacePx: thresholds.minFacePx,
    photos,
    advice,
  };
}

/** One line describing how close a set is, for a status strip. */
export function readinessMessage(
  usable: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): string {
  if (usable >= thresholds.idealTotal) {
    return 'Excellent set — this is what the best results come from.';
  }
  if (usable >= thresholds.minUsable) {
    return `${usable} usable photos: good enough to train. More angles still helps.`;
  }
  return `${usable} usable photos: below the ${thresholds.minUsable} needed. Add more angles before training.`;
}
