import { describe, expect, it } from 'vitest'
import { computeCover, screenToUv, uvToScreen } from './coords'
import { OpenPalmDetector, PinchReleaseDetector, isOpenPalm, pinchRatio, type HandObs } from './gesture'
import { MaskField } from './mask'
import { NOISE_SIZE, createNoise, sampleNoise } from './noise'
import { TransformMachine } from './stateMachine'
import { makeHand, scriptPinch, type HandScriptName } from './syntheticHand'

const ASPECT = 16 / 9

/** Feed a scripted gesture at 30 fps; returns the number of triggers. */
function runScript(det: PinchReleaseDetector, name: HandScriptName, t0 = 0, scale = 0.12): number {
  let fired = 0
  for (let t = 0; ; t += 1 / 30) {
    const s = scriptPinch(name, t)
    const hands: HandObs[] = s.present ? [makeHand(s.pinch, 0.6, 0.5, scale, ASPECT)] : []
    if (det.update(hands, t0 + t * 1000, ASPECT)) fired++
    if (s.done) break
  }
  return fired
}

describe('coords', () => {
  it('round-trips uv <-> screen with mirroring and cover crop', () => {
    const m = computeCover(1280, 720, 900, 1600, true)
    const p = uvToScreen(m, 0.2, 0.7, { x: 0, y: 0 })
    const back = screenToUv(m, p.x, p.y, { x: 0, y: 0 })
    expect(back.x).toBeCloseTo(0.2)
    expect(back.y).toBeCloseTo(0.7)
    // mirrored: source-left lands on screen-right of centre
    expect(p.x).toBeGreaterThan(450)
    // portrait viewport crops the sides of a landscape frame
    expect(m.dh).toBeCloseTo(1600)
    expect(m.ox).toBeLessThan(0)
  })
})

describe('noise', () => {
  it('samples texel centres exactly and wraps', () => {
    const n = createNoise(3)
    const c = (5 + 0.5) / NOISE_SIZE
    expect(sampleNoise(n, c, c)).toBeCloseTo(n[5 * NOISE_SIZE + 5] / 255, 5)
    expect(sampleNoise(n, c + 1, c - 2)).toBeCloseTo(sampleNoise(n, c, c), 5)
  })
})

describe('mask', () => {
  it('computes coverage and centroid', () => {
    const m = new MaskField()
    const src = new Float32Array(10 * 10)
    for (let y = 2; y < 6; y++) for (let x = 6; x < 10; x++) src[y * 10 + x] = 1
    m.ingest(src, 10, 10, 0)
    expect(m.coverage).toBeCloseTo(0.16)
    expect(m.cx).toBeCloseTo(0.8)
    expect(m.cy).toBeCloseTo(0.4)
  })
})

describe('pinch, then release', () => {
  it('synthetic hand ratios are sane', () => {
    expect(pinchRatio(makeHand(0, 0.5, 0.5, 0.12, ASPECT).landmarks, ASPECT)).toBeGreaterThan(1)
    expect(pinchRatio(makeHand(1, 0.5, 0.5, 0.12, ASPECT).landmarks, ASPECT)).toBeLessThan(0.1)
    expect(isOpenPalm(makeHand(0, 0.5, 0.5, 0.12, ASPECT).landmarks, ASPECT)).toBe(true)
    expect(isOpenPalm(makeHand(1, 0.5, 0.5, 0.12, ASPECT).landmarks, ASPECT)).toBe(false)
  })

  it('fires exactly once for a valid pinch and quick release', () => {
    expect(runScript(new PinchReleaseDetector(), 'pinchRelease')).toBe(1)
  })

  it('is scale invariant (hand far from camera)', () => {
    expect(runScript(new PinchReleaseDetector(), 'pinchRelease', 0, 0.05)).toBe(1)
  })

  it('does not fire on a slow release', () => {
    expect(runScript(new PinchReleaseDetector(), 'slowRelease')).toBe(0)
  })

  it('does not fire when tracking is lost mid-pinch', () => {
    expect(runScript(new PinchReleaseDetector(), 'pinchLost')).toBe(0)
  })

  it('does not fire when the hand vanishes for a single frame and reappears open', () => {
    const det = new PinchReleaseDetector()
    let fired = 0
    const frames: Array<number | null> = [0, 0, 1, 1, 1, 1, 1, 1, 1, null, null, null, 0, 0, 0]
    frames.forEach((p, i) => {
      const hands = p === null ? [] : [makeHand(p, 0.5, 0.5, 0.12, ASPECT)]
      if (det.update(hands, i * 33, ASPECT)) fired++
    })
    expect(fired).toBe(0)
  })

  it('does not fire on a brief tap without a stable pinch', () => {
    const det = new PinchReleaseDetector()
    let fired = 0
    const frames = [0, 0, 1, 1, 0, 0, 0]
    frames.forEach((p, i) => {
      if (det.update([makeHand(p, 0.5, 0.5, 0.12, ASPECT)], i * 33, ASPECT)) fired++
    })
    expect(fired).toBe(0)
  })

  it('applies a cooldown between triggers', () => {
    const det = new PinchReleaseDetector()
    // 7 pinched frames (~230 ms, > stableMs) then open frames: one valid gesture
    const quick = (t0: number) => {
      let fired = 0
      const frames = [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]
      frames.forEach((p, i) => {
        if (det.update([makeHand(p, 0.5, 0.5, 0.12, ASPECT)], t0 + i * 33, ASPECT)) fired++
      })
      return fired
    }
    expect(quick(0)).toBe(1)
    expect(quick(400)).toBe(0) // within 1.2 s cooldown
    expect(quick(2000)).toBe(1)
  })

  it('ignores low-confidence and tiny hands', () => {
    const det = new PinchReleaseDetector()
    let fired = 0
    for (let t = 0; t < 1.6; t += 1 / 30) {
      const s = scriptPinch('pinchRelease', t)
      const h = makeHand(s.pinch, 0.5, 0.5, 0.12, ASPECT)
      h.score = 0.3
      if (det.update([h], t * 1000, ASPECT)) fired++
    }
    expect(fired).toBe(0)
  })
})

describe('open palm', () => {
  it('fires once after ~1 s of holding, then latches', () => {
    const det = new OpenPalmDetector()
    let fired = 0
    let firstAt = -1
    for (let t = 0; t <= 3000; t += 33) {
      const s = det.update([makeHand(0, 0.5, 0.5, 0.12, ASPECT)], t, ASPECT)
      if (s.fired) {
        fired++
        if (firstAt < 0) firstAt = t
      }
    }
    expect(fired).toBe(1)
    expect(firstAt).toBeGreaterThanOrEqual(1000)
    expect(firstAt).toBeLessThan(1100)
  })

  it('resets when tracking is lost', () => {
    const det = new OpenPalmDetector()
    let fired = 0
    for (let t = 0; t <= 3000; t += 33) {
      const lost = Math.floor(t / 700) % 2 === 1
      if (det.update(lost ? [] : [makeHand(0, 0.5, 0.5, 0.12, ASPECT)], t, ASPECT).fired) fired++
    }
    expect(fired).toBe(0)
  })
})

describe('transform state machine', () => {
  it('runs repeatable vanish/return cycles and rejects conflicting triggers', () => {
    const m = new TransformMachine({ readyCooldownMs: 500, minVanishedMs: 300 })
    m.enterReady(0)
    for (let cycle = 0; cycle < 3; cycle++) {
      const t = 1000 + cycle * 10000
      expect(m.requestReturn(t)).toBe(false)
      expect(m.requestVanish(t)).toBe(true)
      expect(m.requestVanish(t + 100)).toBe(false)
      expect(m.requestReturn(t + 100)).toBe(false)
      m.finishDissolve(t + 2600)
      expect(m.state).toBe('vanished')
      expect(m.requestReturn(t + 2700)).toBe(false) // too soon
      expect(m.requestReturn(t + 3000)).toBe(true)
      expect(m.requestVanish(t + 3100)).toBe(false)
      m.finishReturn(t + 6000)
      expect(m.state).toBe('ready')
      expect(m.requestVanish(t + 6100)).toBe(false) // ready cooldown
    }
    expect(m.vanishCount).toBe(3)
    expect(m.returnCount).toBe(3)
  })
})
