/**
 * Server-side framing QC: the authoritative check, run before a photo is
 * allowed into a training set.
 *
 * The browser gate in FaceScanner is a courtesy — it gives feedback while
 * someone is still in front of the camera. It is not a gate, for two reasons:
 * it can be skipped entirely via the file-upload path, and it runs a different
 * detector than the trainer. This module is what actually decides.
 */

import {
  checkFrame,
  checkSet,
  thresholdsFromEnv,
  type PhotoVerdict,
  type SetVerdict,
  type Thresholds,
} from '@lora-scan/face-qc';
import { getFaceDetector } from './faceDetect.service';

export function activeThresholds(): Thresholds {
  return thresholdsFromEnv(process.env as Record<string, string | undefined>);
}

export interface QcInput {
  buffer: Buffer;
  label: string;
}

/** QC one image. Never throws for bad framing — that is a verdict, not an error. */
export async function qcPhoto(input: QcInput): Promise<PhotoVerdict> {
  const [only] = await qcPhotos([input]);
  return only;
}

/** QC a batch, reusing one loaded model across the whole set. */
export async function qcPhotos(inputs: QcInput[]): Promise<PhotoVerdict[]> {
  if (inputs.length === 0) return [];
  const thresholds = activeThresholds();
  const detector = getFaceDetector();
  const frames = await detector.detectMany(
    inputs.map((i) => ({ buffer: i.buffer, label: i.label })),
  );
  return frames.map((frame, idx) =>
    checkFrame(
      {
        file: inputs[idx].label,
        width: frame.width,
        height: frame.height,
        faces: frame.faces,
      },
      thresholds,
    ),
  );
}

/** QC a batch and summarise whether the set is ready to train. */
export async function qcSet(inputs: QcInput[]): Promise<SetVerdict & { detector: string; authoritative: boolean }> {
  const detector = getFaceDetector();
  const photos = await qcPhotos(inputs);
  return {
    ...checkSet(photos, activeThresholds()),
    detector: detector.name,
    // Surfaced so a UI can say "checked with the same model that trains" vs
    // "checked locally, the trainer may still disagree". Hiding this is how a
    // set passes QC and trains badly with nobody able to explain why.
    authoritative: detector.authoritative,
  };
}

/**
 * Should this upload be refused outright?
 *
 * Only a hard `reject` blocks, and only when the caller is claiming the frame
 * shows a face. The shot plan deliberately includes profiles, backs and distant
 * full-body frames that a frontal detector cannot read; refusing those would
 * make the documented plan impossible to follow.
 */
export function shouldRefuse(
  verdict: PhotoVerdict,
  opts: { faceExpected: boolean },
): boolean {
  return opts.faceExpected && verdict.severity === 'reject';
}
