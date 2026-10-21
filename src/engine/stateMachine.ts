// Explicit transformation states. Transitions are only accepted from the right
// state, so overlapping triggers during a transition are ignored.

export type TransformState = 'setup' | 'ready' | 'dissolving' | 'vanished' | 'returning'

export interface MachineOptions {
  /** after returning to ready, wait this long before a new vanish is accepted */
  readyCooldownMs: number
  /** after vanishing completes, wait this long before a return is accepted */
  minVanishedMs: number
}

export class TransformMachine {
  state: TransformState = 'setup'
  since = 0
  vanishCount = 0
  returnCount = 0
  private opts: MachineOptions
  private listener: ((s: TransformState) => void) | null = null

  constructor(opts: Partial<MachineOptions> = {}) {
    this.opts = { readyCooldownMs: 700, minVanishedMs: 400, ...opts }
  }

  onChange(fn: (s: TransformState) => void) {
    this.listener = fn
  }

  private set(s: TransformState, t: number) {
    this.state = s
    this.since = t
    this.listener?.(s)
  }

  canVanish(t: number): boolean {
    return this.state === 'ready' && t - this.since >= this.opts.readyCooldownMs
  }

  requestVanish(t: number): boolean {
    if (!this.canVanish(t)) return false
    this.vanishCount++
    this.set('dissolving', t)
    return true
  }

  finishDissolve(t: number) {
    if (this.state === 'dissolving') this.set('vanished', t)
  }

  canReturn(t: number): boolean {
    return this.state === 'vanished' && t - this.since >= this.opts.minVanishedMs
  }

  requestReturn(t: number): boolean {
    if (!this.canReturn(t)) return false
    this.returnCount++
    this.set('returning', t)
    return true
  }

  finishReturn(t: number) {
    if (this.state === 'returning') this.set('ready', t)
  }

  enterReady(t: number) {
    if (this.state === 'setup') this.set('ready', t)
  }

  enterSetup(t: number) {
    this.set('setup', t)
  }
}
