// Final compositing. Per frame:
//   1. butterflies + dust -> fx target (premultiplied, transparent)
//   2. bright-pass + separable blur of the fx layer at 1/2 and 1/4 res
//      (bloom touches only the butterflies, never the room)
//   3. composite to screen: captured background / live camera mixed by the
//      person mask and the dissolve front, then the fx layer and its bloom.

import {
  CanvasTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
  VideoTexture,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three'
import { type CoverMap, coverUniform } from '../coords'
import type { MaskField } from '../mask'
import { NOISE_SIZE, createNoise } from '../noise'
import { FOV_DEG, View } from './view'

export const NOISE_SCALE = 2.2

const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const compositeFragment = /* glsl */ `
uniform sampler2D uLive;
uniform sampler2D uBg;
uniform sampler2D uMask;
uniform sampler2D uNoise;
uniform sampler2D uFx;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform vec4 uCover;
uniform vec2 uMaskTexel;
uniform vec2 uOrigin;
uniform float uMirror;
uniform float uAspect;
uniform float uHasBg;
uniform float uHasMask;
uniform float uViewBg;
uniform float uEnvVis;
uniform float uPersonVis;
uniform float uFrontMode;
uniform float uRadius;
uniform float uEdgeW;
uniform float uNoiseAmp;
uniform float uNoiseScale;
uniform float uGlow;
uniform float uBloomStrength;
uniform float uFxOn;
uniform float uTime;
varying vec2 vUv;

float maskAt(vec2 uv) {
  vec2 o = uMaskTexel * 1.25;
  float m = texture2D(uMask, uv).r * 0.25;
  m += (texture2D(uMask, uv + vec2(o.x, 0.0)).r + texture2D(uMask, uv - vec2(o.x, 0.0)).r
      + texture2D(uMask, uv + vec2(0.0, o.y)).r + texture2D(uMask, uv - vec2(0.0, o.y)).r) * 0.125;
  m += (texture2D(uMask, uv + o).r + texture2D(uMask, uv - o).r
      + texture2D(uMask, uv + vec2(o.x, -o.y)).r + texture2D(uMask, uv + vec2(-o.x, o.y)).r) * 0.0625;
  return smoothstep(0.3, 0.72, m);
}

void main() {
  vec2 sn = vec2(vUv.x, 1.0 - vUv.y);
  vec2 vu = (sn - uCover.xy) / uCover.zw;
  if (uMirror > 0.5) vu.x = 1.0 - vu.x;
  vu = clamp(vu, 0.0, 1.0);
  vec3 col = texture2D(uLive, vu).rgb;

  if (uHasBg > 0.5) {
    vec3 bg = texture2D(uBg, vu).rgb;
    if (uViewBg > 0.5) {
      col = bg;
    } else {
      float m = uHasMask > 0.5 ? maskAt(vu) : 0.0;
      vec2 ap = vec2(uAspect, 1.0);
      float n = texture2D(uNoise, vu * ap * uNoiseScale).r;
      float key = length((vu - uOrigin) * ap) + uNoiseAmp * (n * 2.0 - 1.0);
      float s = smoothstep(uRadius - uEdgeW, uRadius, key);
      float pv = uPersonVis;
      if (uFrontMode > 0.5 && uFrontMode < 1.5) pv = s;        // vanish: inside the front is gone
      else if (uFrontMode > 1.5) pv = 1.0 - s;                // return: inside the front is back
      float A = uEnvVis * (1.0 - m) + m * pv;
      col = mix(bg, col, A);
      if (uFrontMode > 0.5) {
        float band = exp(-pow((key - uRadius) / (uEdgeW * 0.8), 2.0)) * m;
        vec3 glowCol = mix(vec3(1.0, 0.975, 0.93), vec3(0.9, 0.86, 1.0), smoothstep(0.55, 0.85, n));
        col = mix(col, glowCol, band * 0.22 * uGlow);
        float g = texture2D(uNoise, vu * ap * 23.0 + vec2(uTime * 0.07, -uTime * 0.05)).r;
        col += glowCol * band * smoothstep(0.78, 0.95, g) * 0.45 * uGlow;
      }
    }
  }

  if (uFxOn > 0.5) {
    vec4 fx = texture2D(uFx, vUv);
    col = col * (1.0 - fx.a) + fx.rgb;
    col += (texture2D(uBloomA, vUv).rgb * 0.45 + texture2D(uBloomB, vUv).rgb * 0.55) * uBloomStrength;
  }
  // a whisper of vignette for a cinematic frame
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.22;
  gl_FragColor = vec4(col, 1.0);
}
`

const brightFragment = /* glsl */ `
uniform sampler2D uSrc;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uSrc, vUv);
  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(c.rgb * smoothstep(0.62, 1.0, l) * 0.8, 1.0);
}
`

const blurFragment = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uSrc, vUv).rgb * 0.2270270;
  c += (texture2D(uSrc, vUv + uDir * 1.3846153).rgb + texture2D(uSrc, vUv - uDir * 1.3846153).rgb) * 0.3162162;
  c += (texture2D(uSrc, vUv + uDir * 3.2307692).rgb + texture2D(uSrc, vUv - uDir * 3.2307692).rgb) * 0.0702702;
  gl_FragColor = vec4(c, 1.0);
}
`

const copyFragment = /* glsl */ `
uniform sampler2D uSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uSrc, vUv); }
`

export interface CompositeParams {
  viewBg: boolean
  envVis: number
  personVis: number
  /** 0 = none, 1 = vanish front, 2 = return front */
  frontMode: number
  originU: number
  originV: number
  radius: number
  edgeW: number
  noiseAmp: number
  glow: number
}

export class Stage {
  readonly renderer: WebGLRenderer
  readonly view = new View()
  readonly fxScene = new Scene()
  readonly fxCamera: PerspectiveCamera
  readonly noiseData: Uint8Array
  private quadScene = new Scene()
  private quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private quad: Mesh
  private composite: ShaderMaterial
  private bright: ShaderMaterial
  private blur: ShaderMaterial
  private copy: ShaderMaterial
  private rtFx: WebGLRenderTarget
  private halfA: WebGLRenderTarget
  private halfB: WebGLRenderTarget
  private quarterA: WebGLRenderTarget
  private quarterB: WebGLRenderTarget
  private liveTex: Texture | null = null
  private liveIsCanvas = false
  private bgTex: CanvasTexture | null = null
  private maskTex: DataTexture | null = null
  private maskVersion = -1
  private noiseTex: DataTexture
  private fxWasOn = false
  pixelRatio = 1

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
    this.renderer.autoClear = false
    this.fxCamera = new PerspectiveCamera(FOV_DEG, 1, 1, 20000)

    this.noiseData = createNoise()
    this.noiseTex = new DataTexture(this.noiseData, NOISE_SIZE, NOISE_SIZE, RedFormat, UnsignedByteType)
    this.noiseTex.wrapS = this.noiseTex.wrapT = RepeatWrapping
    this.noiseTex.magFilter = this.noiseTex.minFilter = LinearFilter
    this.noiseTex.unpackAlignment = 1
    this.noiseTex.needsUpdate = true

    const rt = () => new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
    this.rtFx = rt()
    this.halfA = rt()
    this.halfB = rt()
    this.quarterA = rt()
    this.quarterB = rt()

    this.composite = new ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: compositeFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLive: { value: null },
        uBg: { value: null },
        uMask: { value: null },
        uNoise: { value: this.noiseTex },
        uFx: { value: this.rtFx.texture },
        uBloomA: { value: this.halfA.texture },
        uBloomB: { value: this.quarterA.texture },
        uCover: { value: new Vector4(0, 0, 1, 1) },
        uMaskTexel: { value: new Vector2(1 / 256, 1 / 144) },
        uOrigin: { value: new Vector2(0.5, 0.5) },
        uMirror: { value: 1 },
        uAspect: { value: 16 / 9 },
        uHasBg: { value: 0 },
        uHasMask: { value: 0 },
        uViewBg: { value: 0 },
        uEnvVis: { value: 1 },
        uPersonVis: { value: 1 },
        uFrontMode: { value: 0 },
        uRadius: { value: 0 },
        uEdgeW: { value: 0.05 },
        uNoiseAmp: { value: 0.1 },
        uNoiseScale: { value: NOISE_SCALE },
        uGlow: { value: 1 },
        uBloomStrength: { value: 0.55 },
        uFxOn: { value: 0 },
        uTime: { value: 0 },
      },
    })
    const pass = (fragmentShader: string, extra: Record<string, { value: unknown }> = {}) =>
      new ShaderMaterial({
        vertexShader: quadVertex,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        uniforms: { uSrc: { value: null }, ...extra },
      })
    this.bright = pass(brightFragment)
    this.blur = pass(blurFragment, { uDir: { value: new Vector2() } })
    this.copy = pass(copyFragment)
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.composite)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  setLiveSource(src: HTMLVideoElement | HTMLCanvasElement) {
    this.liveTex?.dispose()
    const tex = src instanceof HTMLVideoElement ? new VideoTexture(src) : new CanvasTexture(src)
    tex.flipY = false
    tex.generateMipmaps = false
    tex.minFilter = tex.magFilter = LinearFilter
    this.liveTex = tex
    this.liveIsCanvas = !(src instanceof HTMLVideoElement)
    this.composite.uniforms.uLive.value = tex
  }

  setBackground(canvas: HTMLCanvasElement | null) {
    this.bgTex?.dispose()
    this.bgTex = null
    if (canvas) {
      const tex = new CanvasTexture(canvas)
      tex.flipY = false
      tex.generateMipmaps = false
      tex.minFilter = tex.magFilter = LinearFilter
      this.bgTex = tex
    }
    this.composite.uniforms.uBg.value = this.bgTex
    this.composite.uniforms.uHasBg.value = this.bgTex ? 1 : 0
  }

  updateMask(mask: MaskField) {
    if (mask.version === this.maskVersion || mask.w === 0) return
    this.maskVersion = mask.version
    const tex = this.maskTex
    if (!tex || tex.image.width !== mask.w || tex.image.height !== mask.h || tex.image.data !== mask.bytes) {
      tex?.dispose()
      const t = new DataTexture(mask.bytes, mask.w, mask.h, RedFormat, UnsignedByteType)
      t.magFilter = t.minFilter = LinearFilter
      t.unpackAlignment = 1
      t.flipY = false
      this.maskTex = t
      this.composite.uniforms.uMask.value = t
      ;(this.composite.uniforms.uMaskTexel.value as Vector2).set(1 / mask.w, 1 / mask.h)
    }
    this.maskTex!.needsUpdate = true
    this.composite.uniforms.uHasMask.value = 1
  }

  clearMask() {
    this.composite.uniforms.uHasMask.value = 0
  }

  resize(W: number, H: number, pixelRatio: number) {
    this.pixelRatio = pixelRatio
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(W, H, false)
    this.view.set(W, H)
    this.fxCamera.aspect = W / H
    this.fxCamera.position.set(0, 0, this.view.D)
    this.fxCamera.lookAt(0, 0, 0)
    this.fxCamera.near = 1
    this.fxCamera.far = this.view.D * 4
    this.fxCamera.updateProjectionMatrix()
    const pw = Math.max(1, Math.round(W * pixelRatio))
    const ph = Math.max(1, Math.round(H * pixelRatio))
    this.rtFx.setSize(pw, ph)
    this.halfA.setSize(Math.ceil(pw / 2), Math.ceil(ph / 2))
    this.halfB.setSize(Math.ceil(pw / 2), Math.ceil(ph / 2))
    this.quarterA.setSize(Math.ceil(pw / 4), Math.ceil(ph / 4))
    this.quarterB.setSize(Math.ceil(pw / 4), Math.ceil(ph / 4))
  }

  setCover(cover: CoverMap, aspect: number) {
    const [a, b, c, d] = coverUniform(cover)
    ;(this.composite.uniforms.uCover.value as Vector4).set(a, b, c, d)
    this.composite.uniforms.uMirror.value = cover.mirror ? 1 : 0
    this.composite.uniforms.uAspect.value = aspect
  }

  render(p: CompositeParams, time: number, fxActive: boolean, bloomStrength: number) {
    const r = this.renderer
    const u = this.composite.uniforms
    if (this.liveIsCanvas && this.liveTex) this.liveTex.needsUpdate = true
    u.uViewBg.value = p.viewBg ? 1 : 0
    u.uEnvVis.value = p.envVis
    u.uPersonVis.value = p.personVis
    u.uFrontMode.value = p.frontMode
    ;(u.uOrigin.value as Vector2).set(p.originU, p.originV)
    u.uRadius.value = p.radius
    u.uEdgeW.value = p.edgeW
    u.uNoiseAmp.value = p.noiseAmp
    u.uGlow.value = p.glow
    u.uTime.value = time
    u.uBloomStrength.value = bloomStrength

    if (fxActive || this.fxWasOn) {
      r.setRenderTarget(this.rtFx)
      r.setClearColor(0x000000, 0)
      r.clear(true, false, false)
      if (fxActive) {
        r.render(this.fxScene, this.fxCamera)
        this.runPass(this.bright, this.rtFx, this.halfA)
        this.blurPass(this.halfA, this.halfB, 1, 0)
        this.blurPass(this.halfB, this.halfA, 0, 1)
        this.runPass(this.copy, this.halfA, this.quarterA)
        this.blurPass(this.quarterA, this.quarterB, 1, 0)
        this.blurPass(this.quarterB, this.quarterA, 0, 1)
      }
      this.fxWasOn = fxActive
    }
    u.uFxOn.value = fxActive ? 1 : 0
    this.quad.material = this.composite
    r.setRenderTarget(null)
    r.render(this.quadScene, this.quadCam)
  }

  private runPass(mat: ShaderMaterial, src: WebGLRenderTarget, dst: WebGLRenderTarget) {
    mat.uniforms.uSrc.value = src.texture
    this.quad.material = mat
    this.renderer.setRenderTarget(dst)
    this.renderer.render(this.quadScene, this.quadCam)
  }

  private blurPass(src: WebGLRenderTarget, dst: WebGLRenderTarget, dx: number, dy: number) {
    ;(this.blur.uniforms.uDir.value as Vector2).set(dx / src.width, dy / src.height)
    this.runPass(this.blur, src, dst)
  }

  dispose() {
    this.liveTex?.dispose()
    this.bgTex?.dispose()
    this.maskTex?.dispose()
    this.noiseTex.dispose()
    for (const t of [this.rtFx, this.halfA, this.halfB, this.quarterA, this.quarterB]) t.dispose()
    for (const m of [this.composite, this.bright, this.blur, this.copy]) m.dispose()
    this.quad.geometry.dispose()
    this.renderer.dispose()
  }
}
