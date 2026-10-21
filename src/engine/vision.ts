// MediaPipe person segmentation + hand landmarks, all on-device. Models and
// WASM are served from this app's own /public folder; nothing is uploaded.

import { FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { HandObs } from './gesture'
import type { MaskField } from './mask'

type Source = HTMLVideoElement | HTMLCanvasElement

export interface VisionStats {
  delegate: 'GPU' | 'CPU'
  segMs: number
  handMs: number
  maskW: number
  maskH: number
  maskCount: number
  frames: number
}

const SEG_WIDTH = 256

export class VisionTracker {
  hands: HandObs[] = []
  handsAt = -Infinity
  readonly stats: VisionStats = { delegate: 'GPU', segMs: 0, handMs: 0, maskW: 0, maskH: 0, maskCount: 0, frames: 0 }
  private segmenter: ImageSegmenter | null = null
  private landmarker: HandLandmarker | null = null
  private segCanvas = document.createElement('canvas')
  private segCtx: CanvasRenderingContext2D
  private lastTs = 0
  private flip = false
  private closed = false

  constructor() {
    this.segCtx = this.segCanvas.getContext('2d', { willReadFrequently: false })!
  }

  get ready() {
    return !!this.segmenter && !!this.landmarker
  }

  async init(onProgress?: (msg: string) => void) {
    const base = import.meta.env.BASE_URL
    onProgress?.('Loading vision runtime')
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`)
    const make = async (delegate: 'GPU' | 'CPU') => {
      onProgress?.('Loading person segmentation')
      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/selfie_segmenter.tflite`, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      })
      onProgress?.('Loading hand tracking')
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      })
      return { segmenter, landmarker }
    }
    let res
    try {
      res = await make('GPU')
      this.stats.delegate = 'GPU'
    } catch (err) {
      console.warn('[vision] GPU delegate failed, using CPU', err)
      res = await make('CPU')
      this.stats.delegate = 'CPU'
    }
    if (this.closed) {
      res.segmenter.close()
      res.landmarker.close()
      return
    }
    this.segmenter = res.segmenter
    this.landmarker = res.landmarker
  }

  private ts(now: number) {
    const t = Math.max(now, this.lastTs + 1)
    this.lastTs = t
    return t
  }

  /**
   * Process one camera frame. When frames are slow, segmentation and hands
   * alternate so neither starves the render loop.
   */
  step(src: Source, now: number, mask: MaskField, opts: { seg: boolean; hands: boolean; alternate: boolean }) {
    if (!this.ready) return
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.width
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.height
    if (!sw || !sh) return
    let doSeg = opts.seg
    let doHands = opts.hands
    if (opts.alternate && doSeg && doHands) {
      this.flip = !this.flip
      doSeg = this.flip
      doHands = !this.flip
    }
    if (doSeg) this.segment(src, sw, sh, now, mask)
    if (doHands) this.detectHands(src, now)
    this.stats.frames++
  }

  segment(src: Source, sw: number, sh: number, now: number, mask: MaskField) {
    const w = SEG_WIDTH
    const h = Math.max(1, Math.round((SEG_WIDTH * sh) / sw))
    if (this.segCanvas.width !== w || this.segCanvas.height !== h) {
      this.segCanvas.width = w
      this.segCanvas.height = h
    }
    this.segCtx.drawImage(src, 0, 0, w, h)
    const t0 = performance.now()
    this.segmenter!.segmentForVideo(this.segCanvas, this.ts(now), (result) => {
      const masks = result.confidenceMasks
      if (!masks || masks.length === 0) return
      // selfie_segmenter yields a single person-confidence mask; a two-class
      // output would put the person in index 1.
      const m = masks.length > 1 ? masks[1] : masks[0]
      mask.ingest(m.getAsFloat32Array(), m.width, m.height, now)
      this.stats.maskW = m.width
      this.stats.maskH = m.height
      this.stats.maskCount = masks.length
    })
    this.stats.segMs = this.stats.segMs * 0.8 + (performance.now() - t0) * 0.2
  }

  detectHands(src: Source, now: number) {
    const t0 = performance.now()
    const r = this.landmarker!.detectForVideo(src, this.ts(now))
    this.stats.handMs = this.stats.handMs * 0.8 + (performance.now() - t0) * 0.2
    const out: HandObs[] = []
    for (let i = 0; i < r.landmarks.length; i++) {
      const cat = r.handedness[i]?.[0]
      out.push({
        landmarks: r.landmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z })),
        handedness: cat?.categoryName ?? `h${i}`,
        score: cat?.score ?? 0,
      })
    }
    this.hands = out
    this.handsAt = now
  }

  close() {
    this.closed = true
    this.segmenter?.close()
    this.landmarker?.close()
    this.segmenter = null
    this.landmarker = null
  }
}
