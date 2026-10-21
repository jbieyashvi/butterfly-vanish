// Procedural wing atlas: 4 variants side by side, each a right wing with the
// hinge on the cell's left edge and the head toward the top.

export const WING_VARIANTS = 4

interface WingShape {
  fore: [number, number, number, number, number, number][]
  hind: [number, number, number, number, number, number][]
  tail: boolean
  spots: boolean
}

// Bezier control points in cell units (0..1, y down); each path starts at the hinge.
const SHAPES: WingShape[] = [
  {
    // classic rounded
    fore: [
      [0.2, 0.18, 0.62, 0.06, 0.92, 0.14],
      [1.02, 0.2, 0.92, 0.42, 0.62, 0.5],
    ],
    hind: [
      [0.4, 0.5, 0.86, 0.62, 0.8, 0.82],
      [0.72, 0.98, 0.28, 0.9, 0.04, 0.6],
    ],
    tail: false,
    spots: true,
  },
  {
    // swallowtail
    fore: [
      [0.24, 0.16, 0.7, 0.02, 0.98, 0.1],
      [0.98, 0.26, 0.86, 0.44, 0.56, 0.5],
    ],
    hind: [
      [0.36, 0.52, 0.74, 0.6, 0.66, 0.8],
      [0.6, 0.9, 0.42, 0.97, 0.06, 0.62],
    ],
    tail: true,
    spots: false,
  },
  {
    // slender, glassy
    fore: [
      [0.18, 0.24, 0.66, 0.12, 0.96, 0.22],
      [0.98, 0.32, 0.8, 0.46, 0.5, 0.5],
    ],
    hind: [
      [0.4, 0.52, 0.72, 0.58, 0.7, 0.74],
      [0.66, 0.86, 0.3, 0.84, 0.04, 0.58],
    ],
    tail: false,
    spots: false,
  },
  {
    // broad morpho-like
    fore: [
      [0.16, 0.1, 0.6, 0.0, 0.9, 0.08],
      [1.0, 0.16, 0.98, 0.42, 0.66, 0.5],
    ],
    hind: [
      [0.5, 0.5, 0.96, 0.6, 0.86, 0.86],
      [0.74, 1.0, 0.3, 0.96, 0.04, 0.62],
    ],
    tail: false,
    spots: true,
  },
]

export function createWingAtlas(cell = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = cell * WING_VARIANTS
  canvas.height = cell
  const ctx = canvas.getContext('2d')!
  SHAPES.forEach((shape, i) => drawWing(ctx, shape, i * cell, cell))
  return canvas
}

function drawWing(ctx: CanvasRenderingContext2D, shape: WingShape, ox: number, S: number) {
  const P = (x: number, y: number): [number, number] => [ox + x * S, y * S]
  const hinge = (y: number) => P(0.03, y)

  const wingPath = new Path2D()
  // forewing
  wingPath.moveTo(...hinge(0.44))
  for (const c of shape.fore) wingPath.bezierCurveTo(...P(c[0], c[1]), ...P(c[2], c[3]), ...P(c[4], c[5]))
  wingPath.lineTo(...hinge(0.52))
  // hindwing
  wingPath.moveTo(...hinge(0.5))
  const h0 = shape.hind[0]
  wingPath.bezierCurveTo(...P(h0[0], h0[1]), ...P(h0[2], h0[3]), ...P(h0[4], h0[5]))
  if (shape.tail) {
    wingPath.quadraticCurveTo(...P(0.66, 0.9), ...P(0.6, 0.99))
    wingPath.quadraticCurveTo(...P(0.54, 0.92), ...P(0.5, 0.9))
  }
  const h1 = shape.hind[1]
  wingPath.bezierCurveTo(...P(h1[0], h1[1]), ...P(h1[2], h1[3]), ...P(h1[4], h1[5]))
  wingPath.closePath()

  ctx.save()
  const grad = ctx.createRadialGradient(...P(0.05, 0.5), 0, ...P(0.05, 0.5), S * 0.95)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(250,247,255,0.97)')
  grad.addColorStop(0.78, 'rgba(246,242,250,0.94)')
  grad.addColorStop(1, 'rgba(228,220,244,0.9)')
  ctx.fillStyle = grad
  ctx.fill(wingPath)

  // veins and accents, clipped to the wing
  ctx.clip(wingPath)
  ctx.strokeStyle = 'rgba(190,176,226,0.26)'
  ctx.lineWidth = S * 0.007
  const veins: [number, number][] = [
    [0.9, 0.14], [0.86, 0.28], [0.74, 0.42], [0.8, 0.7], [0.62, 0.86], [0.36, 0.88],
  ]
  for (const [x, y] of veins) {
    ctx.beginPath()
    ctx.moveTo(...hinge(0.5))
    ctx.quadraticCurveTo(...P(x * 0.5, (y + 0.5) / 2 - 0.04), ...P(x, y))
    ctx.stroke()
  }
  // lavender edge band
  ctx.lineWidth = S * 0.05
  ctx.strokeStyle = 'rgba(206,194,236,0.28)'
  ctx.stroke(wingPath)
  if (shape.spots) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    for (const [x, y, r] of [
      [0.78, 0.16, 0.022],
      [0.84, 0.24, 0.016],
      [0.68, 0.74, 0.02],
    ]) {
      ctx.beginPath()
      ctx.arc(...P(x, y), r * S, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()

  // crisp pearl outline
  ctx.lineWidth = S * 0.012
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.stroke(wingPath)

  // half body along the hinge
  ctx.fillStyle = 'rgba(232,224,250,1)'
  ctx.beginPath()
  ctx.ellipse(ox, S * 0.52, S * 0.03, S * 0.26, 0, -Math.PI / 2, Math.PI / 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(ox, S * 0.25, S * 0.028, S * 0.03, 0, -Math.PI / 2, Math.PI / 2)
  ctx.fill()
}
