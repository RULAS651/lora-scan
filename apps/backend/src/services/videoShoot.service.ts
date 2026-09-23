/**
 * The video shoot: one slow turn in front of a camera becomes a training set.
 *
 * This is the fastest path to a varied set. Asking someone for 25 deliberate
 * photos across five angle groups loses most of them partway through; asking
 * for one 20-second turn does not. The frames are then held to exactly the same
 * framing rules as uploaded photos — coming from a video buys no leniency.
 *
 * NOTHING TOUCHES DISK. The clip is piped into ffmpeg on stdin and frames come
 * back on stdout, because the input here is video of a person's face and this
 * service's whole premise is that such material does not get written out in
 * plaintext for a temp file sweeper to find later.
 */

import { spawn } from 'child_process';
import { VIDEO_GUIDANCE, type PhotoVerdict, type SetVerdict } from '@lora-scan/face-qc';
import { qcPhotos, activeThresholds } from './photoQc.service';
import { checkSet } from '@lora-scan/face-qc';

/** Resolve the bundled ffmpeg, falling back to one on PATH. */
function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // ffmpeg-static exports the path to a binary it ships for this platform.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static');
    if (typeof p === 'string' && p.length > 0) return p;
  } catch {
    /* not installed — fall through to PATH */
  }
  return 'ffmpeg';
}

/**
 * Split concatenated MJPEG output into individual JPEG buffers.
 *
 * ffmpeg's image2pipe muxer writes complete JPEGs back to back with no frame
 * header, so the only thing separating them is the JPEG Start-Of-Image marker
 * (FF D8 FF). Scanning for it is reliable here BECAUSE the stream is MJPEG:
 * every frame is a whole, self-contained JPEG.
 */
export function splitJpegStream(buf: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      starts.push(i);
      // A valid JPEG is far longer than this; skipping avoids re-matching the
      // marker bytes inside the header we just found.
      i += 2;
    }
  }
  return starts.map((start, idx) =>
    buf.subarray(start, idx + 1 < starts.length ? starts[idx + 1] : buf.length),
  );
}

export interface ExtractOptions {
  /** Frames sampled per second of clip. */
  fps?: number;
  /** Hard ceiling on frames produced. */
  maxFrames?: number;
  /** Longest edge of each extracted frame, in pixels. */
  maxEdge?: number;
  /** Abort if ffmpeg has not finished within this many ms. */
  timeoutMs?: number;
}

export interface ExtractedFrames {
  frames: Buffer[];
  fps: number;
  /** ffmpeg's stderr, kept for diagnosis when nothing came out. */
  log: string;
}

export async function extractFrames(
  video: Buffer,
  opts: ExtractOptions = {},
): Promise<ExtractedFrames> {
  const fps = opts.fps ?? VIDEO_GUIDANCE.defaultFps;
  const maxFrames = Math.min(opts.maxFrames ?? VIDEO_GUIDANCE.maxFrames, VIDEO_GUIDANCE.maxFrames);
  const maxEdge = opts.maxEdge ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vf', `fps=${fps},scale='min(${maxEdge},iw)':-2`,
    '-frames:v', String(maxFrames),
    '-q:v', '3',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    'pipe:1',
  ];

  return new Promise<ExtractedFrames>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error('Video processing timed out'));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));

    proc.on('error', (e) =>
      finish(() =>
        reject(
          new Error(
            `Could not run ffmpeg (${e.message}). Install ffmpeg-static, or set FFMPEG_PATH.`,
          ),
        ),
      ),
    );

    proc.on('close', (code) => {
      const log = Buffer.concat(err).toString('utf8').trim();
      // A non-zero exit that still produced frames is usually a truncated tail
      // after -frames:v hit its cap, which is exactly what we asked for.
      const frames = splitJpegStream(Buffer.concat(out));
      if (frames.length === 0) {
        return finish(() =>
          reject(new Error(log || `ffmpeg produced no frames (exit ${code})`)),
        );
      }
      finish(() => resolve({ frames, fps, log }));
    });

    // EPIPE is normal: once -frames:v is satisfied ffmpeg stops reading, and
    // the rest of the clip has nowhere to go. It is not an error.
    proc.stdin.on('error', () => { /* ignore */ });
    proc.stdin.end(video);
  });
}

export interface VideoScanFrame {
  index: number;
  buffer: Buffer;
  verdict: PhotoVerdict;
}

export interface VideoScanResult {
  extracted: number;
  fps: number;
  /** Frames that passed, best first — these are the candidates for the set. */
  keepers: VideoScanFrame[];
  /** Every frame's verdict, in capture order, for a filmstrip view. */
  all: VideoScanFrame[];
  summary: SetVerdict;
}

/**
 * Pull frames from a clip and QC every one.
 *
 * Keepers are sorted by how much usable face they carry rather than by time,
 * because the caller usually wants "the best N", and time order would hand
 * back whatever happened to be at the start of the turn.
 */
export async function scanVideo(
  video: Buffer,
  opts: ExtractOptions = {},
): Promise<VideoScanResult> {
  const { frames, fps } = await extractFrames(video, opts);

  const verdicts = await qcPhotos(
    frames.map((buffer, index) => ({ buffer, label: `frame_${String(index).padStart(4, '0')}.jpg` })),
  );

  const all: VideoScanFrame[] = frames.map((buffer, index) => ({
    index,
    buffer,
    verdict: verdicts[index],
  }));

  const keepers = all
    .filter((f) => f.verdict.ok && f.verdict.severity !== 'unknown')
    .sort((a, b) => (b.verdict.facePx ?? 0) - (a.verdict.facePx ?? 0));

  return {
    extracted: frames.length,
    fps,
    keepers,
    all,
    summary: checkSet(verdicts, activeThresholds()),
  };
}

/**
 * Thin out near-duplicates.
 *
 * A 1.5fps sample of a slow turn produces runs of almost identical frames, and
 * a training set full of one pose is a set that has learned one pose. Keeping
 * every Nth frame in TIME order spreads the selection across the whole turn.
 */
export function spreadOverTime(frames: VideoScanFrame[], want: number): VideoScanFrame[] {
  if (want <= 0 || frames.length === 0) return [];
  if (frames.length <= want) return [...frames].sort((a, b) => a.index - b.index);
  const byTime = [...frames].sort((a, b) => a.index - b.index);
  const step = byTime.length / want;
  const out: VideoScanFrame[] = [];
  for (let i = 0; i < want; i++) out.push(byTime[Math.floor(i * step)]);
  return out;
}
