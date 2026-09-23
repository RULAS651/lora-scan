import { checkFrame, checkSet, readinessMessage } from '../verdict';
import { DEFAULT_THRESHOLDS, thresholdsFromEnv } from '../thresholds';
import { SHOT_PLAN, PLAN_TOTAL } from '../guidance';

/** A 1000x1000 frame with one centred face box of the given side length. */
function centred(sidePx: number, file = 'f.jpg') {
  const half = sidePx / 2;
  return {
    file,
    width: 1000,
    height: 1000,
    faces: [{ x1: 500 - half, y1: 500 - half, x2: 500 + half, y2: 500 + half }],
  };
}

describe('checkFrame — the frame-filling face', () => {
  it('rejects a face over the area ceiling', () => {
    // 700x700 of a 1000x1000 frame = 49% area, over the 45% ceiling.
    const v = checkFrame(centred(700));
    expect(v.severity).toBe('reject');
    expect(v.ok).toBe(false);
    expect(v.faceAreaPct).toBeCloseTo(49, 0);
    expect(v.reasons.join(' ')).toMatch(/too tight/);
  });

  it('accepts a face just under the ceiling', () => {
    // 600x600 = 36% area.
    const v = checkFrame(centred(600));
    expect(v.severity).toBe('ok');
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual(['looks good']);
  });

  it('rejects zero detections with the back-up advice, not "no person"', () => {
    const v = checkFrame({ file: 'f.jpg', width: 1000, height: 1000, faces: [] });
    expect(v.severity).toBe('reject');
    expect(v.faces).toBe(0);
    expect(v.reasons.join(' ')).toMatch(/face filling the frame/);
  });

  it('treats a missing detector as unknown, not as a pass or a fail', () => {
    const v = checkFrame({ file: 'f.jpg', width: 1000, height: 1000 });
    expect(v.severity).toBe('unknown');
    expect(v.ok).toBe(true); // advisory: never block on a host with no model
    expect(v.reasons.join(' ')).toMatch(/detector unavailable/);
  });
});

describe('checkFrame — edges and size', () => {
  it('rejects a head cropped at an edge even when the area is fine', () => {
    // 300x300 box (9% area, comfortably legal) flush against the left edge.
    const v = checkFrame({
      file: 'f.jpg', width: 1000, height: 1000,
      faces: [{ x1: 0, y1: 350, x2: 300, y2: 650 }],
    });
    expect(v.severity).toBe('reject');
    expect(v.reasons.join(' ')).toMatch(/cropped at the left edge/);
  });

  it('names every tight edge', () => {
    const v = checkFrame({
      file: 'f.jpg', width: 1000, height: 1000,
      faces: [{ x1: 0, y1: 0, x2: 300, y2: 300 }],
    });
    expect(v.reasons.join(' ')).toMatch(/left, top edges/);
  });

  it('warns — does not reject — on a face that is too far away', () => {
    // 50x50 = 0.25% area, under the 0.5% floor.
    const v = checkFrame(centred(50));
    expect(v.severity).toBe('warn');
    expect(v.ok).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/too far away/);
  });

  it('warns on a small image', () => {
    const v = checkFrame({
      file: 'f.jpg', width: 400, height: 400,
      faces: [{ x1: 100, y1: 100, x2: 250, y2: 250 }],
    });
    expect(v.severity).toBe('warn');
    expect(v.reasons.join(' ')).toMatch(/short edge/);
  });

  it('warns on more than one face without discarding the photo', () => {
    const v = checkFrame({
      file: 'f.jpg', width: 1000, height: 1000,
      faces: [
        { x1: 100, y1: 100, x2: 400, y2: 400 },
        { x1: 600, y1: 100, x2: 800, y2: 300 },
      ],
    });
    expect(v.severity).toBe('warn');
    expect(v.ok).toBe(true);
    expect(v.faces).toBe(2);
  });

  it('picks the largest face as the subject', () => {
    const v = checkFrame({
      file: 'f.jpg', width: 1000, height: 1000,
      faces: [
        { x1: 600, y1: 100, x2: 700, y2: 200 },   // small
        { x1: 100, y1: 100, x2: 500, y2: 500 },   // large — the subject
      ],
    });
    expect(v.faceAreaPct).toBeCloseTo(16, 0);
  });

  it('a reject is never marked strong', () => {
    const v = checkFrame(centred(900)); // way over the ceiling, but 900px across
    expect(v.severity).toBe('reject');
    expect(v.strong).toBe(false);
  });
});

describe('checkSet — readiness counts faces, it does not demand perfection', () => {
  const usable = (n: number) =>
    Array.from({ length: n }, (_, i) => checkFrame(centred(400, `ok${i}.jpg`)));
  const faceless = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      checkFrame({ file: `profile${i}.jpg`, width: 1000, height: 1000, faces: [] }));

  it('is ready at the minimum even with faceless profile and body shots present', () => {
    // This is the case the old "ready = enough AND nothing rejected" rule made
    // unreachable: the shot plan asks for frames a frontal detector cannot read.
    const set = checkSet([...usable(15), ...faceless(8)]);
    expect(set.usable).toBe(15);
    expect(set.rejected).toBe(8);
    expect(set.ready).toBe(true);
  });

  it('is not ready below the usable minimum', () => {
    const set = checkSet(usable(14));
    expect(set.ready).toBe(false);
    expect(set.advice.join(' ')).toMatch(/Only 14 usable/);
  });

  it('explains that rejected frames are still trained on', () => {
    const set = checkSet([...usable(15), ...faceless(3)]);
    expect(set.advice.join(' ')).toMatch(/still trained on/);
  });

  it('gates on strong faces only when minStrong is raised', () => {
    const t = { ...DEFAULT_THRESHOLDS, minStrong: 5 };
    // 400px boxes are well over the 160px minFacePx, so these count as strong.
    expect(checkSet(usable(15), t).ready).toBe(true);
    const small = Array.from({ length: 15 }, (_, i) => checkFrame(centred(100, `s${i}.jpg`)));
    const set = checkSet(small, t);
    expect(set.strong).toBe(0);
    expect(set.ready).toBe(false);
    expect(set.advice.join(' ')).toMatch(/face at 160px across or larger/);
  });
});

describe('readinessMessage', () => {
  it('grades the three bands', () => {
    expect(readinessMessage(25)).toMatch(/Excellent/);
    expect(readinessMessage(15)).toMatch(/good enough to train/);
    expect(readinessMessage(3)).toMatch(/below the 15 needed/);
  });
});

describe('thresholdsFromEnv', () => {
  it('overrides only what is set and parseable', () => {
    const t = thresholdsFromEnv({ QC_MAX_FACE_AREA: '0.6', QC_MIN_DIMENSION: 'nonsense' });
    expect(t.maxFaceAreaFrac).toBe(0.6);
    expect(t.minDimension).toBe(DEFAULT_THRESHOLDS.minDimension);
  });

  it('honours a raised ceiling end to end', () => {
    const t = thresholdsFromEnv({ QC_MAX_FACE_AREA: '0.6' });
    expect(checkFrame(centred(700), t).severity).toBe('ok'); // 49% now legal
  });
});

describe('shot plan', () => {
  it('asks for enough frames to clear the usable minimum with room to spare', () => {
    expect(PLAN_TOTAL).toBe(25);
    expect(PLAN_TOTAL).toBeGreaterThan(DEFAULT_THRESHOLDS.minUsable);
  });

  it('includes groups a frontal detector is not expected to read', () => {
    const notExpected = SHOT_PLAN.filter((g) => !g.faceExpected);
    expect(notExpected.length).toBeGreaterThan(0);
    // ...and enough face-bearing frames are still planned to reach the minimum.
    const expectedFaces = SHOT_PLAN
      .filter((g) => g.faceExpected)
      .reduce((n, g) => n + g.count, 0);
    expect(expectedFaces).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minUsable);
  });
});
