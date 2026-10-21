// Gesture detection on MediaPipe hand landmarks.
//
// "Pinch, then release": thumb tip (4) and index tip (8) come together, stay
// together for a moment, then separate quickly. Distances are normalized by
// palm size so the gesture works near and far from the camera. Separate on/off
// thresholds give hysteresis, and a global cooldown prevents double triggers.
// The release must be observed in continuous tracking; losing the hand never
// produces a trigger.

export interface Pt {
  x: number
  y: number
  z: number
}

export interface HandObs {
  landmarks: Pt[]
  handedness: string
  score: number
}

export const PINCH = {
  /** ratio below this starts a pinch */
  on: 0.24,
  /** ratio above this leaves the pinch (hysteresis band on..off) */
  off: 0.36,
  /** ratio above this counts as fully released */
  release: 0.7,
  /** pinch must be held this long before a release counts */
  stableMs: 150,
  /** off -> release must happen within this window ("quick" release) */
  releaseWindowMs: 220,
  /** pinches held longer than this are treated as something else */
  maxHoldMs: 4000,
  cooldownMs: 1200,
  /** missing hand longer than this resets its state */
  graceMs: 160,
  /** a frame gap longer than this means the release was not observed continuously */
  gapMs: 90,
  minHandSize: 0.035,
  minScore: 0.55,
  /** wrist jump (in palm sizes) between frames that indicates a tracking glitch */
  jump: 1.2,
}

export const PALM = {
  holdMs: 1000,
  graceMs: 160,
  minScore: 0.55,
}

function d3(a: Pt, b: Pt, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect)
}

/** Palm size: mean wrist -> index/middle/pinky MCP distance, in frame-height units. */
export function handSize(lm: Pt[], aspect: number): number {
  return (d3(lm[0], lm[5], aspect) + d3(lm[0], lm[9], aspect) + d3(lm[0], lm[17], aspect)) / 3
}

export function pinchRatio(lm: Pt[], aspect: number): number {
  return d3(lm[4], lm[8], aspect) / Math.max(1e-6, handSize(lm, aspect))
}

export function isOpenPalm(lm: Pt[], aspect: number): boolean {
  const size = handSize(lm, aspect)
  if (size < PINCH.minHandSize) return false
  const fingers: Array<[number, number, number]> = [
    [5, 6, 8],
    [9, 10, 12],
    [13, 14, 16],
    [17, 18, 20],
  ]
  for (const [mcp, pip, tip] of fingers) {
    const tipD = d3(lm[0], lm[tip], aspect)
    if (tipD < d3(lm[0], lm[pip], aspect) * 1.12) return false
    if (d3(lm[mcp], lm[tip], aspect) < size * 0.5) return false
  }
  if (d3(lm[4], lm[9], aspect) < size * 0.55) return false
  if (pinchRatio(lm, aspect) < 0.5) return false
  if (d3(lm[8], lm[20], aspect) < size * 0.7) return false
  return true
}

export type PinchPhase = 'idle' | 'pinching' | 'armed' | 'releasing' | 'blocked'

interface Slot {
  phase: PinchPhase
  pinchStart: number
  releaseStart: number
  lastSeen: number
  wx: number
  wy: number
  u: number
  v: number
}

export interface PinchEvent {
  u: number
  v: number
  t: number
}

const PHASE_RANK: Record<PinchPhase, number> = { idle: 0, blocked: 0, pinching: 1, armed: 2, releasing: 3 }

export class PinchReleaseDetector {
  private slots = new Map<string, Slot>()
  private lastFire = -Infinity
  /** Most advanced phase across hands, for UI feedback. */
  phase: PinchPhase = 'idle'

  reset() {
    this.slots.clear()
    this.phase = 'idle'
  }

  update(hands: HandObs[], t: number, aspect: number): PinchEvent | null {
    let event: PinchEvent | null = null
    const seen = new Set<string>()

    for (const hand of pickPerLabel(hands)) {
      if (hand.score < PINCH.minScore) continue
      const lm = hand.landmarks
      const size = handSize(lm, aspect)
      if (size < PINCH.minHandSize) continue
      seen.add(hand.handedness)

      let s = this.slots.get(hand.handedness)
      if (!s) {
        s = { phase: 'idle', pinchStart: 0, releaseStart: 0, lastSeen: t, wx: lm[0].x, wy: lm[0].y, u: 0, v: 0 }
        this.slots.set(hand.handedness, s)
      }
      const r = pinchRatio(lm, aspect)
      const gap = t - s.lastSeen
      const jumped = Math.hypot((lm[0].x - s.wx) * aspect, lm[0].y - s.wy) > PINCH.jump * size

      if (gap > PINCH.graceMs || jumped) {
        // Not the same continuous observation: start over, and if the hand is
        // still pinched make the user open it before a new pinch counts.
        s.phase = r < PINCH.off ? 'blocked' : 'idle'
      } else if (gap > PINCH.gapMs && s.phase !== 'idle' && s.phase !== 'blocked') {
        // Brief loss: hold the pinch only if it is still a pinch. A hand that
        // reappears already open was never seen releasing, so cancel.
        if (r >= PINCH.off) s.phase = 'idle'
      }
      s.lastSeen = t
      s.wx = lm[0].x
      s.wy = lm[0].y

      switch (s.phase) {
        case 'blocked':
          if (r > PINCH.release) s.phase = 'idle'
          break
        case 'idle':
          if (r < PINCH.on) {
            s.phase = 'pinching'
            s.pinchStart = t
          }
          break
        case 'pinching':
          if (r > PINCH.off) s.phase = 'idle'
          else if (t - s.pinchStart >= PINCH.stableMs) s.phase = 'armed'
          break
        case 'armed':
          if (t - s.pinchStart > PINCH.maxHoldMs) s.phase = 'blocked'
          else if (r > PINCH.off) {
            s.phase = 'releasing'
            s.releaseStart = t
          }
          break
        case 'releasing':
          if (r < PINCH.on) s.phase = 'armed'
          else if (t - s.releaseStart > PINCH.releaseWindowMs) s.phase = 'idle'
          break
      }
      if (s.phase === 'pinching' || s.phase === 'armed') {
        s.u = (lm[4].x + lm[8].x) / 2
        s.v = (lm[4].y + lm[8].y) / 2
      }
      if (s.phase === 'releasing' && r > PINCH.release) {
        s.phase = 'idle'
        if (t - this.lastFire >= PINCH.cooldownMs && !event) {
          this.lastFire = t
          event = { u: s.u, v: s.v, t }
        }
      }
    }

    // Hands not seen this frame: hold within the grace period, otherwise drop.
    let best: PinchPhase = 'idle'
    for (const [label, s] of this.slots) {
      if (!seen.has(label) && t - s.lastSeen > PINCH.graceMs) {
        this.slots.delete(label)
        continue
      }
      if (PHASE_RANK[s.phase] > PHASE_RANK[best]) best = s.phase
    }
    this.phase = best
    return event
  }
}

function pickPerLabel(hands: HandObs[]): HandObs[] {
  if (hands.length < 2) return hands
  const byLabel = new Map<string, HandObs>()
  for (const h of hands) {
    const cur = byLabel.get(h.handedness)
    if (!cur || h.score > cur.score) byLabel.set(h.handedness, h)
  }
  return [...byLabel.values()]
}

export interface PalmState {
  progress: number
  fired: boolean
  u: number
  v: number
  visible: boolean
}

export class OpenPalmDetector {
  private start = -1
  private lastOpen = -Infinity
  private latched = false
  readonly state: PalmState = { progress: 0, fired: false, u: 0, v: 0, visible: false }

  reset() {
    this.start = -1
    this.lastOpen = -Infinity
    this.latched = false
    this.state.progress = 0
    this.state.visible = false
  }

  update(hands: HandObs[], t: number, aspect: number): PalmState {
    const st = this.state
    st.fired = false
    let open: HandObs | null = null
    for (const h of hands) {
      if (h.score >= PALM.minScore && isOpenPalm(h.landmarks, aspect)) {
        open = h
        break
      }
    }
    if (open) {
      if (this.start < 0 || t - this.lastOpen > PALM.graceMs) this.start = t
      this.lastOpen = t
      const lm = open.landmarks
      st.u = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5
      st.v = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5
      st.visible = true
      st.progress = Math.min(1, (t - this.start) / PALM.holdMs)
      if (st.progress >= 1 && !this.latched) {
        this.latched = true
        st.fired = true
      }
    } else if (t - this.lastOpen > PALM.graceMs) {
      this.start = -1
      this.latched = false
      st.progress = 0
      st.visible = false
    }
    return st
  }
}
