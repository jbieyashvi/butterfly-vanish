// Adaptive quality: watches smoothed frame time and steps render resolution
// and particle budgets up or down. Changes are only applied between
// transformations so a running effect never visibly shifts mid-flight.

export type Tier = 'low' | 'mid' | 'high'

export interface TierSettings {
  pixelRatio: number
  butterflies: number
  dust: number
}

const TIERS: Record<Tier, TierSettings> = {
  low: { pixelRatio: 0.75, butterflies: 60, dust: 400 },
  mid: { pixelRatio: 1, butterflies: 100, dust: 600 },
  high: { pixelRatio: 1.5, butterflies: 140, dust: 800 },
}
const ORDER: Tier[] = ['low', 'mid', 'high']

export class QualityGovernor {
  tier: Tier
  ema = 16.7
  private over = 0
  private under = 0
  private pending: Tier | null = null

  constructor(initial?: Tier) {
    const cores = navigator.hardwareConcurrency || 4
    this.tier = initial ?? (cores >= 8 ? 'high' : 'mid')
  }

  get settings(): TierSettings {
    const s = TIERS[this.tier]
    return { ...s, pixelRatio: Math.min(s.pixelRatio, window.devicePixelRatio || 1) }
  }

  /** Feed a frame time in ms. Returns true when a pending tier change was applied. */
  sample(ms: number, canApply: boolean): boolean {
    if (ms > 250) return false // tab switch / hitch, ignore
    this.ema = this.ema * 0.95 + ms * 0.05
    const idx = ORDER.indexOf(this.tier)
    if (this.ema > 24) {
      this.over++
      this.under = 0
    } else if (this.ema < 13) {
      this.under++
      this.over = 0
    } else {
      this.over = 0
      this.under = 0
    }
    if (this.over > 90 && idx > 0) {
      this.pending = ORDER[idx - 1]
      this.over = 0
    } else if (this.under > 600 && idx < ORDER.length - 1) {
      this.pending = ORDER[idx + 1]
      this.under = 0
    }
    if (this.pending && canApply) {
      this.tier = this.pending
      this.pending = null
      this.ema = 16.7
      return true
    }
    return false
  }
}
