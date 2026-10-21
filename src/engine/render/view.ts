// FX world space: pixels at z = 0, origin at the viewport centre, y up.
// A perspective camera at z = D makes the z = 0 plane map 1:1 to screen pixels,
// so butterflies can move in depth while spawning exactly on screen positions.

export const FOV_DEG = 35

export class View {
  W = 1
  H = 1
  D = 1
  /** Butterfly / dust size multiplier for the current viewport. */
  sizeScale = 1

  set(W: number, H: number) {
    this.W = W
    this.H = H
    this.D = H / 2 / Math.tan((FOV_DEG * Math.PI) / 360)
    this.sizeScale = Math.min(1.6, Math.max(0.6, H / 900))
  }

  toWorld(sx: number, sy: number, z: number, out: { x: number; y: number }) {
    const k = (this.D - z) / this.D
    out.x = (sx - this.W / 2) * k
    out.y = (this.H / 2 - sy) * k
    return out
  }

  toScreen(x: number, y: number, z: number, out: { x: number; y: number }) {
    const k = this.D / Math.max(1, this.D - z)
    out.x = this.W / 2 + x * k
    out.y = this.H / 2 - y * k
    return out
  }
}
