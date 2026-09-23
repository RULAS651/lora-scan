# lora-scan

Scan a face, get a LoRA. Privacy-first: raw scans are encrypted at rest, never
written to disk in plaintext, and auto-purged after training.

---

## The one thing to know before changing anything

**A face that fills the frame makes the detector find zero faces.**

SCRFD/RetinaFace-family detectors — InsightFace `buffalo_l`, PuLID's
`antelopev2`, MediaPipe BlazeFace — are trained on images where a face occupies
a modest fraction of the frame. A wall of skin has no head-shaped context left
to match, so the detector returns an empty list.

Nothing errors when that happens. Identity validation iterates an empty array,
the trainer gets no face embedding, and the run completes "successfully" having
learned almost nothing about the person. The output is a confident stranger, and
the only remedy is to shoot again and pay for another run.

So "send close-ups" needs an upper bound as well as a lower one, and the user who
follows the instruction most enthusiastically is exactly the one who produces the
photo that breaks it. That is what `packages/face-qc` exists to prevent.

---

## Layout

```
packages/face-qc/        The framing rules. Pure logic: no I/O, no model.
apps/backend/            Express + Prisma. Runs the authoritative scan.
apps/frontend/           Next.js. Capture UI, live preview check.
```

### `packages/face-qc`

One module, imported by both the browser and the server, so the two can never
disagree about what good framing is.

| Rule | Default | What it catches |
|---|---|---|
| `QC_MAX_FACE_AREA` | `0.45` | Face fills the frame → detector finds nothing |
| `QC_MIN_FACE_AREA` | `0.005` | Too far away to carry skin detail |
| `QC_MIN_EDGE_MARGIN` | `0.02` | Head cropped at an edge |
| `QC_MIN_DIMENSION` | `512` | Image too small to teach anything |
| `QC_MIN_USABLE` | `15` | Set too thin to train |

`checkFrame()` judges one frame. `checkSet()` judges a whole set. Both are pure
functions over geometry — give them a box and a frame size and they answer.

**Readiness counts usable faces; it does not demand zero rejections.** The shot
plan deliberately asks for true profiles, backs and distant full-body frames, and
a frontal detector cannot read any of them. A rule of "ready = nothing rejected"
would make the documented plan impossible to complete.

### Which detector judges

Set with `FACE_DETECTOR`:

| Value | Detector | Authoritative? |
|---|---|---|
| `runpod` | InsightFace, via the `photo_qc` handler | **Yes** — same stack the trainer loads |
| `human` | `@vladmandic/human` on local CPU (optional dep) | No |
| `none` | — | No; every photo reports `unknown` |
| `auto` *(default)* | `runpod` if configured, else `human` | Depends |

Only the trainer's own detector really counts. A photo can satisfy BlazeFace in
the browser and still yield no embedding at training time, so the browser check
is feedback while someone is still in front of the camera — the server re-checks
on upload and its answer is the one that decides.

`none` is a supported mode, not a failure: a host without a model says it could
not check rather than quietly waving everything through.

---

## The two capture paths

### Photo shoot — 25 frames across 5 groups

Not five head shots. Full-body frames are the only thing that teaches build,
proportion and skin tone; without them the body drifts and resets the moment
anything moves.

| Group | Count | Face expected? |
|---|---|---|
| Close-ups (head and shoulders, room on every side) | 5 | yes |
| Upper body, three-quarter | 6 | yes |
| True profiles, both sides | 4 | no |
| Full body, front and angles | 6 | yes |
| Full body, sides and back | 4 | no |

### Video shoot — one slow turn

Record a ~20-second turn; the server samples frames, checks each one against the
same rules, and keeps the best spread across the whole clip. Asking someone for
25 deliberate photos loses most of them partway through. Asking for one turn does
not.

Frames are selected **spread over time**, not by face size: a 1.5fps sample of a
slow turn produces runs of near-identical frames, and a set full of one pose has
learned one pose.

The clip is piped through ffmpeg on stdin and frames come back on stdout —
nothing hits disk.

---

## API

| Route | Does |
|---|---|
| `GET  /api/scan/guidance` | Shot plan, copy, live thresholds, active detector |
| `POST /api/scan/qc` | Check photos **without storing them** |
| `POST /api/scan/sessions` | Start a session |
| `POST /api/scan/sessions/:id/image` | Upload one frame (QC'd before storage) |
| `POST /api/scan/sessions/:id/video` | Video shoot; `dryRun=true` previews |
| `GET  /api/scan/sessions/:id/readiness` | Is this set good enough to train? |
| `POST /api/scan/sessions/:id/finalize` | Train (`force: true` overrides a thin set) |

A refused upload returns **422** with the verdict and `overridable: true`, so the
UI can show the reason and offer "keep it anyway" rather than dead-ending.

---

## Running it

The schema needs **PostgreSQL** — it uses enums, a scalar list and JSON-ish
columns, and Prisma's sqlite connector supports none of the three.

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run migrate:dev
npm run dev
```

Face detection is optional to start: with no `RUNPOD_QC_ENDPOINT_ID` and no
`@vladmandic/human` installed, uploads still work and report `unknown`. For local
checking:

```bash
npm install @vladmandic/human --workspace=apps/backend
```

Tests:

```bash
npm test
```

The video suite drives the real ffmpeg binary; it skips rather than fails if none
is present.
