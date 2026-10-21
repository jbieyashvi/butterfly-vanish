// Orchestrator: camera / demo source, background capture flow, tracking loop,
// gesture -> state machine, dissolve and return timelines, and rendering.
// React only observes snapshots; everything per-frame stays in here.

import { type CoverMap, computeCover, uvToScreen } from './coords'
import { DemoSource, DEMO_H, DEMO_W } from './demo'
import { OpenPalmDetector, PinchReleaseDetector, type HandObs, type PinchPhase } from './gesture'
import { MaskField } from './mask'
import { sampleNoise } from './noise'
import { QualityGovernor, type Tier } from './perf'
import { ButterflySystem } from './render/butterflies'
import { DUST_FLARE, DUST_GLINT, DUST_MOTE, DustSystem } from './render/dust'
import { type CompositeParams, NOISE_SCALE, Stage } from './render/stage'
import { TransformMachine, type TransformState } from './stateMachine'
import type { HandScriptName } from './syntheticHand'
import { VisionTracker } from './vision'

export type Phase = 'intro' | 'loading' | 'setup' | 'live' | 'error'
export type SetupStep = 'position' | 'countdown' | 'review' | 'enter'
export type SourceMode = 'camera' | 'demo'

export interface ErrorInfo {
  title: string
  body: string
  canRetry: boolean
}

export interface SelfTestResult {
  ok: boolean
  lines: string[]
}

export interface Snapshot {
  phase: Phase
  mode: SourceMode | null
  setupStep: SetupStep
  countdown: number
  state: TransformState
  loadingMsg: string
  error: ErrorInfo | null
  notice: string
  bgWarning: string
  pinchPhase: PinchPhase
  reducedMotion: boolean
  tier: Tier
  vanishCount: number
  returnCount: number
  demoScript: HandScriptName | null
  selfTest: SelfTestResult | null
  selfTestRunning: boolean
}

export interface PalmIndicator {
  visible: boolean
  progress: number
  x: number
  y: number
}

const COUNTDOWN_S = 5
const BG_FRAMES = 6
const MIN_COVERAGE = 0.012
const EDGE_W = 0.05
const NOISE_AMP = 0.1

const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

interface Timeline {
  kind: 'vanish' | 'return'
  start: number
  originU: number
  originV: number
  rStart: number
  rEnd: number
  r: number
  prevR: number
  duration: number
  // vanish
  budget: number
  startArea: number
  carry: number
  // return
  T0: number
  Treveal: number
  baseCx: number
  baseCy: number
}

export class Experience {
  private canvas: HTMLCanvasElement
  private stage: Stage
  private butterflies: ButterflySystem
  private dust: DustSystem
  private mask = new MaskField()
  private machine = new TransformMachine()
  private pinch = new PinchReleaseDetector()
  private palm = new OpenPalmDetector()
  private governor = new QualityGovernor()
  private tracker: VisionTracker | null = null
  private demo: DemoSource | null = null
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private bgCanvas = document.createElement('canvas')
  private bgCtx: CanvasRenderingContext2D
  private srcW = 1280
  private srcH = 720
  private cover: CoverMap = computeCover(1280, 720, 1, 1)
  private raf = 0
  private vfc = 0
  private lastFrame = 0
  private lastTrack = 0
  private time = 0
  private paused = false
  private disposed = false
  private countdownEnd = 0
  private bgCapturing = 0
  private enterSince = -1
  private keys = new Float32Array(0)
  private band = new Int32Array(0)
  private tl: Timeline | null = null
  private prevCx = 0.5
  private prevCy = 0.5
  private followVx = 0
  private followVy = 0
  private snap: Snapshot
  private listeners = new Set<() => void>()
  private palmListener: ((p: PalmIndicator) => void) | null = null
  private palmInd: PalmIndicator = { visible: false, progress: 0, x: 0, y: 0 }
  private tmp = { x: 0, y: 0 }
  private tmp2 = { x: 0, y: 0 }
  private onResize = () => this.resize()
  private onVisibility = () => this.handleVisibility()
  private onPageHide = () => this.stopCamera()

  constructor(canvas: HTMLCanvasElement, reducedMotion: boolean) {
    this.canvas = canvas
    this.stage = new Stage(canvas)
    this.butterflies = new ButterflySystem(200)
    this.dust = new DustSystem(2000)
    this.stage.fxScene.add(this.butterflies.mesh)
    this.stage.fxScene.add(this.dust.points)
    this.bgCtx = this.bgCanvas.getContext('2d')!
    this.snap = {
      phase: 'intro',
      mode: null,
      setupStep: 'position',
      countdown: 0,
      state: 'setup',
      loadingMsg: '',
      error: null,
      notice: '',
      bgWarning: '',
      pinchPhase: 'idle',
      reducedMotion,
      tier: this.governor.tier,
      vanishCount: 0,
      returnCount: 0,
      demoScript: null,
      selfTest: null,
      selfTestRunning: false,
    }
    this.machine.onChange((s) => this.patch({ state: s }))
    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPageHide)
    this.resize()
    this.lastFrame = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.exposeDebug()
  }

  // ---------------------------------------------------------------- snapshots

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snap

  private patch(p: Partial<Snapshot>) {
    let changed = false
    for (const k in p) {
      const key = k as keyof Snapshot
      if (this.snap[key] !== p[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.snap = { ...this.snap, ...p }
    for (const l of this.listeners) l()
  }

  onPalm(fn: ((p: PalmIndicator) => void) | null) {
    this.palmListener = fn
  }

  // ---------------------------------------------------------------- sources

  async startCamera() {
    if (this.snap.phase === 'loading') return
    this.resetAll()
    this.patch({ phase: 'loading', mode: 'camera', loadingMsg: 'Waiting for camera permission', error: null })
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('Camera not available', 'This browser does not expose a camera API here. Open the app over http://localhost or https in a current Chrome, Edge, Safari or Firefox.', false)
      return
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      })
    } catch (err) {
      const name = (err as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError')
        this.fail('Camera permission was blocked', 'Allow camera access for this site (the camera icon in the address bar), then press Try again. Frames are processed only on this device.', true)
      else if (name === 'NotFoundError' || name === 'OverconstrainedError')
        this.fail('No camera found', 'Connect a webcam (or enable the built-in one) and press Try again.', true)
      else if (name === 'NotReadableError' || name === 'AbortError')
        this.fail('The camera is busy', 'Another app or tab is using the camera. Close it (video calls, other camera pages) and press Try again.', true)
      else this.fail('Could not start the camera', String((err as Error)?.message ?? err), true)
      return
    }
    if (this.disposed) return this.stopCamera()
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.srcObject = this.stream
    this.video = video
    try {
      await video.play()
    } catch {
      /* autoplay of a muted stream is allowed; ignore spurious rejections */
    }
    await new Promise<void>((res) => {
      if (video.videoWidth) res()
      else video.addEventListener('loadedmetadata', () => res(), { once: true })
    })
    this.setSourceSize(video.videoWidth, video.videoHeight)
    this.stage.setLiveSource(video)

    const ok = await this.loadVision()
    if (!ok || this.disposed) return
    this.enterSetup()
    this.scheduleVideoFrame()
  }

  async startDemo() {
    if (this.snap.phase === 'loading') return
    this.resetAll()
    this.demo = new DemoSource()
    this.demo.update(0, 0)
    this.setSourceSize(DEMO_W, DEMO_H)
    this.stage.setLiveSource(this.demo.canvas)
    this.patch({ mode: 'demo', error: null })
    this.enterSetup()
  }

  private async loadVision(): Promise<boolean> {
    this.tracker = new VisionTracker()
    try {
      await this.tracker.init((msg) => this.patch({ loadingMsg: msg }))
      return true
    } catch (err) {
      console.error('[vision] init failed', err)
      this.fail(
        'Person segmentation could not start',
        'The on-device segmentation model failed to load, so the background cannot be revealed. Reload the page; if it persists, use a current Chrome or Edge with hardware acceleration enabled (Settings → System). You can still explore the effect in demo mode.',
        true,
      )
      this.tracker.close()
      this.tracker = null
      return false
    }
  }

  private fail(title: string, body: string, canRetry: boolean) {
    this.stopCamera()
    this.patch({ phase: 'error', error: { title, body, canRetry } })
  }

  private setSourceSize(w: number, h: number) {
    this.srcW = w
    this.srcH = h
    this.bgCanvas.width = w
    this.bgCanvas.height = h
    this.resize()
  }

  private scheduleVideoFrame() {
    const v = this.video
    if (!v || this.disposed) return
    if ('requestVideoFrameCallback' in v) {
      this.vfc = v.requestVideoFrameCallback(() => {
        this.track(performance.now())
        this.scheduleVideoFrame()
      })
    }
  }

  stopCamera() {
    if (this.video && this.vfc && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.vfc)
    this.vfc = 0
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.video) {
      this.video.pause()
      this.video.srcObject = null
    }
    this.video = null
  }

  // ---------------------------------------------------------------- setup flow

  private enterSetup() {
    this.machine.enterSetup(performance.now())
    this.stage.setBackground(null)
    this.patch({ phase: 'setup', setupStep: 'position', countdown: 0, bgWarning: '', notice: '' })
  }

  beginCapture() {
    if (this.snap.phase !== 'setup' && this.snap.phase !== 'live') return
    this.abortTransform()
    this.machine.enterSetup(performance.now())
    this.stage.setBackground(null)
    this.demo?.setPresent(false)
    this.countdownEnd = performance.now() + COUNTDOWN_S * 1000
    this.patch({ phase: 'setup', setupStep: 'countdown', countdown: COUNTDOWN_S, bgWarning: '', notice: '' })
  }

  retake() {
    this.beginCapture()
  }

  acceptBackground() {
    if (this.snap.setupStep !== 'review') return
    this.demo?.setPresent(true)
    this.enterSince = -1
    this.patch({ setupStep: 'enter', notice: '' })
  }

  /** Manual confirmation when automatic presence detection is unsure. */
  confirmInFrame() {
    if (this.snap.phase !== 'setup' || this.snap.setupStep !== 'enter') return
    this.goLive()
  }

  private goLive() {
    this.pinch.reset()
    this.palm.reset()
    this.patch({ phase: 'live', notice: '' })
    this.machine.enterReady(performance.now())
  }

  private captureFrame() {
    const src = this.demo ? this.demo.canvas : this.video
    if (!src) return
    const k = this.bgCapturing
    // running mean over a few frames to suppress sensor noise
    this.bgCtx.globalAlpha = 1 / (k + 1)
    if (this.demo) {
      this.bgCtx.globalAlpha = 1
      this.demo.drawEmptyRoom(this.bgCtx)
    } else this.bgCtx.drawImage(src, 0, 0, this.srcW, this.srcH)
    this.bgCtx.globalAlpha = 1
    this.bgCapturing++
    if (this.bgCapturing >= BG_FRAMES) {
      this.bgCapturing = 0
      this.stage.setBackground(this.bgCanvas)
      const cov = this.mask.coverage
      this.patch({
        setupStep: 'review',
        bgWarning:
          cov > 0.02
            ? 'Someone may still be in frame — parts of a person would stay visible after vanishing. Retake with the frame empty.'
            : '',
      })
    }
  }

  // ---------------------------------------------------------------- controls

  setReducedMotion(on: boolean) {
    this.patch({ reducedMotion: on })
  }

  /** Keyboard / button fallback for the pinch-release gesture. */
  triggerVanish() {
    if (this.snap.phase !== 'live') return
    const m = this.mask
    this.startVanish(m.cx, m.minV + (m.maxV - m.minV) * 0.25, performance.now())
  }

  triggerReturn() {
    if (this.snap.phase !== 'live') return
    this.startReturn(performance.now())
  }

  runDemoScript(name: HandScriptName) {
    if (!this.demo || this.demo.scriptName) return
    this.demo.runScript(name, performance.now())
    this.patch({ demoScript: name })
  }

  reset() {
    this.abortTransform()
    this.stopCamera()
    this.tracker?.close()
    this.tracker = null
    this.demo = null
    this.mask.clear()
    this.stage.clearMask()
    this.stage.setBackground(null)
    this.machine.enterSetup(performance.now())
    this.patch({ phase: 'intro', mode: null, error: null, notice: '', bgWarning: '', demoScript: null, selfTest: null })
  }

  private resetAll() {
    this.abortTransform()
    this.stopCamera()
    this.tracker?.close()
    this.tracker = null
    this.demo = null
    this.mask.clear()
    this.stage.clearMask()
  }

  private abortTransform() {
    this.tl = null
    this.butterflies.clear()
    this.dust.clear()
    this.pinch.reset()
    this.palm.reset()
    this.emitPalm(false, 0, 0, 0)
  }

  // ---------------------------------------------------------------- tracking

  private track(now: number) {
    if (this.paused || this.disposed) return
    if (this.demo) {
      this.demo.writeMask(this.mask, now)
      this.onHands(this.demo.hands(now), now)
      if (!this.demo.scriptName && this.snap.demoScript) this.patch({ demoScript: null })
      return
    }
    const t = this.tracker
    const v = this.video
    if (!t || !v || !t.ready) return
    const live = this.snap.phase === 'live'
    const handsNeeded = live && (this.machine.state === 'ready' || this.machine.state === 'vanished')
    // when slow, alternate the two models; segmentation keeps priority otherwise
    const slow = t.stats.segMs + t.stats.handMs > 26
    t.step(v, now, this.mask, { seg: true, hands: handsNeeded, alternate: slow })
    this.onHands(handsNeeded ? t.hands : [], now)
  }

  private onHands(hands: HandObs[], now: number) {
    if (this.snap.phase !== 'live') return
    const aspect = this.srcW / this.srcH
    const state = this.machine.state
    const ev = this.pinch.update(state === 'ready' ? hands : [], now, aspect)
    this.patch({ pinchPhase: this.pinch.phase })
    if (ev && state === 'ready') this.startVanish(ev.u, ev.v, now)

    if (state === 'vanished') {
      const p = this.palm.update(hands, now, aspect)
      if (p.visible) {
        uvToScreen(this.cover, p.u, p.v, this.tmp)
        this.emitPalm(true, p.progress, this.tmp.x, this.tmp.y)
      } else this.emitPalm(false, 0, 0, 0)
      if (p.fired) this.startReturn(now)
    } else if (this.palmInd.visible) {
      this.palm.reset()
      this.emitPalm(false, 0, 0, 0)
    }
  }

  private emitPalm(visible: boolean, progress: number, x: number, y: number) {
    const p = this.palmInd
    if (!visible && !p.visible) return
    p.visible = visible
    p.progress = progress
    p.x = x
    p.y = y
    this.palmListener?.(p)
  }

  // ---------------------------------------------------------------- transforms

  private computeKeys(ou: number, ov: number) {
    const m = this.mask
    const n = m.w * m.h
    if (this.keys.length !== n) {
      this.keys = new Float32Array(n)
      this.band = new Int32Array(n)
    }
    const aspect = this.srcW / this.srcH
    const noise = this.stage.noiseData
    let minK = Infinity
    let maxK = -Infinity
    for (let y = 0; y < m.h; y++) {
      const v = (y + 0.5) / m.h
      for (let x = 0; x < m.w; x++) {
        const u = (x + 0.5) / m.w
        const dx = (u - ou) * aspect
        const dy = v - ov
        const nz = sampleNoise(noise, u * aspect * NOISE_SCALE, v * NOISE_SCALE)
        const k = Math.sqrt(dx * dx + dy * dy) + NOISE_AMP * (nz * 2 - 1)
        const i = y * m.w + x
        this.keys[i] = k
        if (m.value[i] > 0.5) {
          if (k < minK) minK = k
          if (k > maxK) maxK = k
        }
      }
    }
    return { minK, maxK }
  }

  private startVanish(u: number, v: number, now: number) {
    if (!this.machine.canVanish(now)) return
    if (this.mask.coverage < MIN_COVERAGE || this.mask.w === 0) {
      this.patch({ notice: "I can't see you in the frame yet — step into view, then try again." })
      return
    }
    if (!this.machine.requestVanish(now)) return
    const { minK, maxK } = this.computeKeys(u, v)
    const reduced = this.snap.reducedMotion
    const budget = Math.min(this.butterflies.cap, this.governor.settings.butterflies) * (reduced ? 0.45 : 1)
    this.tl = {
      kind: 'vanish',
      start: now,
      originU: u,
      originV: v,
      rStart: Math.min(minK, 0) - EDGE_W,
      rEnd: maxK + EDGE_W + 0.06,
      r: Math.min(minK, 0) - EDGE_W,
      prevR: -Infinity,
      duration: reduced ? 1.4 : 1.0,
      budget,
      startArea: Math.max(1, this.mask.count),
      carry: 0,
      T0: 0,
      Treveal: 0,
      baseCx: this.mask.cx,
      baseCy: this.mask.cy,
    }
    this.tl.prevR = this.tl.rStart
    this.patch({ notice: '', vanishCount: this.machine.vanishCount })
    this.butterflies.startWave(3)
    // the spark at the fingertips
    uvToScreen(this.cover, u, v, this.tmp)
    const view = this.stage.view
    view.toWorld(this.tmp.x, this.tmp.y, 0, this.tmp)
    const s = view.sizeScale
    this.dust.emit(this.tmp.x, this.tmp.y, 0, 0, 0, 0, 34 * s, 0.4, DUST_FLARE)
    for (let k = 0; k < (reduced ? 3 : 6); k++) {
      const a = Math.random() * Math.PI * 2
      const sp = 40 + Math.random() * 70
      this.dust.emit(this.tmp.x, this.tmp.y, 0, Math.cos(a) * sp, Math.sin(a) * sp, 0, (2.5 + Math.random() * 3) * s, 0.25 + Math.random() * 0.25, DUST_GLINT)
    }
  }

  private startReturn(now: number) {
    if (!this.machine.canReturn(now)) return
    if (!this.machine.requestReturn(now)) return
    const m = this.mask
    const reduced = this.snap.reducedMotion
    const ou = m.cx
    const ov = m.count > 0 ? Math.max(0, m.minV + (m.maxV - m.minV) * 0.3) : 0.4
    let { minK, maxK } = this.computeKeys(ou, ov)
    if (!isFinite(minK)) {
      minK = 0
      maxK = 0.6
    }
    const T0 = reduced ? 0.45 : 0.3
    const Treveal = reduced ? 0.9 : 0.7
    const tl: Timeline = {
      kind: 'return',
      start: now,
      originU: ou,
      originV: ov,
      rStart: minK - EDGE_W,
      rEnd: maxK + EDGE_W + 0.06,
      r: minK - EDGE_W,
      prevR: minK - EDGE_W,
      duration: T0 + Treveal + 0.3,
      budget: 0,
      startArea: 1,
      carry: 0,
      T0,
      Treveal,
      baseCx: m.cx,
      baseCy: m.cy,
    }
    this.tl = tl
    this.patch({ returnCount: this.machine.returnCount, notice: '' })
    this.emitPalm(false, 0, 0, 0)

    this.butterflies.startWave(2)
    const total = Math.round(Math.min(this.butterflies.cap, this.governor.settings.butterflies) * (reduced ? 0.15 : 0.25))
    const idx = this.band
    const cnt = m.collect(idx, 0.5)
    const keys = this.keys
    const span = Math.max(1e-3, tl.rEnd - tl.rStart)
    this.butterflies.beginReturn(total, this.stage.view, reduced, (out) => {
      if (cnt > 0) {
        const i = idx[(Math.random() * cnt) | 0]
        const x = i % m.w
        const y = (i / m.w) | 0
        out.u = (x + Math.random()) / m.w
        out.v = (y + Math.random()) / m.h
        out.arrive = T0 + clamp01((keys[i] - tl.rStart) / span) * Treveal
      } else {
        out.u = ou + (Math.random() - 0.5) * 0.2
        out.v = ov + Math.random() * 0.4
        out.arrive = T0 + Math.random() * Treveal
      }
    })
  }

  /** Per render frame: advance the active timeline and emit butterflies at the front. */
  private stepTimeline(now: number, p: CompositeParams) {
    const tl = this.tl
    const state = this.machine.state
    p.viewBg = this.snap.phase === 'setup' && this.snap.setupStep === 'review'
    p.envVis = 1
    p.personVis = 1
    p.frontMode = 0
    p.radius = 0
    p.edgeW = EDGE_W
    p.noiseAmp = NOISE_AMP
    p.glow = this.snap.reducedMotion ? 0.6 : 1
    p.originU = 0.5
    p.originV = 0.5

    if (state === 'vanished') {
      p.envVis = 0
      p.personVis = 0
      return
    }
    if (!tl) return
    const el = (now - tl.start) / 1000
    p.originU = tl.originU
    p.originV = tl.originV

    if (tl.kind === 'vanish') {
      p.frontMode = 1
      p.envVis = 1 - smooth(0, 0.35, el)
      const t = clamp01((el - 0.03) / (tl.duration - 0.03 - 0.12))
      tl.r = tl.rStart + (tl.rEnd - tl.rStart) * easeInOutSine(t)
      p.radius = tl.r
      p.glow *= 1 - smooth(tl.duration - 0.2, tl.duration, el)
      this.emitAtFront(tl)
      tl.prevR = tl.r
      if (el >= tl.duration) {
        this.tl = null
        this.machine.finishDissolve(now)
      }
    } else {
      p.frontMode = 2
      // the reveal follows the person as they move
      const du = this.mask.cx - tl.baseCx
      const dv = this.mask.cy - tl.baseCy
      p.originU = tl.originU + du
      p.originV = tl.originV + dv
      const t = clamp01((el - tl.T0) / tl.Treveal)
      tl.r = el < tl.T0 ? tl.rStart : tl.rStart + (tl.rEnd - tl.rStart) * t
      p.radius = tl.r
      p.envVis = smooth(tl.T0 + tl.Treveal - 0.15, tl.T0 + tl.Treveal + 0.25, el)
      p.glow *= 1 - smooth(tl.T0 + tl.Treveal - 0.15, tl.T0 + tl.Treveal + 0.2, el)
      if (el >= tl.duration) {
        this.tl = null
        this.machine.finishReturn(now)
        this.pinch.reset()
      }
    }
  }

  private emitAtFront(tl: Timeline) {
    const m = this.mask
    if (m.w === 0 || this.keys.length !== m.w * m.h) return
    const keys = this.keys
    const val = m.value
    const band = this.band
    const lo = tl.prevR
    const hi = tl.r
    if (hi <= lo) return
    let bc = 0
    for (let i = 0; i < val.length; i++) {
      const k = keys[i]
      if (k >= lo && k < hi && val[i] > 0.5) band[bc++] = i
    }
    if (bc === 0) return
    const reduced = this.snap.reducedMotion
    const want = (tl.budget * bc) / tl.startArea + tl.carry
    let n = Math.floor(want)
    tl.carry = want - n
    n = Math.min(n, reduced ? 6 : 14)
    const view = this.stage.view
    const s = view.sizeScale
    uvToScreen(this.cover, tl.originU, tl.originV, this.tmp2)
    const osx = this.tmp2.x
    const osy = this.tmp2.y
    const tmp = this.tmp
    const emitOne = (butterfly: boolean) => {
      const i = band[(Math.random() * bc) | 0]
      const x = i % m.w
      const y = (i / m.w) | 0
      uvToScreen(this.cover, (x + Math.random()) / m.w, (y + Math.random()) / m.h, tmp)
      const sx = tmp.x
      const sy = tmp.y
      let dx = sx - osx
      let dy = -(sy - osy)
      const len = Math.hypot(dx, dy) || 1
      dx /= len
      dy /= len
      if (butterfly) {
        const z = -80 + Math.random() * 200
        view.toWorld(sx, sy, z, tmp)
        const side = Math.abs(dx) > 0.2 ? Math.sign(dx) : Math.random() < 0.5 ? -1 : 1
        this.butterflies.spawnVanish(tmp.x, tmp.y, z, dx, dy, side, view, reduced)
      } else {
        view.toWorld(sx, sy, 0, tmp)
        this.dust.emit(tmp.x, tmp.y, 0, dx * 25 + (Math.random() - 0.5) * 20, dy * 25 + Math.random() * 20, 0,
          (1.5 + Math.random() * 2.5) * s, 0.25 + Math.random() * 0.35, Math.random() < 0.12 ? DUST_GLINT : DUST_MOTE)
      }
    }
    for (let k = 0; k < n; k++) emitOne(true)
    const dustN = Math.min(reduced ? 3 : 8, Math.ceil(bc / 80))
    for (let k = 0; k < dustN; k++) emitOne(false)
  }

  // ---------------------------------------------------------------- frame

  private params: CompositeParams = {
    viewBg: false, envVis: 1, personVis: 1, frontMode: 0, originU: 0.5, originV: 0.5, radius: 0, edgeW: EDGE_W, noiseAmp: NOISE_AMP, glow: 1,
  }

  private frame = (now: number) => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    const rawDt = (now - this.lastFrame) / 1000
    this.lastFrame = now
    if (this.paused) return
    const dt = Math.min(0.05, Math.max(0, rawDt))
    this.time += dt
    const phase = this.snap.phase
    if (phase !== 'setup' && phase !== 'live') {
      this.stage.render(this.params, this.time, false, 0)
      return
    }

    if (this.demo) {
      this.demo.update(dt, this.time)
      // demo "camera" runs at ~30 fps, independent of the render rate
      if (now - this.lastTrack >= 33) {
        this.lastTrack = now
        this.track(now)
      }
    } else if (this.video && !('requestVideoFrameCallback' in this.video) && now - this.lastTrack >= 33) {
      this.lastTrack = now
      this.track(now)
    }

    this.tickSetup(now)
    this.stage.updateMask(this.mask)

    // silhouette motion, for butterflies hovering with the body
    uvToScreen(this.cover, this.mask.cx, this.mask.cy, this.tmp)
    const cx = this.tmp.x
    const cy = this.tmp.y
    uvToScreen(this.cover, this.prevCx, this.prevCy, this.tmp)
    if (dt > 0) {
      const k = 1 - Math.exp(-6 * dt)
      this.followVx += (((cx - this.tmp.x) / dt) - this.followVx) * k
      this.followVy += ((-(cy - this.tmp.y) / dt) - this.followVy) * k
    }
    this.prevCx = this.mask.cx
    this.prevCy = this.mask.cy

    const p = this.params
    this.stepTimeline(now, p)

    const tl = this.tl
    const returnT = tl && tl.kind === 'return' ? (now - tl.start) / 1000 : 0
    const view = this.stage.view
    if (this.butterflies.n > 0 || this.dust.n > 0) {
      this.butterflies.update(dt, {
        t: this.time,
        reduced: this.snap.reducedMotion,
        view,
        cover: this.cover,
        followVx: this.followVx,
        followVy: this.followVy,
        returnT,
        targetDu: tl && tl.kind === 'return' ? this.mask.cx - tl.baseCx : 0,
        targetDv: tl && tl.kind === 'return' ? this.mask.cy - tl.baseCy : 0,
        dust: this.dust,
      })
      this.dust.update(dt, this.time)
    }
    const fxActive = this.butterflies.n > 0 || this.dust.n > 0
    this.stage.render(p, this.time, fxActive, this.snap.reducedMotion ? 0.12 : 0.18)

    const state = this.machine.state
    const idle = state === 'ready' || state === 'vanished' || state === 'setup'
    if (this.governor.sample(rawDt * 1000, idle && this.butterflies.n === 0)) this.applyTier()
  }

  private tickSetup(now: number) {
    if (this.snap.phase !== 'setup') return
    const step = this.snap.setupStep
    if (step === 'countdown') {
      if (this.bgCapturing > 0) {
        this.captureFrame()
        return
      }
      const left = Math.ceil((this.countdownEnd - now) / 1000)
      if (left <= 0) {
        this.captureFrame()
      } else this.patch({ countdown: left })
    } else if (step === 'enter') {
      if (this.mask.coverage > 0.03 && (!this.demo || this.demo.present)) {
        if (this.enterSince < 0) this.enterSince = now
        if (now - this.enterSince > 700) this.goLive()
      } else this.enterSince = -1
    }
  }

  private applyTier() {
    const s = this.governor.settings
    this.dust.limit = s.dust
    this.patch({ tier: this.governor.tier })
    this.resize()
  }

  private resize() {
    const W = Math.max(1, this.canvas.clientWidth || window.innerWidth)
    const H = Math.max(1, this.canvas.clientHeight || window.innerHeight)
    const pr = this.governor.settings.pixelRatio
    this.stage.resize(W, H, pr)
    this.cover = computeCover(this.srcW, this.srcH, W, H, true)
    this.stage.setCover(this.cover, this.srcW / this.srcH)
    this.dust.material.uniforms.uPx.value = pr
    this.dust.material.uniforms.uCamZ.value = this.stage.view.D
    this.dust.limit = this.governor.settings.dust
  }

  private handleVisibility() {
    const hidden = document.visibilityState === 'hidden'
    this.paused = hidden
    if (hidden) {
      // a background capture must not run while nobody is watching
      if (this.snap.phase === 'setup' && this.snap.setupStep === 'countdown') {
        this.bgCapturing = 0
        this.demo?.setPresent(true)
        this.patch({ setupStep: 'position', notice: 'Capture paused while the tab was hidden — start it again when ready.' })
      }
      this.pinch.reset()
      this.palm.reset()
    } else {
      this.lastFrame = performance.now()
    }
  }

  // ---------------------------------------------------------------- self-test

  /** Runs the real MediaPipe models on one demo frame and reports what came back. */
  async runModelSelfTest() {
    if (this.snap.selfTestRunning) return
    this.patch({ selfTestRunning: true, selfTest: null })
    const lines: string[] = []
    let ok = false
    const tracker = new VisionTracker()
    try {
      const t0 = performance.now()
      await tracker.init()
      lines.push(`Models loaded in ${Math.round(performance.now() - t0)} ms (${tracker.stats.delegate} delegate)`)
      const demo = new DemoSource()
      demo.update(0, 0)
      const field = new MaskField()
      const t1 = performance.now()
      tracker.segment(demo.canvas, DEMO_W, DEMO_H, performance.now(), field)
      lines.push(`Segmentation ran in ${Math.round(performance.now() - t1)} ms: ${tracker.stats.maskCount} mask(s), ${field.w}×${field.h}`)
      lines.push(`Person coverage on the synthetic figure: ${(field.coverage * 100).toFixed(1)}% (a drawn figure may not read as a person)`)
      tracker.detectHands(demo.canvas, performance.now() + 1)
      lines.push(`Hand landmarker ran: ${tracker.hands.length} hand(s) on the synthetic frame (none expected)`)
      ok = field.w > 0
    } catch (err) {
      lines.push(`Failed: ${String((err as Error)?.message ?? err)}`)
    } finally {
      tracker.close()
    }
    if (!this.disposed) this.patch({ selfTestRunning: false, selfTest: { ok, lines } })
  }

  // ---------------------------------------------------------------- debug + teardown

  private exposeDebug() {
    const self = this
    ;(window as unknown as { __bv: unknown }).__bv = {
      get state() {
        return self.machine.state
      },
      get phase() {
        return self.snap.phase
      },
      get vanishCount() {
        return self.machine.vanishCount
      },
      get returnCount() {
        return self.machine.returnCount
      },
      get butterflies() {
        return self.butterflies.n
      },
      get dust() {
        return self.dust.n
      },
      get coverage() {
        return self.mask.coverage
      },
      get tier() {
        return self.governor.tier
      },
      get fps() {
        return 1000 / self.governor.ema
      },
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.stopCamera()
    this.tracker?.close()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pagehide', this.onPageHide)
    this.butterflies.dispose()
    this.dust.dispose()
    this.stage.dispose()
    this.listeners.clear()
    delete (window as unknown as { __bv?: unknown }).__bv
  }
}
