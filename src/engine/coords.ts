// Shared coordinate conventions.
//
// "Source UV" (u, v) is the un-mirrored camera frame: u -> right, v -> down, both 0..1.
// Hand landmarks, the segmentation mask, the captured background and the live
// texture all live in this space. The only place mirroring and "cover" cropping
// are applied is the mapping between source UV and screen pixels below, so every
// layer stays aligned with the mirrored preview.

export interface CoverMap {
  W: number
  H: number
  ox: number
  oy: number
  dw: number
  dh: number
  mirror: boolean
  srcAspect: number
}

export interface Vec2 {
  x: number
  y: number
}

/** Fit a srcW x srcH frame into a W x H viewport with CSS `object-fit: cover` semantics. */
export function computeCover(srcW: number, srcH: number, W: number, H: number, mirror = true): CoverMap {
  const s = Math.max(W / srcW, H / srcH)
  const dw = srcW * s
  const dh = srcH * s
  return { W, H, ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh, mirror, srcAspect: srcW / srcH }
}

export function uvToScreen(m: CoverMap, u: number, v: number, out: Vec2): Vec2 {
  out.x = m.ox + (m.mirror ? 1 - u : u) * m.dw
  out.y = m.oy + v * m.dh
  return out
}

export function screenToUv(m: CoverMap, x: number, y: number, out: Vec2): Vec2 {
  const u = (x - m.ox) / m.dw
  out.x = m.mirror ? 1 - u : u
  out.y = (y - m.oy) / m.dh
  return out
}

/** Cover rectangle in normalized screen units (top-down), as used by the composite shader. */
export function coverUniform(m: CoverMap): [number, number, number, number] {
  return [m.ox / m.W, m.oy / m.H, m.dw / m.W, m.dh / m.H]
}
