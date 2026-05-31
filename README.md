# Murmuration — Windows build

An audio-reactive 3D starling-murmuration visualiser. A GPU boid flock reacts to
whatever is playing on your **system audio** — bass drives the motion, the
higher bands shape colour, turning and shimmer.

This is the standalone Windows version: a single Electron app that captures
system audio directly (no Python, no separate feeder, no setup). It is a
self-contained repackaging of the visualiser — all rendering and audio analysis
run in-process and offline.

## Run it (just the app)

Grab `Murmuration.exe` from the latest [Release](../../releases) and double-click
it. Play any audio on your PC and the flock reacts. No install.

- **F11** — fullscreen, **Esc** — leave fullscreen.
- **H** — show/hide all on-screen controls (tuning panel, FPS, audio readout).
- The audio readout's status dot: **green** = audio is flowing, **amber** =
  running but silent (nothing playing / wrong output device), **red** = capture
  not started.

## How it works

- **System audio** is captured via Electron's loopback (`getDisplayMedia` with
  `audio: 'loopback'`); a video track is requested only because the API requires
  it and is discarded immediately.
- **Audio analysis** (`audio-engine.js`) is a 1:1 port of the original Python
  feeder's DSP — Hann-windowed FFT, seven frequency bands with per-band AGC, and
  a rectified-spectral-flux onset detector — verified numerically against the
  reference to float precision.
- **Auto-scaling**: the flock size is chosen from a tier ladder. On first launch
  the app measures frame rate for a couple of seconds and, on weaker GPUs, drops
  a tier and reloads until it holds ~60fps (remembered after that). A safety net
  steps down once more if a heavy track overloads the GPU mid-session.
  Override manually with `?birds=N` (advanced).

## Build from source

Requires Node.js. The portable `.exe` is produced by `electron-builder` and
must be built on (or for) Windows.

```
npm install
npm start          # run the app locally (dev)
npm run dist:win   # build dist/Murmuration.exe   (Windows host, or CI)
```

GitHub Actions (`.github/workflows/build-windows.yml`) builds the `.exe` on a
Windows runner and attaches it to a Release on every version tag (`v*`).

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main process — window + system-audio loopback handler |
| `renderer/index.html` | The visualiser (Three.js GPGPU boids, GUI, audio wiring) |
| `audio-engine.js` | FFT + per-band AGC + onset detection (port of the Python feeder) |
| `capture-worklet.js` | AudioWorklet — buffers loopback audio into 1024-sample blocks |
| `vendor/three/` | Bundled Three.js r0.160.0 (offline; no CDN) |

This is AI-assisted code.
