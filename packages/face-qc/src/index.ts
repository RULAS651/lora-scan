/**
 * @lora-scan/face-qc — the framing rules a LoRA training set has to pass.
 *
 * Pure logic only: no image decoding, no model inference, no I/O. The browser
 * capture gate and the authoritative server scan both import from here so the
 * two can never disagree about what "good framing" means.
 */

export {
  DEFAULT_THRESHOLDS,
  thresholdsFromEnv,
  type Thresholds,
} from './thresholds';

export {
  checkFrame,
  checkSet,
  readinessMessage,
  type FaceBox,
  type FrameGeometry,
  type PhotoVerdict,
  type SetVerdict,
  type Severity,
} from './verdict';

export {
  PHOTO_GUIDANCE,
  VIDEO_GUIDANCE,
  SHOT_PLAN,
  PLAN_TOTAL,
  type AngleKey,
  type DistanceKey,
  type ShotGroup,
  type GuidanceRule,
} from './guidance';
