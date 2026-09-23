import { __setFaceDetector, type FaceDetector } from "../faceDetect.service";
import { qcPhotos, qcSet, shouldRefuse } from "../photoQc.service";
import { splitJpegStream, spreadOverTime, type VideoScanFrame } from "../videoShoot.service";
import { checkFrame } from "@lora-scan/face-qc";

/** A detector that reports exactly what a test tells it to. */
function stubDetector(
  frames: { width: number; height: number; faces?: { x1: number; y1: number; x2: number; y2: number }[] }[],
  opts: { authoritative?: boolean; name?: string } = {},
): FaceDetector {
  let i = 0;
  return {
    name: opts.name ?? "stub",
    authoritative: opts.authoritative ?? false,
    async detect() { return frames[i++]; },
    async detectMany(images) { return images.map((_, idx) => frames[idx]); },
  };
}

afterEach(() => __setFaceDetector(null));

describe("qcPhotos", () => {
  it("turns detector output into verdicts, in order", async () => {
    __setFaceDetector(stubDetector([
      // Comfortable framing.
      { width: 1000, height: 1000, faces: [{ x1: 300, y1: 300, x2: 700, y2: 700 }] },
      // 49% of frame area — over the ceiling.
      { width: 1000, height: 1000, faces: [{ x1: 150, y1: 150, x2: 850, y2: 850 }] },
      // Detector ran, found nothing.
      { width: 1000, height: 1000, faces: [] },
    ]));

    const out = await qcPhotos([
      { buffer: Buffer.alloc(0), label: "a.jpg" },
      { buffer: Buffer.alloc(0), label: "b.jpg" },
      { buffer: Buffer.alloc(0), label: "c.jpg" },
    ]);

    expect(out.map((v) => v.severity)).toEqual(["ok", "reject", "reject"]);
    expect(out.map((v) => v.file)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(out[1].reasons.join(" ")).toMatch(/too tight/);
    expect(out[2].reasons.join(" ")).toMatch(/face filling the frame/);
  });

  it("reports `unknown` when no detector ran, rather than passing the photo", async () => {
    __setFaceDetector(stubDetector([{ width: 1000, height: 1000, faces: undefined }]));
    const [v] = await qcPhotos([{ buffer: Buffer.alloc(0), label: "a.jpg" }]);
    expect(v.severity).toBe("unknown");
    expect(v.reasons.join(" ")).toMatch(/detector unavailable/);
  });

  it("returns an empty array for an empty batch without touching a detector", async () => {
    __setFaceDetector(null);
    await expect(qcPhotos([])).resolves.toEqual([]);
  });
});

describe("qcSet", () => {
  it("says which detector judged, and whether it was the authoritative one", async () => {
    const frames = Array.from({ length: 3 }, () => ({
      width: 1000, height: 1000,
      faces: [{ x1: 300, y1: 300, x2: 700, y2: 700 }],
    }));

    __setFaceDetector(stubDetector(frames, { name: "human", authoritative: false }));
    const local = await qcSet(frames.map((_, i) => ({ buffer: Buffer.alloc(0), label: `${i}.jpg` })));
    expect(local.detector).toBe("human");
    expect(local.authoritative).toBe(false);

    __setFaceDetector(null);
    __setFaceDetector(stubDetector(frames, { name: "runpod", authoritative: true }));
    const real = await qcSet(frames.map((_, i) => ({ buffer: Buffer.alloc(0), label: `${i}.jpg` })));
    expect(real.authoritative).toBe(true);
  });
});

describe("shouldRefuse", () => {
  const rejected = checkFrame({ file: "x.jpg", width: 1000, height: 1000, faces: [] });
  const fine = checkFrame({
    file: "x.jpg", width: 1000, height: 1000,
    faces: [{ x1: 300, y1: 300, x2: 700, y2: 700 }],
  });

  it("refuses a reject where a face was expected", () => {
    expect(shouldRefuse(rejected, { faceExpected: true })).toBe(true);
  });

  it("allows the same frame where no face was expected", () => {
    // Profiles, backs and distant full-body shots are IN the plan. Refusing
    // them would make the documented shot list impossible to complete.
    expect(shouldRefuse(rejected, { faceExpected: false })).toBe(false);
  });

  it("never refuses a passing frame", () => {
    expect(shouldRefuse(fine, { faceExpected: true })).toBe(false);
  });
});

describe("splitJpegStream", () => {
  const jpeg = (payload: number[]) => Buffer.from([0xff, 0xd8, 0xff, ...payload]);

  it("splits concatenated JPEGs on the start-of-image marker", () => {
    const stream = Buffer.concat([jpeg([1, 2, 3]), jpeg([4, 5]), jpeg([6, 7, 8, 9])]);
    const out = splitJpegStream(stream);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(jpeg([1, 2, 3]));
    expect(out[2]).toEqual(jpeg([6, 7, 8, 9]));
  });

  it("returns one buffer for a single image", () => {
    expect(splitJpegStream(jpeg([1, 2, 3]))).toHaveLength(1);
  });

  it("returns nothing for output with no marker", () => {
    expect(splitJpegStream(Buffer.from([0, 1, 2, 3]))).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(splitJpegStream(Buffer.alloc(0))).toEqual([]);
  });
});

describe("spreadOverTime", () => {
  const frames = (n: number): VideoScanFrame[] =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      buffer: Buffer.alloc(0),
      verdict: checkFrame({ file: `${i}.jpg`, width: 1000, height: 1000,
        faces: [{ x1: 300, y1: 300, x2: 700, y2: 700 }] }),
    }));

  it("spreads the selection across the whole clip, not the front of it", () => {
    const picked = spreadOverTime(frames(60), 6);
    expect(picked).toHaveLength(6);
    expect(picked[0].index).toBe(0);
    // A slow turn produces runs of near-identical frames; taking the first 6
    // would be six photographs of one pose.
    expect(picked[picked.length - 1].index).toBeGreaterThan(40);
  });

  it("returns everything, in time order, when there is less than asked for", () => {
    const shuffled = [...frames(4)].reverse();
    const picked = spreadOverTime(shuffled, 10);
    expect(picked.map((f) => f.index)).toEqual([0, 1, 2, 3]);
  });

  it("handles the degenerate inputs", () => {
    expect(spreadOverTime([], 5)).toEqual([]);
    expect(spreadOverTime(frames(5), 0)).toEqual([]);
  });

  it("never returns the same frame twice", () => {
    const picked = spreadOverTime(frames(25), 20);
    expect(new Set(picked.map((f) => f.index)).size).toBe(picked.length);
  });
});
