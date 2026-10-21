// Synthetic 21-point hand landmarks for demo mode and tests. Units: palm length
// (wrist -> middle MCP) = 1, image y down. Fingers point up.

import type { HandObs, Pt } from './gesture'

type XY = [number, number]

const OPEN: XY[] = [
  [0, 0],
  [-0.35, -0.15], [-0.6, -0.35], [-0.8, -0.55], [-0.95, -0.75],
  [-0.3, -0.95], [-0.38, -1.35], [-0.42, -1.6], [-0.45, -1.82],
  [0, -1], [0, -1.45], [0, -1.72], [0, -1.95],
  [0.27, -0.93], [0.33, -1.35], [0.37, -1.6], [0.4, -1.8],
  [0.5, -0.8], [0.62, -1.1], [0.7, -1.3], [0.76, -1.48],
]

const PINCHED: XY[] = OPEN.map((p) => [...p] as XY)
PINCHED[3] = [-0.62, -0.86]
PINCHED[4] = [-0.61, -1.13]
PINCHED[6] = [-0.46, -1.28]
PINCHED[7] = [-0.56, -1.27]
PINCHED[8] = [-0.6, -1.15]

/**
 * @param pinch 0 = open hand, 1 = thumb and index touching
 * @param wu wrist position in source UV
 * @param scale palm length in frame-height units
 */
export function makeHand(pinch: number, wu: number, wv: number, scale: number, aspect: number, label = 'Right'): HandObs {
  const landmarks: Pt[] = OPEN.map((o, i) => {
    const p = PINCHED[i]
    const x = o[0] + (p[0] - o[0]) * pinch
    const y = o[1] + (p[1] - o[1]) * pinch
    return { x: wu + (x * scale) / aspect, y: wv + y * scale, z: 0 }
  })
  return { landmarks, handedness: label, score: 0.95 }
}

export type HandScriptName = 'pinchRelease' | 'slowRelease' | 'pinchLost' | 'openPalm'

/** Scripted sequences, sampled at time `t` seconds since the script started. null = no hand detected. */
export function scriptPinch(name: HandScriptName, t: number): { pinch: number; present: boolean; done: boolean } {
  const ramp = (a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)))
  switch (name) {
    case 'pinchRelease':
      // open 0.3s, close over 0.15s, hold 0.45s, snap open over 0.07s
      return { pinch: ramp(0.3, 0.45) - ramp(0.9, 0.97), present: true, done: t > 1.6 }
    case 'slowRelease':
      // same pinch, but a lazy ~1.1s release: must NOT trigger
      return { pinch: ramp(0.3, 0.45) - ramp(0.9, 2.0), present: true, done: t > 2.6 }
    case 'pinchLost':
      // pinch, lose tracking for 0.5s, reappear with the hand open: must NOT trigger
      return { pinch: t < 1.0 ? ramp(0.3, 0.45) : 0, present: t < 1.0 || t > 1.5, done: t > 2.3 }
    case 'openPalm':
      return { pinch: 0, present: true, done: t > 1.6 }
  }
}
