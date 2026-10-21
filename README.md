# Butterfly Vanish

*A small gesture. A thousand wings.*

**Live:** https://jbieyashvi.github.io/butterfly-vanish/ (camera needs your permission; try the demo if you have no webcam)

A webcam experiment. Pinch your thumb and index finger, then release. Your silhouette dissolves into a small flock of white butterflies (about 25–40) that flies away together, and the empty room you captured earlier shows through. Hold an open palm for about a second and you come back.

Everything runs locally in the browser: React, TypeScript, Vite, Three.js and MediaPipe Tasks Vision (selfie segmentation and the hand landmarker). The models and WASM are served from `public/`. There is no backend. Camera frames are never uploaded or saved, and the captured background lives only in memory.

## Run

```bash
npm install
npm run dev          # http://localhost:5173 (camera needs localhost or https)
npm run build && npm run preview
npx vitest run       # gesture, state-machine, mask and coordinate tests
```

Use desktop Chrome or Edge for the best results (GPU delegate).

## Controls

| Action | Gesture | Fallback |
|---|---|---|
| Vanish (in Ready) | Pinch, hold a beat, then release quickly | Space / V, or the Vanish button |
| Return (in Vanished) | Open palm toward the camera for about 1 s | Enter / B, or the Return button |
| Hide UI | | H |
| Fullscreen | | F |

States: setup → ready → dissolving → vanished → returning → ready. While an effect is running, other triggers are ignored. If hand tracking is lost mid-pinch, nothing triggers.

**Demo mode** ("Try demo (no camera)") uses a synthetic room and a drawn figure. The figure's mask stands in for segmentation, and scripted synthetic hand landmarks are fed through the real gesture detectors. "Model self-test" runs the real MediaPipe models on one demo frame. Demo mode is clearly labeled in the UI.

## Manual webcam test guide

1. Set the laptop or camera on a stable surface with even lighting. Click **Start with camera** and allow access. The preview is mirrored.
2. Click **Capture background**. Step fully out of frame during the 5 s countdown. On the review screen, check that the room is empty; if not, click **Retake**. You will see a warning if a person was detected in the background.
3. Click **Use this background** and step back in. The app goes to *Ready* once it detects you (or click **I'm in frame**).
4. **Pinch → release**: touch thumb to index finger, hold for about 0.2 s, then open quickly. Expect:
   - a sparkle at your fingertip;
   - the dissolve front spreading from that point across your silhouette, with white butterflies lifting off the edge;
   - the butterflies gathering into one loose flock that sweeps diagonally up and away from your hand;
   - after about 1 s you are gone, the centre is clear by about 1.5 s, and the last butterflies leave by about 2.5 s.
5. **Negative checks.** None of these should trigger:
   - a slow release;
   - a pinch where your hand then leaves the frame;
   - an open palm while in Ready;
   - a pinch with your hand far from or close to the camera, held but never released.
6. **Return**: while vanished, hold an open palm toward the camera. A ring fills over about 1 s. Expect a small flock to fly in from the side they left toward and settle onto where you are *now* (move a little first to check this) while your live image reappears, then the state returns to *Ready*.
7. Repeat 3 to 5 cycles. Also try **Reduced motion** (calmer, fewer butterflies), **Hide UI (H)**, **Fullscreen**, **Retake background** and **Reset**.
8. Switch tabs and come back: processing pauses while the tab is hidden. Closing the tab stops the camera.

Tips: plain backgrounds and steady light give the cleanest mask. If the camera or the lighting changes, retake the background.
