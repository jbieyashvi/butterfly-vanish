// Labeled demo mode: a procedural room and a synthetic silhouette stand in for
// the camera so the whole pipeline (background capture, masked dissolve,
// gestures through the real detectors) can be exercised without a webcam.
// The mask comes from the synthetic figure itself, not from MediaPipe.

import type { HandObs } from './gesture'
import type { MaskField } from './mask'
import { type HandScriptName, makeHand, scriptPinch } from './syntheticHand'

export const DEMO_W = 1280
export const DEMO_H = 720
const MASK_W = 256
const MASK_H = 144

export class DemoSource {
  readonly canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private room = document.createElement('canvas')
  private maskCanvas = document.createElement('canvas')
  private maskCtx: CanvasRenderingContext2D
  private maskBuf = new Float32Array(MASK_W * MASK_H)
  /** horizontal offset of the figure in source px; walks off-frame during setup */
  private offset = 0
  private targetOffset = 0
  private script: { name: HandScriptName; t0: number } | null = null
  scriptName: HandScriptName | null = null
  handU = 0
  handV = 0

  constructor() {
    this.canvas.width = DEMO_W
    this.canvas.height = DEMO_H
    this.ctx = this.canvas.getContext('2d')!
    this.room.width = DEMO_W
    this.room.height = DEMO_H
    this.maskCanvas.width = MASK_W
    this.maskCanvas.height = MASK_H
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true })!
    drawRoom(this.room.getContext('2d')!)
  }

  setPresent(present: boolean) {
    this.targetOffset = present ? 0 : -DEMO_W * 0.75
  }

  get present() {
    return Math.abs(this.offset - this.targetOffset) < 4 && this.targetOffset === 0
  }

  get absent() {
    return Math.abs(this.offset - this.targetOffset) < 4 && this.targetOffset !== 0
  }

  runScript(name: HandScriptName, now: number) {
    this.script = { name, t0: now }
    this.scriptName = name
  }

  /** Advance the figure and redraw the frame. */
  update(dt: number, t: number) {
    const k = 1 - Math.exp(-2.2 * dt)
    const d = this.targetOffset - this.offset
    this.offset += Math.sign(d) * Math.min(Math.abs(d), Math.max(Math.abs(d) * k, 260 * dt))
    const ctx = this.ctx
    ctx.drawImage(this.room, 0, 0)
    // gentle sway so the mask is alive, like a real person
    const sway = Math.sin(t * 0.9) * 10 + Math.sin(t * 2.3) * 3
    const cx = DEMO_W * 0.52 + this.offset + sway
    const breathe = Math.sin(t * 1.6) * 3
    drawFigure(ctx, cx, breathe, false)
    // mild sensor noise flicker so frames are not identical
    ctx.fillStyle = `rgba(255,250,240,${0.012 + 0.01 * Math.sin(t * 13)})`
    ctx.fillRect(0, 0, DEMO_W, DEMO_H)

    const m = this.maskCtx
    m.setTransform(MASK_W / DEMO_W, 0, 0, MASK_H / DEMO_H, 0, 0)
    m.fillStyle = '#000'
    m.fillRect(0, 0, DEMO_W, DEMO_H)
    m.filter = 'blur(2px)'
    drawFigure(m, cx, breathe, true)
    m.filter = 'none'
    // raised hand in source UV (the figure's own right hand)
    this.handU = (cx + 238) / DEMO_W
    this.handV = (226 + breathe) / DEMO_H
  }

  writeMask(mask: MaskField, now: number) {
    const data = this.maskCtx.getImageData(0, 0, MASK_W, MASK_H).data
    const buf = this.maskBuf
    for (let i = 0; i < buf.length; i++) buf[i] = data[i * 4] / 255
    mask.ingest(buf, MASK_W, MASK_H, now)
  }

  /** Synthetic hand observation for the running script (empty = no hand seen). */
  hands(now: number): HandObs[] {
    if (!this.script) return []
    const s = scriptPinch(this.script.name, (now - this.script.t0) / 1000)
    if (s.done) {
      this.script = null
      this.scriptName = null
      return []
    }
    if (!s.present) return []
    return [makeHand(s.pinch, this.handU, this.handV, 0.11, DEMO_W / DEMO_H, 'Right')]
  }

  /** The room alone, as if captured with nobody in frame. */
  drawEmptyRoom(ctx: CanvasRenderingContext2D) {
    ctx.drawImage(this.room, 0, 0)
  }
}

function drawFigure(ctx: CanvasRenderingContext2D, cx: number, breathe: number, mask: boolean) {
  const skin = mask ? '#fff' : '#d9a988'
  const sweater = mask ? '#fff' : '#6f6a86'
  const hair = mask ? '#fff' : '#2e2622'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // torso
  ctx.fillStyle = sweater
  ctx.beginPath()
  ctx.moveTo(cx - 150, DEMO_H + 20)
  ctx.lineTo(cx - 140, 380 + breathe)
  ctx.quadraticCurveTo(cx - 132, 318 + breathe, cx - 70, 312 + breathe)
  ctx.lineTo(cx + 70, 312 + breathe)
  ctx.quadraticCurveTo(cx + 132, 318 + breathe, cx + 140, 380 + breathe)
  ctx.lineTo(cx + 150, DEMO_H + 20)
  ctx.closePath()
  ctx.fill()
  // hanging arm
  ctx.strokeStyle = sweater
  ctx.lineWidth = 58
  ctx.beginPath()
  ctx.moveTo(cx - 118, 360 + breathe)
  ctx.quadraticCurveTo(cx - 168, 500, cx - 162, 640)
  ctx.stroke()
  // raised arm: shoulder -> elbow -> hand
  ctx.beginPath()
  ctx.moveTo(cx + 116, 360 + breathe)
  ctx.lineTo(cx + 230, 420 + breathe * 0.5)
  ctx.lineTo(cx + 240, 290 + breathe)
  ctx.stroke()
  // hand
  ctx.fillStyle = skin
  ctx.beginPath()
  ctx.ellipse(cx + 240, 250 + breathe, 30, 44, 0.05, 0, Math.PI * 2)
  ctx.fill()
  // neck + head
  ctx.fillRect(cx - 26, 250 + breathe, 52, 70)
  ctx.beginPath()
  ctx.ellipse(cx, 212 + breathe, 64, 80, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = hair
  ctx.beginPath()
  ctx.ellipse(cx, 178 + breathe, 70, 54, 0, Math.PI, Math.PI * 2.0)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(cx - 52, 215 + breathe, 20, 50, 0.1, 0, Math.PI * 2)
  ctx.fill()
}

function drawRoom(ctx: CanvasRenderingContext2D) {
  const W = DEMO_W
  const H = DEMO_H
  // warm wall
  const wall = ctx.createLinearGradient(0, 0, W, H)
  wall.addColorStop(0, '#cfc5b6')
  wall.addColorStop(1, '#a89c8c')
  ctx.fillStyle = wall
  ctx.fillRect(0, 0, W, H)
  // window with soft daylight
  const wx = 760
  const wy = 90
  const ww = 330
  const wh = 300
  const sky = ctx.createLinearGradient(0, wy, 0, wy + wh)
  sky.addColorStop(0, '#e9f0f6')
  sky.addColorStop(1, '#c9d7e2')
  ctx.fillStyle = '#ece6dc'
  ctx.fillRect(wx - 14, wy - 14, ww + 28, wh + 28)
  ctx.fillStyle = sky
  ctx.fillRect(wx, wy, ww, wh)
  ctx.fillStyle = '#ece6dc'
  ctx.fillRect(wx + ww / 2 - 5, wy, 10, wh)
  ctx.fillRect(wx, wy + wh / 2 - 5, ww, 10)
  const glow = ctx.createRadialGradient(wx + ww / 2, wy + wh / 2, 40, wx + ww / 2, wy + wh / 2, 520)
  glow.addColorStop(0, 'rgba(255,248,232,0.35)')
  glow.addColorStop(1, 'rgba(255,248,232,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  // floor
  const floor = ctx.createLinearGradient(0, 560, 0, H)
  floor.addColorStop(0, '#7d6a58')
  floor.addColorStop(1, '#5e4f42')
  ctx.fillStyle = floor
  ctx.fillRect(0, 560, W, H - 560)
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(0, 556, W, 6)
  // shelf with books
  ctx.fillStyle = '#6d5a48'
  ctx.fillRect(110, 250, 300, 14)
  const books = ['#8a7f9c', '#b9a27a', '#6f8578', '#c4b8a6', '#7b6a8e', '#a07d6c']
  let bx = 128
  for (let i = 0; i < 9; i++) {
    const bw = 18 + ((i * 7) % 13)
    const bh = 70 + ((i * 23) % 30)
    ctx.fillStyle = books[i % books.length]
    ctx.fillRect(bx, 250 - bh, bw, bh)
    bx += bw + 3
  }
  // plant
  ctx.fillStyle = '#8e7461'
  ctx.fillRect(1120, 470, 80, 100)
  ctx.fillStyle = '#5f7a5c'
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i - 4) * 0.28
    ctx.beginPath()
    ctx.ellipse(1160 + Math.cos(a) * 60, 450 + Math.sin(a) * 70, 16, 54, a + Math.PI / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  // lamp
  ctx.fillStyle = '#3d3632'
  ctx.fillRect(196, 330, 8, 230)
  ctx.fillStyle = '#efe4cf'
  ctx.beginPath()
  ctx.moveTo(160, 330)
  ctx.lineTo(240, 330)
  ctx.lineTo(222, 270)
  ctx.lineTo(178, 270)
  ctx.closePath()
  ctx.fill()
  // a little texture so the background reads as a photo, not flat fills
  const img = ctx.getImageData(0, 0, W, H)
  let s = 7
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const n = ((s >> 16) & 15) - 7
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)
}
