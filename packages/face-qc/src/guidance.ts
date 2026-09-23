/**
 * The shot plan and the copy that explains it — one source of truth for the
 * capture UI, the API and any bot front-end.
 *
 * Identity quality is decided here, before any training setting matters. A weak
 * photo set cannot be recovered by a better trigger word, more steps or a
 * higher rank, so this copy is worth as much as anything in the pipeline.
 *
 * Two things in here are load-bearing and easy to "simplify" by mistake:
 *
 * 1. The close-up wording is BOUNDED ("head and shoulders", "leave room").
 *    Told simply to get close, people send frames filled edge to edge with
 *    face, and a face that fills the frame makes the detector find nothing at
 *    all. See thresholds.ts for what that costs.
 *
 * 2. The plan is not five head shots. Full-body frames are the only thing that
 *    teaches build, proportion and skin tone; without them the body drifts and
 *    resets the moment anything moves. They are also, by design, frames a
 *    frontal face detector cannot read — which is why set readiness counts
 *    usable faces rather than demanding zero rejections.
 */

/** Where the camera is, horizontally. */
export type AngleKey = 'FRONT' | 'ANGLE_45L' | 'ANGLE_45R' | 'PROFILE_L' | 'PROFILE_R' | 'BACK';

/** How far the camera is. Orthogonal to angle — both matter, separately. */
export type DistanceKey = 'CLOSEUP' | 'UPPER_BODY' | 'FULL_BODY';

export interface ShotGroup {
  id: string;
  distance: DistanceKey;
  angles: AngleKey[];
  /** How many frames this group wants. */
  count: number;
  label: string;
  hint: string;
  /**
   * Whether a frontal face detector is expected to read these frames. False
   * for true profiles, backs and distant full-body shots: a rejection there is
   * normal and must not be presented to the user as a mistake.
   */
  faceExpected: boolean;
}

export const SHOT_PLAN: ShotGroup[] = [
  {
    id: 'closeup',
    distance: 'CLOSEUP',
    angles: ['FRONT', 'ANGLE_45L', 'ANGLE_45R'],
    count: 5,
    label: 'Close-ups (5)',
    hint: 'Head and shoulders, neutral expression, facing the camera. Leave visible space on every side — not the face filling the frame.',
    faceExpected: true,
  },
  {
    id: 'upper_three_quarter',
    distance: 'UPPER_BODY',
    angles: ['FRONT', 'ANGLE_45L', 'ANGLE_45R'],
    count: 6,
    label: 'Upper body, three-quarter (6)',
    hint: 'Waist up, turned about 45° each way. This is the workhorse group — most of the face detail comes from here.',
    faceExpected: true,
  },
  {
    id: 'profiles',
    distance: 'UPPER_BODY',
    angles: ['PROFILE_L', 'PROFILE_R'],
    count: 4,
    label: 'True profiles (4)',
    hint: 'Full side view, both sides. Profiles are what teach nose and chin depth. A frontal detector will not find a face in these — that is expected.',
    faceExpected: false,
  },
  {
    id: 'full_body_front',
    distance: 'FULL_BODY',
    angles: ['FRONT', 'ANGLE_45L', 'ANGLE_45R'],
    count: 6,
    label: 'Full body, front and angles (6)',
    hint: 'Standing straight, head to feet. Stand closer or use a better camera so the face still has real detail rather than a few soft pixels.',
    faceExpected: true,
  },
  {
    id: 'full_body_around',
    distance: 'FULL_BODY',
    angles: ['PROFILE_L', 'PROFILE_R', 'BACK'],
    count: 4,
    label: 'Full body, sides and back (4)',
    hint: 'The remaining sides. These teach build and proportion, not face — no face in frame is fine here.',
    faceExpected: false,
  },
];

export const PLAN_TOTAL = SHOT_PLAN.reduce((n, g) => n + g.count, 0);

export interface GuidanceRule {
  id: string;
  title: string;
  body: string;
}

export const PHOTO_GUIDANCE: {
  headline: string;
  intro: string;
  rules: GuidanceRule[];
  plan: ShotGroup[];
  planTotal: number;
} = {
  headline: 'Your photos decide how good the result looks',
  intro:
    'The model learns the face from these photos. Everything downstream is built on top of ' +
    'what it learns here. The closer you follow this, the better the result.',

  rules: [
    {
      id: 'no_filters',
      title: 'No filters or softening',
      body:
        'Turn off beauty mode, smoothing and portrait-mode background blur. The model needs ' +
        'real skin texture, pores and fine lines to make the result look human rather than plastic.',
    },
    {
      id: 'flat_light',
      title: 'Neutral, flat lighting',
      body:
        'Soft indoor daylight or overcast outdoor light. Avoid harsh direct sun, heavy shadows ' +
        'and coloured party lighting — hard shadows and neon get baked permanently into the face.',
    },
    {
      id: 'framing',
      title: 'Leave room around the head',
      body:
        'Close-up means head and shoulders with visible space on every side — not the face ' +
        'filling the frame. A frame-filling face has no head shape left to recognise, and is ' +
        'rejected on upload.',
    },
    {
      id: 'sharp_faces',
      title: 'The face must be sharp in every one',
      body:
        'Including the full-body shots. A distant, blurry face teaches the model that this ' +
        'person looks blurry — and that shows up afterwards as a waxy, melted, much older face.',
    },
    {
      id: 'variety',
      title: 'Vary outfits and rooms',
      body:
        'At least 3 different outfits across 3 different rooms or locations. Shot in one place ' +
        'in one outfit, the model learns the room and the shirt as if they were part of the face.',
    },
    {
      id: 'one_person',
      title: 'One person per photo',
      body:
        'A second face in frame risks blending two identities into one. Crop other people out ' +
        'or reshoot.',
    },
  ],

  plan: SHOT_PLAN,
  planTotal: PLAN_TOTAL,
};

/**
 * A video walk-around is the fastest way to produce a varied set: one slow
 * 360° turn covers every angle group without the user taking 25 deliberate
 * photos. Frames are sampled, QC'd individually and the keepers are what enter
 * the set — so the same thresholds apply, nothing gets a free pass for having
 * come from a video.
 */
export const VIDEO_GUIDANCE = {
  headline: 'Or record one slow turn instead',
  intro:
    'Record yourself turning slowly through a full circle, then let the scanner pull the ' +
    'frames. It covers every angle in one take.',
  rules: [
    {
      id: 'slow',
      title: 'Turn slowly — about 20 seconds for the full circle',
      body:
        'Fast turns produce motion blur, and a blurred frame teaches a blurred face. If in ' +
        'doubt, go slower than feels natural.',
    },
    {
      id: 'distance',
      title: 'Frame yourself head to knees',
      body:
        'Close enough that the face holds detail, far enough that the whole head has room ' +
        'around it. Do the turn twice at two distances if you can.',
    },
    {
      id: 'steady',
      title: 'Put the camera down',
      body: 'A propped phone beats a held one. Camera shake reads as blur in every frame.',
    },
    {
      id: 'light',
      title: 'Even light, all the way round',
      body:
        'Stand where the light does not change as you turn. A bright window on one side means ' +
        'half the frames are backlit and unusable.',
    },
  ],
  /** Frames sampled per second of clip. One every ~0.7s covers a slow turn well. */
  defaultFps: 1.5,
  /** Hard ceiling on frames extracted from one clip, to bound CPU and storage. */
  maxFrames: 120,
  /** Clips longer than this are rejected before decoding. */
  maxDurationSeconds: 120,
};
