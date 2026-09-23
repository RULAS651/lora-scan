"use client";

import React from "react";

// Mirrors the ScanAngle enum in prisma/schema.prisma and AngleKey in
// @lora-scan/face-qc. BACK is part of the shot plan: full-body frames from
// behind teach build and hair, and no face detector will read them.
export type AngleKey = "FRONT" | "ANGLE_45L" | "ANGLE_45R" | "PROFILE_L" | "PROFILE_R" | "BACK";

interface Props {
  angle: AngleKey;
  size?: number;
}

/**
 * SVG guide overlay showing the target head silhouette for each capture angle.
 * Mirrored horizontally when shown over a webcam preview (selfie view is mirrored).
 */
export default function AngleGuide({ angle, size = 480 }: Props) {
  const CX = size / 2;
  const CY = size / 2;
  const HEAD_R = size * 0.22;

  // eye line y, chin y
  const EYE_Y = CY - size * 0.02;
  const CHIN_Y = CY + size * 0.18;

  // Per-angle offsets: x-shift + tilt angle in degrees
  const TARGET: Record<AngleKey, { dx: number; dEye: number; label: string; hint: string }> = {
    FRONT:     { dx: 0,            dEye: 0,    label: "Front",      hint: "Look straight at the camera" },
    ANGLE_45L: { dx: -size * 0.08, dEye: 0,    label: "45° Left",   hint: "Turn left ~45° (right side of face more visible)" },
    ANGLE_45R: { dx:  size * 0.08, dEye: 0,    label: "45° Right",  hint: "Turn right ~45° (left side of face more visible)" },
    PROFILE_L: { dx: -size * 0.14, dEye: 0,    label: "Profile L",  hint: "Full left profile (look left)" },
    PROFILE_R: { dx:  size * 0.14, dEye: 0,    label: "Profile R",  hint: "Full right profile (look right)" },
    BACK:      { dx: 0,            dEye: 0,    label: "Back",       hint: "Turn fully away from the camera — no face needed in this one" },
  };
  const t = TARGET[angle];

  const headCx = CX + t.dx;
  const headCy = CY;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" className="pointer-events-none absolute inset-0">
      {/* Soft corners */}
      <defs>
        <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
          <stop offset="55%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={size} height={size} fill="url(#vignette)" />

      {/* Oval silhouette outline */}
      <ellipse
        cx={headCx} cy={headCy}
        rx={HEAD_R * 0.78} ry={HEAD_R * 1.02}
        fill="none" stroke="#8b5cf6" strokeWidth={2.5}
        strokeDasharray="6 6" opacity={0.85}
      />
      {/* Eye guides */}
      <g stroke="#8b5cf6" strokeWidth={1.5} opacity={0.7}>
        <line x1={headCx - HEAD_R * 0.35} y1={EYE_Y} x2={headCx - HEAD_R * 0.08} y2={EYE_Y} />
        <line x1={headCx + HEAD_R * 0.08} y1={EYE_Y} x2={headCx + HEAD_R * 0.35} y2={EYE_Y} />
      </g>
      {/* Chin marker */}
      <circle cx={headCx + t.dEye} cy={CHIN_Y} r={3} fill="#8b5cf6" opacity={0.8} />

      {/* Top angle label */}
      <g transform={`translate(${size / 2}, 28)`}>
        <rect x={-60} y={-16} width={120} height={28} rx={14} fill="rgba(139,92,246,0.15)" stroke="rgba(139,92,246,0.6)" />
        <text textAnchor="middle" y={4} fontSize={13} fill="#e9d5ff" fontWeight={600}>{t.label}</text>
      </g>
      {/* Bottom hint */}
      <g transform={`translate(${size / 2}, ${size - 34})`}>
        <rect x={-220} y={-16} width={440} height={28} rx={14} fill="rgba(0,0,0,0.5)" />
        <text textAnchor="middle" y={4} fontSize={12} fill="#e9e9f1">{t.hint}</text>
      </g>
    </svg>
  );
}
