import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Experience, type Snapshot } from './engine/Experience'
import type { HandScriptName } from './engine/syntheticHand'

const noopSub = () => () => {}

function useSnapshot(engine: Experience | null): Snapshot | null {
  return useSyncExternalStore(engine ? engine.subscribe : noopSub, () => (engine ? engine.getSnapshot() : null))
}

const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const STATE_LABEL: Record<string, string> = {
  setup: 'Setup',
  ready: 'Ready',
  dissolving: 'Dissolving',
  vanished: 'Vanished',
  returning: 'Returning',
}

const SCRIPTS: { name: HandScriptName; label: string; expect: string }[] = [
  { name: 'pinchRelease', label: 'Pinch → quick release', expect: 'should vanish' },
  { name: 'slowRelease', label: 'Pinch → slow release', expect: 'should not trigger' },
  { name: 'pinchLost', label: 'Pinch → tracking lost', expect: 'should not trigger' },
  { name: 'openPalm', label: 'Open palm 1.6 s', expect: 'returns when vanished' },
]

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<Experience | null>(null)
  const [uiHidden, setUiHidden] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const snap = useSnapshot(engine)

  useEffect(() => {
    const exp = new Experience(canvasRef.current!, prefersReduced())
    setEngine(exp)
    exp.onPalm((p) => {
      const el = ringRef.current
      if (!el) return
      el.style.opacity = p.visible ? '1' : '0'
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
      el.style.setProperty('--p', String(p.progress))
    })
    return () => exp.dispose()
  }, [])

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    if (!engine) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'v') {
        e.preventDefault()
        engine.triggerVanish()
      } else if (k === 'enter' || k === 'b') {
        e.preventDefault()
        engine.triggerReturn()
      } else if (k === 'h') {
        setUiHidden((h) => !h)
      } else if (k === 'f') {
        toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.().catch(() => {})
  }

  const s = snap
  const showChrome = !uiHidden
  const live = s?.phase === 'live'
  const inStage = s?.phase === 'setup' || live

  return (
    <div className={`app ${uiHidden ? 'ui-hidden' : ''}`} onMouseUp={(e) => (e.target as HTMLElement).closest('button')?.blur()}>
      <canvas ref={canvasRef} className="stage" />
      <div ref={ringRef} className="palm-ring" style={{ opacity: 0 }} aria-hidden>
        <span />
      </div>

      {showChrome && inStage && <SafeArea />}

      {showChrome && (
        <header className={`brand ${s?.phase === 'intro' ? 'brand-hidden' : ''}`}>
          <h1>Butterfly Vanish</h1>
          <p>A small gesture. A thousand wings.</p>
        </header>
      )}

      {showChrome && s && inStage && (
        <div className="status">
          {s.mode === 'demo' && <span className="badge demo">DEMO · synthetic camera</span>}
          <span className={`badge state state-${s.state}`}>{s.phase === 'setup' ? 'Setup' : STATE_LABEL[s.state]}</span>
        </div>
      )}

      {s?.phase === 'intro' && engine && (
        <div className="center">
          <div className="card intro">
            <h1>Butterfly Vanish</h1>
            <p className="sub">A small gesture. A thousand wings.</p>
            <p>
              Pinch your thumb and index finger, then release — your silhouette dissolves into pearl-white butterflies and the
              empty room shows through. Hold an open palm to come back.
            </p>
            <div className="row">
              <button className="primary" onClick={() => engine.startCamera()}>
                Start with camera
              </button>
              <button onClick={() => engine.startDemo()}>Try demo (no camera)</button>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={s.reducedMotion} onChange={(e) => engine.setReducedMotion(e.target.checked)} />
              Reduced motion
            </label>
            <p className="fine">
              Everything runs on this device. Camera frames are never uploaded or saved; the captured background lives only in
              memory and is gone when you leave.
            </p>
          </div>
        </div>
      )}

      {s?.phase === 'loading' && (
        <div className="center">
          <div className="card loading">
            <div className="spinner" />
            <p>{s.loadingMsg || 'Loading'}…</p>
          </div>
        </div>
      )}

      {s?.phase === 'error' && s.error && engine && (
        <div className="center">
          <div className="card error">
            <h2>{s.error.title}</h2>
            <p>{s.error.body}</p>
            <div className="row">
              {s.error.canRetry && (
                <button className="primary" onClick={() => engine.startCamera()}>
                  Try again
                </button>
              )}
              <button onClick={() => engine.startDemo()}>Try demo</button>
              <button className="ghost" onClick={() => engine.reset()}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {s?.phase === 'setup' && engine && <SetupPanel s={s} engine={engine} />}

      {showChrome && live && s && <Hint s={s} />}

      {s?.notice && showChrome && <div className="notice">{s.notice}</div>}

      {showChrome && live && s && engine && (
        <>
          <nav className="controls">
            <button
              className="primary"
              disabled={s.state !== 'ready'}
              onClick={() => engine.triggerVanish()}
              title="Fallback for the pinch gesture (Space)"
            >
              Vanish <kbd>Space</kbd>
            </button>
            <button disabled={s.state !== 'vanished'} onClick={() => engine.triggerReturn()} title="Fallback for the open palm (Enter)">
              Return <kbd>Enter</kbd>
            </button>
            <span className="sep" />
            <button onClick={() => engine.retake()} disabled={s.state === 'dissolving' || s.state === 'returning'}>
              Retake background
            </button>
            <button className={s.reducedMotion ? 'on' : ''} onClick={() => engine.setReducedMotion(!s.reducedMotion)}>
              Reduced motion
            </button>
            <button onClick={toggleFullscreen}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
            <button onClick={() => setUiHidden(true)}>
              Hide UI <kbd>H</kbd>
            </button>
            <button className="ghost" onClick={() => engine.reset()}>
              Reset
            </button>
          </nav>
          {s.mode === 'demo' && <DemoPanel s={s} engine={engine} />}
        </>
      )}

      {uiHidden && inStage && <div className="unhide">Press H to show controls</div>}
    </div>
  )
}

function SafeArea() {
  return (
    <div className="safe" aria-hidden>
      <i className="c tl" />
      <i className="c tr" />
      <i className="c bl" />
      <i className="c br" />
      <span>9:16</span>
    </div>
  )
}

function Hint({ s }: { s: Snapshot }) {
  let text = ''
  if (s.state === 'ready') {
    if (s.pinchPhase === 'pinching') text = 'Hold the pinch…'
    else if (s.pinchPhase === 'armed' || s.pinchPhase === 'releasing') text = 'Now release quickly'
    else text = 'Pinch, then release — thumb to index, hold a beat, then flick open'
  } else if (s.state === 'vanished') text = 'Hold an open palm toward the camera for about a second to return'
  if (!text) return null
  return <div className="hint">{text}</div>
}

function SetupPanel({ s, engine }: { s: Snapshot; engine: Experience }) {
  const demo = s.mode === 'demo'
  return (
    <div className="setup">
      {s.setupStep === 'position' && (
        <div className="card">
          <h2>Capture the empty room</h2>
          <ul>
            <li>Put the {demo ? 'camera' : 'laptop or camera'} somewhere stable — it must not move after capture.</li>
            <li>Keep the lighting steady; avoid flickering screens and changing daylight.</li>
            <li>After you press Capture you have {5} seconds to step fully out of frame.</li>
          </ul>
          <div className="row">
            <button className="primary" onClick={() => engine.beginCapture()}>
              Capture background
            </button>
            <button className="ghost" onClick={() => engine.reset()}>
              Back
            </button>
          </div>
        </div>
      )}
      {s.setupStep === 'countdown' && (
        <div className="countdown">
          <div className="num" key={s.countdown}>
            {s.countdown}
          </div>
          <p>Step out of frame{demo ? ' (the demo figure walks out)' : ''} — hold still, camera</p>
        </div>
      )}
      {s.setupStep === 'review' && (
        <div className="card">
          <h2>This is your empty room</h2>
          {s.bgWarning ? <p className="warn">{s.bgWarning}</p> : <p>Check that nobody is visible and nothing important moved.</p>}
          <div className="row">
            <button className="primary" onClick={() => engine.acceptBackground()}>
              Use this background
            </button>
            <button onClick={() => engine.retake()}>Retake</button>
          </div>
        </div>
      )}
      {s.setupStep === 'enter' && (
        <div className="card">
          <h2>Now step back in</h2>
          <p>Stand where the camera can see you, roughly centered. The experience starts when you're detected.</p>
          <div className="row">
            <button onClick={() => engine.confirmInFrame()}>I'm in frame</button>
            <button className="ghost" onClick={() => engine.retake()}>
              Retake background
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DemoPanel({ s, engine }: { s: Snapshot; engine: Experience }) {
  return (
    <aside className="demo-panel">
      <h3>Demo · scripted hands</h3>
      <p>Synthetic landmarks fed through the real gesture detectors.</p>
      {SCRIPTS.map((sc) => (
        <button key={sc.name} disabled={!!s.demoScript} onClick={() => engine.runDemoScript(sc.name)} className={s.demoScript === sc.name ? 'on' : ''}>
          {sc.label}
          <small>{sc.expect}</small>
        </button>
      ))}
      <div className="counts">
        vanishes {s.vanishCount} · returns {s.returnCount}
      </div>
      <button onClick={() => engine.runModelSelfTest()} disabled={s.selfTestRunning}>
        {s.selfTestRunning ? 'Running model self-test…' : 'Model self-test'}
      </button>
      {s.selfTest && (
        <ul className={`selftest ${s.selfTest.ok ? 'ok' : 'bad'}`}>
          {s.selfTest.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </aside>
  )
}
