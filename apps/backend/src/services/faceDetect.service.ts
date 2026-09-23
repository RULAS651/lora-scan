/**
 * Face detection, behind one interface, with three backings.
 *
 * WHY THIS IS PLUGGABLE, AND WHY IT MATTERS WHICH ONE RUNS
 * -------------------------------------------------------
 * The only detector whose opinion actually counts is the one the TRAINER uses.
 * If training runs InsightFace (`buffalo_l` / SCRFD) and QC runs MediaPipe
 * BlazeFace, a photo can pass QC and still contribute nothing: the trainer
 * finds no face, extracts no embedding, and the run completes "successfully"
 * having learned very little about this person.
 *
 * So the browser gate and any local CPU detector are ADVISORY — they exist to
 * give instant feedback while someone is still standing in front of the camera.
 * `runpod` is the authoritative one, because it is the same InsightFace stack
 * the training job loads. Prefer it whenever it is configured.
 *
 * Choose with FACE_DETECTOR:
 *   auto    (default) runpod if configured, else human if installed, else none
 *   runpod  authoritative; requires RUNPOD_API_KEY + RUNPOD_QC_ENDPOINT_ID
 *   human   local CPU via @vladmandic/human (optional dependency)
 *   none    no detection; every photo comes back `unknown` rather than passing
 *
 * `none` is a real, supported mode, not a failure: a deployment without a model
 * should say it could not check, never quietly wave everything through.
 */

import axios from 'axios';
import type { FaceBox } from '@lora-scan/face-qc';

export interface DetectedFrame {
  width: number;
  height: number;
  /** undefined = no detector ran. [] = a detector ran and found nothing. */
  faces?: FaceBox[];
}

export interface FaceDetector {
  readonly name: string;
  /** True when this detector matches the one the trainer uses. */
  readonly authoritative: boolean;
  detect(image: Buffer, label?: string): Promise<DetectedFrame>;
  detectMany(images: { buffer: Buffer; label: string }[]): Promise<DetectedFrame[]>;
}

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY ?? '';
const RUNPOD_QC_ENDPOINT_ID =
  process.env.RUNPOD_QC_ENDPOINT_ID ?? process.env.RUNPOD_ENDPOINT_ID ?? '';

// ---------------------------------------------------------------------------
// Shared: read image dimensions without a model. sharp is already a dependency.
// ---------------------------------------------------------------------------

async function dimensions(image: Buffer): Promise<{ width: number; height: number }> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(image).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// ---------------------------------------------------------------------------
// none
// ---------------------------------------------------------------------------

class NullDetector implements FaceDetector {
  readonly name = 'none';
  readonly authoritative = false;

  async detect(image: Buffer): Promise<DetectedFrame> {
    // Dimensions still come back: "too small" is checkable without a model, and
    // it is worth telling someone their 320px upload is too small even when
    // framing cannot be judged.
    const { width, height } = await dimensions(image);
    return { width, height, faces: undefined };
  }

  async detectMany(images: { buffer: Buffer; label: string }[]) {
    return Promise.all(images.map((i) => this.detect(i.buffer)));
  }
}

// ---------------------------------------------------------------------------
// human — local CPU, optional dependency
// ---------------------------------------------------------------------------

class HumanDetector implements FaceDetector {
  readonly name = 'human';
  readonly authoritative = false;

  private human: any = null;
  private loadFailed = false;

  /**
   * Built once per process. Loading the models is slow and the scanner checks
   * every frame of every clip — building per call turns a 60-frame video into
   * 60 model loads.
   */
  private async instance(): Promise<any | null> {
    if (this.human) return this.human;
    if (this.loadFailed) return null;
    try {
      const mod: any = await import('@vladmandic/human');
      const Human = mod.default ?? mod.Human;
      const human = new Human({
        backend: 'tensorflow',
        modelBasePath: process.env.HUMAN_MODEL_BASE_PATH
          ?? 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/',
        cacheSensitivity: 0,
        face: {
          enabled: true,
          detector: { rotation: false, maxDetected: 10, minConfidence: 0.2 },
          // Everything past detection is weight we do not use: QC needs a box,
          // not a mesh, an age or an emotion.
          mesh: { enabled: false },
          iris: { enabled: false },
          description: { enabled: false },
          emotion: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
      });
      await human.load();
      this.human = human;
      return human;
    } catch (err) {
      // Optional dependency, absent or unbuildable. Degrade to `unknown`
      // verdicts rather than failing an upload the user cannot fix.
      // eslint-disable-next-line no-console
      console.warn(
        '[faceDetect] @vladmandic/human unavailable — framing will not be checked locally. ' +
        'Install it, or set RUNPOD_QC_ENDPOINT_ID for authoritative QC.',
        (err as Error).message,
      );
      this.loadFailed = true;
      return null;
    }
  }

  async detect(image: Buffer): Promise<DetectedFrame> {
    const human = await this.instance();
    const { width, height } = await dimensions(image);
    if (!human) return { width, height, faces: undefined };

    let tensor: any = null;
    try {
      // Normalise to raw RGB first: tfjs-node's decoder does not read every
      // JPEG variant a phone produces, and sharp already handles all of them.
      const sharp = (await import('sharp')).default;
      const { data, info } = await sharp(image)
        .rotate()                 // honour EXIF, or a sideways phone photo scores as a miss
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      tensor = human.tf.tensor3d(
        new Uint8Array(data),
        [info.height, info.width, 3],
        'int32',
      ).expandDims(0);

      const result = await human.detect(tensor);
      const faces: FaceBox[] = (result?.face ?? []).map((f: any) => {
        const [x, y, w, h] = f.box as [number, number, number, number];
        return { x1: x, y1: y, x2: x + w, y2: y + h, score: f.score ?? f.faceScore };
      });
      // Report the ORIENTED dimensions — the boxes are in that space, so mixing
      // them with the pre-rotation size silently corrupts every margin figure.
      return { width: info.width, height: info.height, faces };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[faceDetect] local detection failed', (err as Error).message);
      return { width, height, faces: undefined };
    } finally {
      if (tensor) {
        try { tensor.dispose(); } catch { /* already gone */ }
      }
    }
  }

  async detectMany(images: { buffer: Buffer; label: string }[]) {
    // Sequential on purpose: the models are not re-entrant and a video import
    // would otherwise start 60 inferences at once and exhaust memory.
    const out: DetectedFrame[] = [];
    for (const img of images) out.push(await this.detect(img.buffer));
    return out;
  }
}

// ---------------------------------------------------------------------------
// runpod — authoritative, same InsightFace stack as training
// ---------------------------------------------------------------------------

interface RunpodQcPhoto {
  file?: string;
  width?: number;
  height?: number;
  faces?: number;
  boxes?: number[][];
}

class RunpodDetector implements FaceDetector {
  readonly name = 'runpod';
  readonly authoritative = true;

  private api = axios.create({
    baseURL: 'https://api.runpod.ai/v2',
    headers: { Authorization: `Bearer ${RUNPOD_API_KEY}` },
    timeout: 120_000,
  });

  async detect(image: Buffer, label = 'photo.jpg'): Promise<DetectedFrame> {
    const [only] = await this.detectMany([{ buffer: image, label }]);
    return only;
  }

  async detectMany(images: { buffer: Buffer; label: string }[]): Promise<DetectedFrame[]> {
    const fallback = async (): Promise<DetectedFrame[]> =>
      Promise.all(images.map(async (i) => ({ ...(await dimensions(i.buffer)), faces: undefined })));

    try {
      // /runsync so a warm worker answers inline. A QC call that hands back a
      // job id nobody polls is a button that reports nothing.
      const res = await this.api.post(`/${RUNPOD_QC_ENDPOINT_ID}/runsync`, {
        input: {
          mode: 'photo_qc',
          // Inline base64 rather than URLs: these are training photos of a
          // person's face, and this service does not put them on a public URL
          // just so a worker can fetch them back.
          photos_b64: images.map((i) => ({
            file: i.label,
            data: i.buffer.toString('base64'),
          })),
        },
      });

      const status = String(res.data?.status ?? '').toUpperCase();
      if (status !== 'COMPLETED') {
        // Cold start past the sync window, or a worker failure. Either way this
        // call has no answer; say "not checked" instead of inventing one.
        // eslint-disable-next-line no-console
        console.warn(`[faceDetect] runpod QC did not complete inline (${status || 'no status'})`);
        return fallback();
      }

      const photos: RunpodQcPhoto[] = res.data?.output?.photos ?? [];
      if (photos.length !== images.length) {
        // eslint-disable-next-line no-console
        console.warn('[faceDetect] runpod QC returned a different number of results');
        return fallback();
      }

      return Promise.all(photos.map(async (p, idx) => {
        const dims = p.width && p.height
          ? { width: p.width, height: p.height }
          : await dimensions(images[idx].buffer);
        // Prefer real boxes. A worker that reports only a count cannot support
        // the margin and area rules, so treat that as "not checked" rather than
        // guessing a box — a guessed box produces confident wrong advice.
        if (!Array.isArray(p.boxes)) return { ...dims, faces: undefined };
        const faces: FaceBox[] = p.boxes.map((b) => ({
          x1: b[0], y1: b[1], x2: b[2], y2: b[3], score: b[4],
        }));
        return { ...dims, faces };
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[faceDetect] runpod QC call failed', (err as Error).message);
      return fallback();
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let cached: FaceDetector | null = null;

export function getFaceDetector(): FaceDetector {
  if (cached) return cached;
  const choice = (process.env.FACE_DETECTOR ?? 'auto').toLowerCase();
  const runpodReady = Boolean(RUNPOD_API_KEY && RUNPOD_QC_ENDPOINT_ID);

  switch (choice) {
    case 'none':
      cached = new NullDetector();
      break;
    case 'human':
      cached = new HumanDetector();
      break;
    case 'runpod':
      if (!runpodReady) {
        throw new Error(
          'FACE_DETECTOR=runpod needs RUNPOD_API_KEY and RUNPOD_QC_ENDPOINT_ID. ' +
          'Set them, or use FACE_DETECTOR=human / none.',
        );
      }
      cached = new RunpodDetector();
      break;
    case 'auto':
    default:
      cached = runpodReady ? new RunpodDetector() : new HumanDetector();
      break;
  }
  return cached;
}

/** Test seam — swap in a stub detector. */
export function __setFaceDetector(d: FaceDetector | null) {
  cached = d;
}
