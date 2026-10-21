// A tileable value-noise field shared by the GPU (as a texture) and the CPU.
// The dissolve front in the shader and the butterfly emission on the CPU both
// read this exact data, so butterflies are born precisely where the body dissolves.

export const NOISE_SIZE = 128

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createNoise(seed = 11): Uint8Array {
  const N = NOISE_SIZE
  const rand = mulberry32(seed)
  const acc = new Float32Array(N * N)
  const octaves: Array<[number, number]> = [
    [8, 0.55],
    [16, 0.3],
    [32, 0.15],
  ]
  for (const [cells, weight] of octaves) {
    const lattice = new Float32Array(cells * cells)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
    const step = N / cells
    for (let y = 0; y < N; y++) {
      const gy = y / step
      const y0 = Math.floor(gy)
      const fy = smooth(gy - y0)
      const ya = y0 % cells
      const yb = (y0 + 1) % cells
      for (let x = 0; x < N; x++) {
        const gx = x / step
        const x0 = Math.floor(gx)
        const fx = smooth(gx - x0)
        const xa = x0 % cells
        const xb = (x0 + 1) % cells
        const top = lattice[ya * cells + xa] * (1 - fx) + lattice[ya * cells + xb] * fx
        const bot = lattice[yb * cells + xa] * (1 - fx) + lattice[yb * cells + xb] * fx
        acc[y * N + x] += (top * (1 - fy) + bot * fy) * weight
      }
    }
  }
  let lo = Infinity
  let hi = -Infinity
  for (const v of acc) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const out = new Uint8Array(N * N)
  for (let i = 0; i < acc.length; i++) out[i] = Math.round(((acc[i] - lo) / (hi - lo)) * 255)
  return out
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Bilinear sample with repeat wrapping, matching GL LINEAR filtering on a
 * RepeatWrapping texture (texel centres at (i + 0.5) / N). Returns 0..1.
 */
export function sampleNoise(data: Uint8Array, x: number, y: number): number {
  const N = NOISE_SIZE
  const tx = x * N - 0.5
  const ty = y * N - 0.5
  const x0 = Math.floor(tx)
  const y0 = Math.floor(ty)
  const fx = tx - x0
  const fy = ty - y0
  const xa = ((x0 % N) + N) % N
  const xb = (xa + 1) % N
  const ya = ((y0 % N) + N) % N
  const yb = (ya + 1) % N
  const top = data[ya * N + xa] * (1 - fx) + data[ya * N + xb] * fx
  const bot = data[yb * N + xa] * (1 - fx) + data[yb * N + xb] * fx
  return (top * (1 - fy) + bot * fy) / 255
}
