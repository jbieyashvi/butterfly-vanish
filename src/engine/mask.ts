// Person mask in source-UV space with temporal smoothing and cheap statistics.

export class MaskField {
  w = 0
  h = 0
  /** Smoothed person confidence, 0..1, row-major, row 0 = top of frame. */
  value = new Float32Array(0)
  /** Same data quantized for GPU upload. */
  bytes = new Uint8Array(0)
  version = 0
  lastUpdate = -Infinity

  count = 0
  coverage = 0
  /** Centroid in source UV. */
  cx = 0.5
  cy = 0.5
  minV = 0
  maxV = 0

  private primed = false

  private ensure(w: number, h: number) {
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.value = new Float32Array(w * h)
    this.bytes = new Uint8Array(w * h)
    this.primed = false
  }

  /**
   * Blend a fresh confidence mask in. Large changes are adopted almost
   * immediately (limits ghosting when moving); small flicker is damped.
   */
  ingest(src: ArrayLike<number>, w: number, h: number, now: number, scale = 1) {
    this.ensure(w, h)
    const val = this.value
    const bytes = this.bytes
    const n = w * h
    let count = 0
    let sx = 0
    let sy = 0
    let minRow = h
    let maxRow = -1
    for (let i = 0; i < n; i++) {
      const x = src[i] * scale
      let s: number
      if (this.primed) {
        const prev = val[i]
        const d = x - prev
        const a = Math.min(1, 0.45 + Math.abs(d) * 1.25)
        s = prev + d * a
      } else {
        s = x
      }
      val[i] = s
      bytes[i] = s <= 0 ? 0 : s >= 1 ? 255 : (s * 255 + 0.5) | 0
      if (s > 0.5) {
        const row = (i / w) | 0
        count++
        sx += i - row * w
        sy += row
        if (row < minRow) minRow = row
        if (row > maxRow) maxRow = row
      }
    }
    this.primed = true
    this.count = count
    this.coverage = count / n
    if (count > 0) {
      this.cx = (sx / count + 0.5) / w
      this.cy = (sy / count + 0.5) / h
      this.minV = minRow / h
      this.maxV = (maxRow + 1) / h
    }
    this.version++
    this.lastUpdate = now
  }

  clear() {
    this.value.fill(0)
    this.bytes.fill(0)
    this.count = 0
    this.coverage = 0
    this.primed = false
    this.version++
  }

  /** Writes indices of pixels above threshold into `out`; returns how many. */
  collect(out: Int32Array, threshold = 0.5): number {
    let k = 0
    const val = this.value
    const lim = Math.min(out.length, val.length)
    for (let i = 0; i < val.length && k < lim; i++) if (val[i] > threshold) out[k++] = i
    return k
  }
}
