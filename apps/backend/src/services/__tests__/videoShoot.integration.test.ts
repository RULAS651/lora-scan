/**
 * Real ffmpeg, real frames.
 *
 * The unit tests cover the splitter and the frame selection with synthetic
 * buffers. This one drives the actual binary, because the parts most likely to
 * break in practice are the ones no fake can exercise: the stdin/stdout pipe,
 * the EPIPE when -frames:v is satisfied early, and whether the MJPEG output
 * really does concatenate whole JPEGs the way the splitter assumes.
 *
 * Skipped, not failed, when no ffmpeg is present — a contributor without the
 * optional binary should still get a green suite.
 */
import { spawn } from "child_process";
import { extractFrames, splitJpegStream } from "../videoShoot.service";

function ffmpegBin(): string | null {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require("ffmpeg-static");
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** An 8-second 640x640 test pattern, produced in memory. */
function makeClip(bin: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=640x640:rate=30:duration=8",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-movflags", "frag_keyframe+empty_moov", // seekable-free, so it can stream out
      "-f", "mp4", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const buf = Buffer.concat(out);
      if (buf.length === 0) return reject(new Error(Buffer.concat(err).toString() || `exit ${code}`));
      resolve(buf);
    });
  });
}

const bin = ffmpegBin();
const itFfmpeg = bin ? it : it.skip;

describe("extractFrames (real ffmpeg)", () => {
  jest.setTimeout(120_000);

  let clip: Buffer;

  beforeAll(async () => {
    if (bin) clip = await makeClip(bin);
  });

  itFfmpeg("samples an 8s clip at the requested rate", async () => {
    const { frames, fps } = await extractFrames(clip, { fps: 1.5 });
    expect(fps).toBe(1.5);
    // 8s x 1.5/s = 12, give or take how ffmpeg rounds the last one.
    expect(frames.length).toBeGreaterThanOrEqual(10);
    expect(frames.length).toBeLessThanOrEqual(14);
  });

  itFfmpeg("hands back whole, decodable JPEGs", async () => {
    const { frames } = await extractFrames(clip, { fps: 1 });
    for (const f of frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1]).toBe(0xd8);
      // End-of-image marker: proof the frame is complete, not a fragment left
      // over from a bad split.
      expect(f[f.length - 2]).toBe(0xff);
      expect(f[f.length - 1]).toBe(0xd9);
    }
    const sharp = require("sharp");
    const meta = await sharp(frames[0]).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(640);
  });

  itFfmpeg("the splitter round-trips real MJPEG output", async () => {
    const { frames } = await extractFrames(clip, { fps: 2 });
    expect(splitJpegStream(Buffer.concat(frames))).toHaveLength(frames.length);
  });

  itFfmpeg("honours maxFrames and does not hang on the unread tail", async () => {
    // ffmpeg stops reading stdin once -frames:v is satisfied, so the writer
    // gets EPIPE. If that were treated as an error this would reject; if the
    // stream were not ended it would hang until the timeout.
    const { frames } = await extractFrames(clip, { fps: 10, maxFrames: 3 });
    expect(frames).toHaveLength(3);
  });

  itFfmpeg("scales frames down to maxEdge", async () => {
    const { frames } = await extractFrames(clip, { fps: 1, maxEdge: 256 });
    const sharp = require("sharp");
    const meta = await sharp(frames[0]).metadata();
    expect(meta.width).toBe(256);
  });

  itFfmpeg("rejects input that is not a video, with ffmpeg's reason", async () => {
    await expect(extractFrames(Buffer.from("this is not a video"))).rejects.toThrow();
  });
});
