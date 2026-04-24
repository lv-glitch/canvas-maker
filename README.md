# 55 Music Canvas Generator

Generate [Spotify Canvas](https://artists.spotify.com/canvas) videos from photos.
Drop a cover art image (or any photo) and get back a seamlessly-looping 9:16 MP4
at 1080×1920, 3–8 seconds, ready to upload.

Ships as a desktop app for non-technical use, a localhost web UI, and a batch CLI —
all backed by the same FFmpeg pipeline.

---

## Install

### On your Mac (end-user)

Open the latest DMG from `release/`:

```
release/55-Music-Canvas-Generator-<version>-arm64.dmg   # Apple Silicon
release/55-Music-Canvas-Generator-<version>-x64.dmg     # Intel
```

Drag the app to `/Applications`. **First launch:** right-click → Open (the build
is ad-hoc-signed until we get an Apple Developer ID — bypasses Gatekeeper once).

### From source (developer)

```bash
git clone <repo>
cd canvas-maker
npm install
```

No FFmpeg install required — `ffmpeg-static` bundles a binary.

---

## Three ways to use it

### 1. Desktop app

```bash
npm start        # launches Electron in dev mode
```

Or install the built DMG and open from `/Applications` / Dock.

### 2. Web UI (localhost)

```bash
npm run web      # starts on http://localhost:3737 and auto-opens in default browser
# or after `npm link`:
canvas-maker-web
```

Drag-drop a photo, pick an animation, hit Generate. The MP4 previews inline with
autoplay + loop, plus a download button.

### 3. Batch CLI

```bash
canvas-maker ./my-photos -o ./canvases        # batch a directory
canvas-maker cover.jpg -a drift -d 5          # single file, drift animation, 5s
canvas-maker ./albums -l fill -a rotate -p    # fill layout, rotate animation, particles
canvas-maker --help
```

Defaults to CPU-count concurrency, so hundreds of images render in parallel.

---

## Animations

All motion is sin/cos-driven so frame 0 ≈ frame N — seamless loops.

| Name       | Description                          |
| ---------- | ------------------------------------ |
| `zoom`     | Subtle breathing zoom (default)      |
| `drift`    | Slow floating pan                    |
| `pulse`    | Zoom with hue wash                   |
| `kenburns` | Cinematic zoom + diagonal pan        |
| `tilt`     | Gentle side-to-side rocking (±3°)    |
| `vertigo`  | Hypnotic zoom + rotation (±5.7°)     |
| `glow`     | Pulsing brightness + saturation      |
| `rotate`   | Full 360° rotation across duration   |

**`--particles` / particle shimmer toggle:** soft animated sparkle overlay,
kept subtle to respect Spotify's "no rapid cuts or intense flashing" guideline.

## Layouts

How the photo fits into the 9:16 frame:

| Name         | Behavior                                                          |
| ------------ | ----------------------------------------------------------------- |
| `fill`       | Full-frame — photo crops to 9:16 (default)                        |
| `fit`        | Blurred + darkened photo as background, sharp photo centered 92%  |
| `letterbox`  | Black bars + centered photo                                       |

---

## Spotify Canvas compliance

Targets the official
[Spotify Canvas guidelines](https://support.spotify.com/us/artists/article/canvas-guidelines/):

- **Vertical 9:16**, default 1080×1920 (Spotify's recommended resolution)
- **3–8 seconds**, validated at CLI/API boundary
- **MP4 / H.264 High @ level 4.1**, yuv420p, `+faststart`
- **No audio** — Canvas plays over the track
- **Seamless loop** — sin/cos motion guarantees continuous frame deltas at the loop point
- **BT.709 color tags** (`colorspace`, `color_primaries`, `color_trc`, `color_range`)
  — **required**; without these, Spotify's ingestion silently rejects HD uploads
- **Bitrate capped at 6 Mbit/s** via `-maxrate` / `-bufsize` → worst-case file ~4.5 MB
- **Keyframe every 1s** (`-g 30` at 30 fps) for reliable looping in the Spotify player

---

## Architecture

```
canvas-maker/
├── electron/
│   └── main.js           Electron main process — starts the embedded server,
│                         creates window, wires electron-updater
├── src/
│   ├── index.js          generateCanvas() + FFmpeg filter-graph builder
│   ├── server.js         Express server — serves /public, /api/options, /api/generate
│   └── cli.js            Batch CLI (canvas-maker) with p-limit concurrency
├── public/
│   └── index.html        Drag-drop UI (vanilla JS, no framework)
├── build/
│   └── icon.png          App icon (green "55" in a circle)
├── release/              Built .dmg installers (gitignored)
└── package.json          electron-builder config in "build" block
```

**Key choice:** Electron wraps the web UI as-is. The renderer talks to a local
Express server on a random port (not IPC), so the web UI and desktop app are
the same code. Trade-off: tiny overhead (~10 MB RAM), but one code path to maintain.

**FFmpeg path quirk:** `ffmpeg-static` returns a path into `app.asar`, which can't
execute. `src/index.js` rewrites it to `app.asar.unpacked`, which works in both
dev and packaged builds (thanks to the `asarUnpack` in `package.json`).

---

## Build your own installer

```bash
npm run dist:mac      # builds both arm64 and x64 .dmg into release/
npm run dist:win      # builds Windows NSIS installer
npm run pack          # unpackaged .app for testing
```

Output lands in `release/`. Artifacts are named
`55-Music-Canvas-Generator-<version>-<arch>.<ext>`.

---

## Status / what's left

### ✅ Done
- Seamless-looping 9:16 encoder with 8 animations and 3 layouts
- Spotify-compatible encoder (BT.709 tags, bitrate cap, faststart, no audio)
- Batch CLI with parallel rendering
- Web UI (drag-drop, inline preview, download)
- Electron desktop app with native window, menu, and icon
- Ad-hoc-signed DMG installers for arm64 + x64
- `electron-updater` wired into the main process (idle until a feed exists)

### ⏳ Blocked on accounts (Part 2 — ship to staff with auto-updates)

The update pipeline is ready to switch on as soon as these exist:

1. **GitHub repo** (private is fine) — hosts source and serves the update feed via
   GitHub Releases. Required.
2. **Apple Developer account** ($99/yr) — for code-signing + notarizing the macOS
   build. Without it, staff see the Gatekeeper "unidentified developer" warning
   on first install and can't get silent background auto-updates. Required for
   macOS staff.
3. **Windows code-signing certificate** ($100–400/yr or Azure Trusted Signing) —
   only if any staff are on Windows. Without it, Windows SmartScreen warns on
   first launch.

### When the accounts are ready
- Fill in the `publish` block of `package.json`:
  ```json
  "publish": [{ "provider": "github", "owner": "<YOU>", "repo": "<REPO>" }]
  ```
- Add Apple credentials as GitHub Actions secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (signing cert base64), `CSC_KEY_PASSWORD`.
- Add a `.github/workflows/release.yml` that runs `electron-builder --publish always` on tag push.
- Tagging `v0.3.0` → GitHub Action → signed/notarized DMG uploaded to Releases →
  installed app auto-downloads on next launch via `electron-updater`.

---

## Troubleshooting

### "Spotify rejected my upload"
Check the MP4's color tags:

```bash
$(node -p "require('ffmpeg-static')") -i your-canvas.mp4 2>&1 | grep Video:
```

You want to see `yuv420p(tv, bt709, progressive)`. If it says `bt470bg` or
`unknown`, the build is missing the fix — rebuild from source or install
v0.2.1+ of the desktop app.

### "Gatekeeper blocks the app on first launch"
Right-click → Open the first time. If no "Open" button appears in the dialog,
go to **System Settings → Privacy & Security** and scroll to the bottom for an
"Open Anyway" button. One-time action; the app is trusted after that.

### "Port 3737 already in use"
Something else is bound to it. Override with `PORT=3738 npm run web` or kill the
other process: `lsof -ti:3737 | xargs kill`.

### "Rendered canvas looks choppy at the loop point"
Loop motion is mathematically continuous (phase step at the seam = phase step
between any other two frames). A visible seam usually means the input image has
hard edges that get exaggerated by rotation / zoom — try a different animation
(`zoom` or `glow` are the subtlest) or a higher `--fg-scale` with `fit` layout.

### "Rebuild fails with 'app is still running'"
Electron won't overwrite a running copy. Quit the app (`⌘Q`) first, then
`rm -rf release/ && npm run dist:mac`.

---

## License

Internal — 55 Music. © 2026.
