// Instanced butterflies: two hinged wing strips per instance, flapping in the
// vertex shader. Simulation lives in packed typed arrays (swap-remove), and
// instances are written back-to-front each frame.

import {
  BufferAttribute,
  CanvasTexture,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
} from 'three'
import { type CoverMap, uvToScreen } from '../coords'
import { DUST_GLINT, DUST_MOTE, type DustSystem } from './dust'
import type { View } from './view'
import { WING_VARIANTS, createWingAtlas } from './wingTexture'

const vertex = /* glsl */ `
attribute float side;
attribute vec3 iPos;
attribute vec4 iA; // heading, scale, flap phase, alpha
attribute vec4 iB; // variant, tint, pitch, flap amplitude
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
varying float vTint;
varying float vSheen;
void main() {
  float flap = sin(iA.z);
  float a = 0.42 + iB.w * 0.9 * flap;          // wing elevation
  float x = position.x;
  vec3 p;
  p.x = side * x * cos(a);
  p.z = x * sin(a) - x * x * 0.16 * flap;       // tips lag slightly
  p.y = position.y;
  float c = cos(iB.z), s = sin(iB.z);           // body pitch
  p = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  float ch = cos(iA.x), sh = sin(iA.x);         // heading in the screen plane
  p.xy = mat2(ch, sh, -sh, ch) * p.xy;
  p *= iA.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + iPos, 1.0);
  vUv = vec2((iB.x + uv.x) / ${WING_VARIANTS.toFixed(1)}, uv.y);
  vAlpha = iA.w;
  vShade = 0.8 + 0.14 * abs(cos(a));
  vSheen = smoothstep(0.55, 1.0, -flap);
  vTint = iB.y;
}
`

const fragment = /* glsl */ `
uniform sampler2D uWing;
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
varying float vTint;
varying float vSheen;
void main() {
  vec4 t = texture2D(uWing, vUv);      // premultiplied
  float a = t.a * vAlpha;
  if (a < 0.003) discard;
  vec3 c = t.rgb * vShade;
  // per-butterfly silver shading, and a faint cool sheen on the downstroke
  c *= vec3(1.0 - vTint, 1.0 - vTint * 0.9, 1.0 - vTint * 0.6);
  c += t.rgb * vec3(0.05, 0.055, 0.065) * vSheen;
  gl_FragColor = vec4(c * vAlpha, a);
}
`

const MODE_VANISH = 0
const MODE_RETURN = 1

export interface FlightContext {
  /** seconds, monotonically increasing */
  t: number
  reduced: boolean
  view: View
  cover: CoverMap
  /** person's movement in world px/s, so freshly born butterflies stay with the body */
  followVx: number
  followVy: number
  /** seconds since the return started, or -1 */
  returnT: number
  /** shift of the silhouette since the return started, in source UV */
  targetDu: number
  targetDv: number
  dust: DustSystem
}

const tmp = { x: 0, y: 0 }
const fl = { x: 0, y: 0, vx: 0, vy: 0 }
/** the flock's shared path is sampled at this rate for this long */
const PATH_HZ = 60
const PATH_N = 5 * PATH_HZ
/** vanish butterflies fade out by this age (s) even if still on screen */
const MAX_AGE = 2

export class ButterflySystem {
  readonly mesh: Mesh
  readonly cap: number
  n = 0
  private F: Record<string, Float32Array> = {}
  private fields: Float32Array[] = []
  private order: Uint16Array
  private iPos: InstancedBufferAttribute
  private iA: InstancedBufferAttribute
  private iB: InstancedBufferAttribute
  private geometry: InstancedBufferGeometry
  private material: ShaderMaterial
  private texture: CanvasTexture
  private heroesLeft = 0
  private expectedLeft = 1
  private now = 0
  // shared flock path for the current vanish wave (world px), reused across waves
  private pathX = new Float32Array(PATH_N)
  private pathY = new Float32Array(PATH_N)
  private pathVX = new Float32Array(PATH_N)
  private pathVY = new Float32Array(PATH_N)
  private flockT0 = 0
  private flockX = 0
  private flockY = 0
  private flockV = 1
  /** horizontal direction the last flock left toward (+1 right, -1 left, world space) */
  flockSide = 1

  constructor(cap: number) {
    this.cap = cap
    for (const name of [
      'mode', 'age', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'ox', 'oy', 'heading', 'scale', 'baseScale', 'phase',
      'freq', 'amp', 'alpha', 'variant', 'tint', 'pitch', 'curve', 'wobF', 'seed', 'followT',
      'dvz', 'trail', 'ampB', 'birth', 'offX', 'offY', 'bx', 'by', 'sx', 'sy', 'sz', 'cx', 'cy', 'cz', 'tu', 'tv', 't0', 'arrive', 'grow',
    ]) {
      const a = new Float32Array(cap)
      this.F[name] = a
      this.fields.push(a)
    }
    this.order = new Uint16Array(cap)

    const geo = new InstancedBufferGeometry()
    const SEG = 6
    const pos: number[] = []
    const uv: number[] = []
    const side: number[] = []
    const idx: number[] = []
    for (const sgn of [-1, 1]) {
      const base = pos.length / 3
      for (let j = 0; j <= SEG; j++) {
        const x = j / SEG
        for (const y of [-0.75, 0.75]) {
          pos.push(x, y, 0)
          uv.push(x, (y + 0.75) / 1.5)
          side.push(sgn)
        }
      }
      for (let j = 0; j < SEG; j++) {
        const a = base + j * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
    geo.setAttribute('side', new BufferAttribute(new Float32Array(side), 1))
    geo.setIndex(idx)
    this.iPos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(DynamicDrawUsage)
    this.iA = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage)
    this.iB = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage)
    geo.setAttribute('iPos', this.iPos)
    geo.setAttribute('iA', this.iA)
    geo.setAttribute('iB', this.iB)
    geo.instanceCount = 0
    this.geometry = geo

    this.texture = new CanvasTexture(createWingAtlas())
    this.texture.premultiplyAlpha = true
    this.texture.minFilter = LinearMipmapLinearFilter
    this.texture.anisotropy = 4
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uWing: { value: this.texture } },
      side: DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
    })
    this.mesh = new Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
  }

  get returningCount(): number {
    let c = 0
    for (let i = 0; i < this.n; i++) if (this.F.mode[i] === MODE_RETURN) c++
    return c
  }

  clear() {
    this.n = 0
    this.geometry.instanceCount = 0
  }

  private alloc(): number {
    if (this.n >= this.cap) return -1
    const i = this.n++
    for (const a of this.fields) a[i] = 0
    return i
  }

  private kill(i: number) {
    const last = --this.n
    if (i !== last) for (const a of this.fields) a[i] = a[last]
  }

  /**
   * Start a new wave of about `expected` butterflies, `heroes` of them slightly
   * larger focal ones.
   */
  startWave(heroes: number, expected: number) {
    this.heroesLeft = heroes
    this.expectedLeft = Math.max(heroes, expected)
  }

  /**
   * Lay out the shared path of a vanish flock: it lifts off from the silhouette
   * centre at world (x, y) and sweeps diagonally upward toward `side`, curving
   * gently further out. Butterflies steer toward points around this path.
   */
  startFlock(t: number, x: number, y: number, side: number, view: View, reduced: boolean) {
    this.now = t
    this.flockT0 = t
    this.flockX = x
    this.flockY = y
    this.flockSide = side
    const V = view.H * (reduced ? 0.45 : 0.7)
    this.flockV = V
    const th0 = Math.PI / 2 - side * (reduced ? 0.4 : 0.55 + Math.random() * 0.15)
    const bend = side * (0.1 + Math.random() * 0.1)
    const h = 1 / PATH_HZ
    let px = x
    let py = y
    for (let k = 0; k < PATH_N; k++) {
      const tau = k * h
      const r = Math.min(1, tau / 0.35)
      const sp = V * r * r * (3 - 2 * r)
      const th = th0 - bend * tau
      const vx = Math.cos(th) * sp
      const vy = Math.sin(th) * sp
      this.pathX[k] = px
      this.pathY[k] = py
      this.pathVX[k] = vx
      this.pathVY[k] = vy
      px += vx * h
      py += vy * h
    }
  }

  /** Flock path position and velocity at path time tau (s). */
  private pathAt(tau: number, out: { x: number; y: number; vx: number; vy: number }) {
    const f = Math.max(0, tau) * PATH_HZ
    const k = Math.min(PATH_N - 2, Math.floor(f))
    const a = Math.min(1, f - k)
    out.x = this.pathX[k] + (this.pathX[k + 1] - this.pathX[k]) * a
    out.y = this.pathY[k] + (this.pathY[k + 1] - this.pathY[k]) * a
    out.vx = this.pathVX[k] + (this.pathVX[k + 1] - this.pathVX[k]) * a
    out.vy = this.pathVY[k] + (this.pathVY[k + 1] - this.pathVY[k]) * a
  }

  private initLook(i: number, view: View, reduced: boolean) {
    const F = this.F
    // spread the heroes evenly over the wave so 2-3 actually appear
    const hero = this.heroesLeft > 0 && Math.random() < this.heroesLeft / Math.max(1, this.expectedLeft)
    if (hero) this.heroesLeft--
    this.expectedLeft = Math.max(1, this.expectedLeft - 1)
    F.baseScale[i] = view.sizeScale * (hero ? 22 + Math.random() * 5 : 11 + Math.random() * 6)
    F.variant[i] = Math.floor(Math.random() * WING_VARIANTS)
    F.tint[i] = Math.random() * 0.12
    F.pitch[i] = -0.15 - Math.random() * 0.45
    F.freq[i] = (reduced ? 6 : 8) + Math.random() * 6
    F.phase[i] = Math.random() * Math.PI * 2
    F.ampB[i] = (reduced ? 0.5 : 0.65) + Math.random() * 0.3
    F.amp[i] = F.ampB[i]
    F.seed[i] = Math.random() * 100
  }

  /**
   * A butterfly born from the silhouette at world (x, y, z).
   * (ox, oy) is the outward direction of the dissolve front. It joins the
   * current flock (see startFlock).
   */
  spawnVanish(x: number, y: number, z: number, ox: number, oy: number, view: View, reduced: boolean) {
    const i = this.alloc()
    if (i < 0) return
    const F = this.F
    this.initLook(i, view, reduced)
    F.mode[i] = MODE_VANISH
    F.x[i] = x
    F.y[i] = y
    F.z[i] = z
    F.ox[i] = ox
    F.oy[i] = oy
    F.vx[i] = ox * 60
    F.vy[i] = oy * 60 + 30
    F.followT[i] = 0.05 + Math.random() * 0.1
    const rm = reduced ? 0.6 : 1
    // later-born butterflies trail a little behind the head of the flock
    const w = this.now - this.flockT0
    F.birth[i] = w * (0.3 + Math.random() * 0.15)
    // start from where it was born, settle into a loose place in the flock
    F.bx[i] = x - this.flockX
    F.by[i] = y - this.flockY
    const r = Math.sqrt(Math.random()) * view.H * 0.12
    const a = Math.random() * Math.PI * 2
    F.offX[i] = Math.cos(a) * r * 1.3
    F.offY[i] = Math.sin(a) * r * 0.8
    F.curve[i] = view.H * (0.012 + Math.random() * 0.018) * (reduced ? 0.5 : 1)
    F.wobF[i] = 1.4 + Math.random() * 1.4
    F.dvz[i] = (-40 + Math.random() * 120) * rm
    // only some butterflies shed a mote or two
    F.trail[i] = Math.random() < 0.35 ? 0.25 + Math.random() * 0.3 : 99
    F.heading[i] = Math.atan2(oy, ox) - Math.PI / 2
  }

  /**
   * Turn butterflies still in flight into returning ones and add newcomers from
   * off-screen until `total` are heading home. `pickTarget(k)` fills tu, tv and
   * arrival time for butterfly k.
   */
  beginReturn(total: number, view: View, reduced: boolean, pickTarget: (out: { u: number; v: number; arrive: number }) => void) {
    const F = this.F
    const tgt = { u: 0.5, v: 0.5, arrive: 1 }
    const side = this.flockSide
    // a loop that swings down and in, curving the same way for everyone
    const bendSign = side > 0 ? 1 : -1
    const setup = (i: number, t0: number) => {
      pickTarget(tgt)
      F.mode[i] = MODE_RETURN
      F.tu[i] = tgt.u
      F.tv[i] = tgt.v
      F.t0[i] = t0
      F.arrive[i] = Math.max(t0 + 0.3, tgt.arrive)
      F.sx[i] = F.x[i]
      F.sy[i] = F.y[i]
      F.sz[i] = F.z[i]
      // curved approach: control point offset sideways and upward
      const ux = F.sx[i] * 0.5
      const uy = F.sy[i] * 0.5
      const len = Math.hypot(F.sx[i], F.sy[i]) + 1
      // one shared bend for the whole flock, varied a little per butterfly
      const bend = bendSign * (0.25 + Math.random() * 0.2) * len
      F.cx[i] = ux + (-F.sy[i] / len) * bend
      F.cy[i] = uy + (F.sx[i] / len) * bend + len * 0.15
      F.cz[i] = F.sz[i] * 0.5 + (Math.random() - 0.5) * 120
    }
    let assigned = 0
    for (let i = 0; i < this.n && assigned < total; i++) {
      if (F.mode[i] !== MODE_VANISH) continue
      F.grow[i] = 1
      setup(i, 0)
      assigned++
    }
    while (assigned < total) {
      const i = this.alloc()
      if (i < 0) break
      this.initLook(i, view, reduced)
      const z = -220 + Math.random() * 380
      // a small group just outside the upper corner the flock flew off toward
      const r = Math.sqrt(Math.random()) * view.H * 0.14
      const a = Math.random() * Math.PI * 2
      const cx = side > 0 ? view.W + 70 : -70
      const cy = view.H * 0.12
      view.toWorld(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r, z, tmp)
      F.x[i] = tmp.x
      F.y[i] = tmp.y
      F.z[i] = z
      F.scale[i] = F.baseScale[i]
      F.grow[i] = 0
      setup(i, Math.random() * (reduced ? 0.2 : 0.12))
      assigned++
    }
  }

  update(dt: number, ctx: FlightContext) {
    const F = this.F
    const { view } = ctx
    this.now = ctx.t
    const rm = ctx.reduced ? 0.7 : 1
    let i = 0
    while (i < this.n) {
      F.age[i] += dt
      const age = F.age[i]
      const px = F.x[i]
      const py = F.y[i]
      let alive = true

      if (F.mode[i] === MODE_VANISH) {
        let tvx: number
        let tvy: number
        let kz = 0
        if (age < F.followT[i]) {
          // lift off with the silhouette, drifting softly outward
          tvx = F.ox[i] * 50 * rm + ctx.followVx
          tvy = F.oy[i] * 50 * rm + ctx.followVy + 40
        } else {
          // steer toward a loose place around the shared flock path
          const fa = age - F.followT[i]
          const w = ctx.t - this.flockT0
          this.pathAt(w - F.birth[i], fl)
          const g = Math.min(1, fa / 0.6)
          const e = g * g * (3 - 2 * g)
          const sp = Math.hypot(fl.vx, fl.vy) + 1
          const wob = Math.sin(fa * F.wobF[i] * Math.PI * 2 * 0.5 + F.seed[i]) * F.curve[i]
          const gx = fl.x + F.bx[i] + (F.offX[i] - F.bx[i]) * e - (fl.vy / sp) * wob
          const gy = fl.y + F.by[i] + (F.offY[i] - F.by[i]) * e + (fl.vx / sp) * wob
          tvx = fl.vx + (gx - px) * 3
          tvy = fl.vy + (gy - py) * 3
          const cap = this.flockV * 1.6
          const tv = Math.hypot(tvx, tvy)
          if (tv > cap) {
            tvx *= cap / tv
            tvy *= cap / tv
          }
          kz = Math.min(1, fa / 0.3)
        }
        const k = 1 - Math.exp(-(age < F.followT[i] ? 6 : 5) * dt)
        F.vx[i] += (tvx - F.vx[i]) * k
        F.vy[i] += (tvy - F.vy[i]) * k
        F.vz[i] += (F.dvz[i] * kz - F.vz[i]) * (1 - Math.exp(-2 * dt))
        F.x[i] += F.vx[i] * dt
        F.y[i] += F.vy[i] * dt
        F.z[i] += F.vz[i] * dt
        const g = Math.min(1, age / 0.22)
        F.scale[i] = F.baseScale[i] * easeOutBack(g, ctx.reduced ? 0.4 : 0.9)
        F.alpha[i] = 0.85 * Math.min(1, age / 0.12) * (1 - smoothstep(MAX_AGE - 0.6, MAX_AGE, age))

        // trails: a few motes shed while flying away
        F.trail[i] -= dt
        if (F.trail[i] <= 0 && age > 0.2 && age < 1.1) {
          F.trail[i] = (0.35 + Math.random() * 0.3) * (ctx.reduced ? 2 : 1)
          ctx.dust.emit(
            F.x[i] - F.vx[i] * 0.03, F.y[i] - F.vy[i] * 0.03, F.z[i],
            F.vx[i] * 0.05, F.vy[i] * 0.05, 0,
            (1.2 + Math.random() * 1.5) * view.sizeScale, 0.15 + Math.random() * 0.2, DUST_MOTE,
          )
        }

        view.toScreen(F.x[i], F.y[i], F.z[i], tmp)
        const m = 160
        if (age > 0.4 && (tmp.y < -m || tmp.x < -m || tmp.x > view.W + m || tmp.y > view.H + m)) alive = false
        if (age > MAX_AGE || F.z[i] > view.D * 0.8) alive = false
      } else {
        const T = ctx.returnT
        const t0 = F.t0[i]
        if (T < t0) {
          F.alpha[i] = 0
        } else {
          const s = Math.min(1, (T - t0) / (F.arrive[i] - t0))
          const e = s * s * s * (s * (s * 6 - 15) + 10)
          uvToScreen(ctx.cover, F.tu[i] + ctx.targetDu, F.tv[i] + ctx.targetDv, tmp)
          view.toWorld(tmp.x, tmp.y, 0, tmp)
          const a = (1 - e) * (1 - e)
          const b = 2 * (1 - e) * e
          const c = e * e
          F.x[i] = a * F.sx[i] + b * F.cx[i] + c * tmp.x
          F.y[i] = a * F.sy[i] + b * F.cy[i] + c * tmp.y
          F.z[i] = a * F.sz[i] + b * F.cz[i]
          const shrink = smoothstep(0.78, 1, s)
          const grow = F.grow[i] > 0 ? 1 : Math.min(1, (T - t0) / 0.3)
          F.scale[i] = F.baseScale[i] * grow * (1 - 0.85 * shrink)
          F.alpha[i] = 0.85 * Math.min(1, (T - t0) * 8) * (1 - smoothstep(0.88, 1, s))
          if (dt > 0) {
            F.vx[i] = (F.x[i] - px) / dt
            F.vy[i] = (F.y[i] - py) / dt
          }
          if (s >= 1) {
            if (Math.random() < 0.3) {
              ctx.dust.emit(
                F.x[i], F.y[i], 0,
                (Math.random() - 0.5) * 40, (Math.random() - 0.3) * 40, 0,
                (2 + Math.random() * 2) * view.sizeScale, 0.25 + Math.random() * 0.2, DUST_GLINT,
              )
            }
            alive = false
          }
        }
      }

      if (!alive) {
        this.kill(i)
        continue
      }

      // heading follows travel direction (head up when hovering)
      const sp = Math.hypot(F.vx[i], F.vy[i])
      const want = sp > 12 ? Math.atan2(F.vy[i], F.vx[i]) - Math.PI / 2 : 0
      let dh = want - F.heading[i]
      dh = Math.atan2(Math.sin(dh), Math.cos(dh))
      F.heading[i] += dh * (1 - Math.exp(-5 * dt))
      // wing beat with occasional glides
      const glide = Math.sin(ctx.t * 1.7 + F.seed[i] * 3) > 0.85 && age > 0.5
      const ampT = (glide ? 0.3 : 1) * F.ampB[i]
      F.amp[i] += (ampT - F.amp[i]) * (1 - Math.exp(-4 * dt))
      F.phase[i] += dt * F.freq[i] * Math.PI * 2 * (age < 0.3 ? 1.3 : glide ? 0.6 : 1)
      i++
    }
    this.write()
  }

  private write() {
    const F = this.F
    const n = this.n
    const order = this.order.subarray(0, n)
    for (let k = 0; k < n; k++) order[k] = k
    const z = F.z
    order.sort((a, b) => z[a] - z[b])
    const P = this.iPos.array as Float32Array
    const A = this.iA.array as Float32Array
    const B = this.iB.array as Float32Array
    let w = 0
    for (let k = 0; k < n; k++) {
      const i = order[k]
      if (F.alpha[i] <= 0.002 || F.scale[i] <= 0.01) continue
      const bob = Math.sin(F.phase[i]) * F.scale[i] * 0.06
      P[w * 3] = F.x[i]
      P[w * 3 + 1] = F.y[i] - bob
      P[w * 3 + 2] = F.z[i]
      A[w * 4] = F.heading[i]
      A[w * 4 + 1] = F.scale[i]
      A[w * 4 + 2] = F.phase[i]
      A[w * 4 + 3] = F.alpha[i]
      B[w * 4] = F.variant[i]
      B[w * 4 + 1] = F.tint[i]
      B[w * 4 + 2] = F.pitch[i]
      B[w * 4 + 3] = F.amp[i]
      w++
    }
    this.geometry.instanceCount = w
    this.iPos.needsUpdate = true
    this.iA.needsUpdate = true
    this.iB.needsUpdate = true
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function easeOutBack(x: number, s: number): number {
  const c3 = s + 1
  return 1 + c3 * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2)
}

