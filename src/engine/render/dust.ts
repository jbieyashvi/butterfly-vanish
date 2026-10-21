// Sparkling dust, short fading trails and the fingertip flare. Additive points,
// packed pool with swap-remove, no per-frame allocation.

import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DynamicDrawUsage,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  ShaderMaterial,
} from 'three'

export const DUST_MOTE = 0
export const DUST_GLINT = 1
export const DUST_FLARE = 2

const vertex = /* glsl */ `
attribute vec4 aData; // size, alpha, type, seed
uniform float uPx;
uniform float uCamZ;
varying float vAlpha;
varying float vType;
varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aData.x * uPx * (uCamZ / max(1.0, -mv.z));
  vAlpha = aData.y;
  vType = aData.z;
  vSeed = aData.w;
}
`

const fragment = /* glsl */ `
varying float vAlpha;
varying float vType;
varying float vSeed;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  float core = exp(-d * d * 70.0);
  float halo = exp(-d * d * 14.0) * 0.3;
  float a = core + halo;
  if (vType > 0.5) {
    float w = vType > 1.5 ? 60.0 : 34.0;
    float rays = exp(-abs(p.x) * w) * exp(-abs(p.y) * 4.5) + exp(-abs(p.y) * w) * exp(-abs(p.x) * 4.5);
    a = core * 0.9 + halo * 0.5 + rays * 0.85;
  }
  a *= vAlpha * smoothstep(0.5, 0.3, d);
  vec3 col = mix(vec3(1.0), vec3(0.86, 0.89, 0.95), fract(vSeed * 7.13) * 0.7);
  // purely additive: alpha 0 so the base image is not darkened
  gl_FragColor = vec4(col * a, 0.0);
}
`

export class DustSystem {
  readonly points: Points
  readonly cap: number
  /** soft limit set by the quality governor */
  limit: number
  n = 0
  private x: Float32Array
  private y: Float32Array
  private z: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private vz: Float32Array
  private age: Float32Array
  private life: Float32Array
  private size: Float32Array
  private type: Float32Array
  private seed: Float32Array
  private fields: Float32Array[]
  private pos: Float32Array
  private data: Float32Array
  private posAttr: BufferAttribute
  private dataAttr: BufferAttribute
  readonly material: ShaderMaterial

  constructor(cap: number) {
    this.cap = cap
    this.limit = cap
    const f = () => new Float32Array(cap)
    this.x = f()
    this.y = f()
    this.z = f()
    this.vx = f()
    this.vy = f()
    this.vz = f()
    this.age = f()
    this.life = f()
    this.size = f()
    this.type = f()
    this.seed = f()
    this.fields = [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.age, this.life, this.size, this.type, this.seed]
    this.pos = new Float32Array(cap * 3)
    this.data = new Float32Array(cap * 4)
    const geo = new BufferGeometry()
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage)
    this.dataAttr = new BufferAttribute(this.data, 4).setUsage(DynamicDrawUsage)
    geo.setAttribute('position', this.posAttr)
    geo.setAttribute('aData', this.dataAttr)
    geo.setDrawRange(0, 0)
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uPx: { value: 1 }, uCamZ: { value: 1000 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
    })
    this.points = new Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 2
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, type = DUST_MOTE) {
    if (this.n >= Math.min(this.cap, this.limit)) return
    const i = this.n++
    this.x[i] = x
    this.y[i] = y
    this.z[i] = z
    this.vx[i] = vx
    this.vy[i] = vy
    this.vz[i] = vz
    this.age[i] = 0
    this.life[i] = life
    this.size[i] = size
    this.type[i] = type
    this.seed[i] = Math.random()
  }

  clear() {
    this.n = 0
    this.points.geometry.setDrawRange(0, 0)
  }

  update(dt: number, t: number) {
    let i = 0
    while (i < this.n) {
      this.age[i] += dt
      if (this.age[i] >= this.life[i]) {
        this.kill(i)
        continue
      }
      const damp = Math.exp(-1.4 * dt)
      this.vx[i] *= damp
      this.vy[i] = this.vy[i] * damp + 8 * dt
      this.vz[i] *= damp
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
      this.z[i] += this.vz[i] * dt
      i++
    }
    const pos = this.pos
    const data = this.data
    for (let k = 0; k < this.n; k++) {
      const u = this.age[k] / this.life[k]
      let size = this.size[k]
      let alpha: number
      if (this.type[k] === DUST_FLARE) {
        const e = 1 - (1 - u) * (1 - u)
        size *= 0.35 + 0.65 * e
        alpha = (1 - u) * (1 - u) * Math.min(1, u * 12)
      } else {
        const twinkle = 0.6 + 0.4 * Math.sin(t * (9 + this.seed[k] * 9) + this.seed[k] * 40)
        alpha = Math.min(1, u * 8) * Math.pow(1 - u, 1.5) * twinkle
      }
      pos[k * 3] = this.x[k]
      pos[k * 3 + 1] = this.y[k]
      pos[k * 3 + 2] = this.z[k]
      data[k * 4] = size
      data[k * 4 + 1] = alpha
      data[k * 4 + 2] = this.type[k]
      data[k * 4 + 3] = this.seed[k]
    }
    this.posAttr.needsUpdate = true
    this.dataAttr.needsUpdate = true
    this.points.geometry.setDrawRange(0, this.n)
  }

  private kill(i: number) {
    const last = --this.n
    if (i !== last) for (const a of this.fields) a[i] = a[last]
  }

  dispose() {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
