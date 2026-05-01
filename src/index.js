import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegPathStatic from 'ffmpeg-static';

// When packaged inside an Electron .asar, ffmpeg-static's path points into the asar
// archive, which can't be executed. electron-builder's asarUnpack config moves the
// binary to app.asar.unpacked — so we rewrite the path to match.
const ffmpegPath = ffmpegPathStatic.replace('app.asar', 'app.asar.unpacked');

export const ANIMATIONS = [
  'zoom', 'drift', 'pulse', 'kenburns', 'tilt', 'vertigo', 'glow', 'rotate',
];
export const ANIMATION_META = Object.freeze({
  zoom:     'Subtle breathing zoom',
  drift:    'Slow floating pan',
  pulse:    'Sharp rhythmic zoom — beat cadence',
  kenburns: 'Cinematic zoom and pan',
  tilt:     'Gentle side-to-side rocking',
  vertigo:  'Hypnotic zoom with rotation',
  glow:     'Soft halation bloom over the photo',
  rotate:   'Full 360° rotation',
});
export const LAYOUTS = ['fill', 'fit', 'letterbox'];

// Photo-look filters. Each is a per-frame transform applied AFTER motion.
// Most are flat FFmpeg chains in FILTER_CHAINS below; `softfocus` and
// `shimmer` need split + blend, so they're handled inline in buildFilterGraph
// and generatePreview as special cases.
export const FILTERS = [
  'none', 'goldenhour', 'sunkissed', 'coast', 'softwash',
  'parisian', 'analog', 'noir', 'retro', 'vhs',
  'polaroid', 'softfocus', 'glitch', 'shimmer',
];
export const FILTER_META = Object.freeze({
  none:       { label: 'Original',    description: 'No filter applied' },
  goldenhour: { label: 'Golden Hour', description: 'Bright highlights, deep shadows, boosted saturation' },
  sunkissed:  { label: 'Sunkissed',   description: 'Warm tones, lifted contrast, glowing skin tones' },
  coast:      { label: 'Coast',       description: 'Cool blues and greens, desaturated reds, airy and editorial' },
  softwash:   { label: 'Soft Wash',   description: 'Subtle desaturation, slightly faded — the "no filter" filter' },
  parisian:   { label: 'Parisian',    description: 'Soft, faded, warm pink — French girl aesthetic' },
  analog:     { label: 'Analog',      description: 'Film emulation — lifted blacks, warm midtones, grain' },
  noir:       { label: 'Noir',        description: 'High-contrast black and white' },
  retro:      { label: 'Retro',       description: 'Orange-shifted shadows, muted highlights, grain' },
  vhs:        { label: 'VHS',         description: 'Camcorder — subtle RGB shift, faded, warm noise' },
  polaroid:   { label: 'Polaroid',    description: 'Cream highlights, cool blue-green shadows, faded contrast, light grain + vignette' },
  softfocus:  { label: 'Soft Focus',  description: 'Soft glow / beauty bloom — flattering halation' },
  glitch:     { label: 'Glitch',      description: 'RGB split / chromatic aberration — vivid digital glitch' },
  shimmer:    { label: 'Shimmer',     description: 'Animated sparkle overlay (animates in the final canvas)' },
});

// Flat filter chains keyed by internal filter name.
const FILTER_CHAINS = Object.freeze({
  none: '',
  goldenhour:
    // Push saturation + contrast hard, deepen shadows, brighten highlights,
    // and add a warm cast in midtones.
    `eq=contrast=1.30:saturation=1.55,` +
    `curves=master='0/0 0.20/0.16 0.5/0.58 0.80/0.88 1/1',` +
    `colorbalance=rm=0.07:bm=-0.06:rh=0.04:bh=-0.04`,
  sunkissed:
    // Warm peachy skin glow — strong red lift in midtones, slight desaturate
    // of blue, soft contrast bump.
    `eq=contrast=1.18:saturation=1.42,` +
    `colorbalance=rs=0.15:gs=0.05:bs=-0.15:rm=0.12:gm=0.04:bm=-0.10:rh=0.06:bh=-0.05,` +
    `curves=master='0/0 0.4/0.46 0.7/0.75 1/0.98'`,
  coast:
    // Cool, airy editorial — kill warm tones, push blue/green, lift overall.
    `colorbalance=rh=-0.18:rm=-0.13:rs=-0.08:gh=0.10:gm=0.06:bh=0.22:bm=0.14:bs=0.08,` +
    `eq=contrast=1.10:saturation=1.05:brightness=0.04,` +
    `curves=master='0/0.04 0.5/0.54 1/1'`,
  softwash:
    // Visibly desaturated, lifted blacks, slightly cool — the "I forgot to
    // turn off auto white balance" gentle look.
    `curves=master='0/0.10 1/0.92',` +
    `eq=saturation=0.55:contrast=0.88,` +
    `colorbalance=bs=0.04:bm=0.03`,
  parisian:
    // Soft, faded, distinctly pink-warm.
    `curves=master='0/0.10 0.5/0.55 1/0.93',` +
    `colorbalance=rs=0.12:gs=-0.04:bs=0.06:rm=0.10:gm=-0.02:bm=-0.04:rh=0.05,` +
    `eq=contrast=0.85:saturation=0.85`,
  analog:
    // Lifted blacks (curves), warm midtones, mild grain.
    `curves=master='0/0.16 0.3/0.32 0.7/0.72 1/0.92',` +
    `colorbalance=rs=0.10:gs=0.05:bs=-0.10:rm=0.08:gm=0.02:bm=-0.08,` +
    `eq=saturation=0.95,` +
    `noise=alls=14:allf=t`,
  noir:
    // High-contrast B&W with deep shadows.
    `hue=s=0,eq=contrast=1.45:gamma=0.90`,
  retro:
    // Strong orange shift in shadows + faded highlights.
    `curves=master='0/0.15 0.5/0.55 1/0.90',` +
    `colorbalance=rs=0.22:gs=0.06:bs=-0.20:rm=0.12:gm=-0.02:bm=-0.10:rh=0.04,` +
    `eq=saturation=0.85,noise=alls=10:allf=t`,
  vhs:
    `rgbashift=rh=3:bh=-3,` +
    `eq=saturation=0.82:contrast=0.92,` +
    `colorbalance=rm=0.05:bm=-0.05,` +
    `noise=alls=18:allf=t,gblur=sigma=0.4`,
  polaroid:
    // Vintage instant-film look: lifted blacks, ceiling on highlights (no
    // pure white — Polaroid whites are cream), cool blue-green shadows,
    // warm cream highlights, gentle desat + soft contrast, light grain,
    // subtle vignette. The vignette is `eval=init` so it's computed once
    // (much faster than per-frame) — fine because the photo is moving but
    // the vignette is intended to feel like a fixed lens edge.
    `curves=master='0/0.12 0.3/0.34 0.7/0.72 1/0.90',` +
    `colorbalance=rs=-0.06:gs=0.04:bs=0.08:rm=0.06:gm=0.02:bm=-0.06:rh=0.10:gh=0.04:bh=-0.06,` +
    `eq=saturation=0.78:contrast=0.88,` +
    `noise=alls=9:allf=t,` +
    `vignette=angle=PI/4.5:eval=init`,
  glitch:
    // Aggressive horizontal channel split (red right, blue left), slight
    // green vertical drift, hue rotated, saturation/contrast pushed —
    // gives a digital chromatic-aberration glitch look.
    `rgbashift=rh=12:bh=-10:gv=2,` +
    `hue=h=10,` +
    `eq=contrast=1.18:saturation=1.30,` +
    `noise=alls=4:allf=t`,
});

// Spotify Canvas spec (from support.spotify.com/us/artists/article/canvas-guidelines):
//   - 3-8 second MP4, vertical 9:16, 720-1080px tall.
//   - No rapid cuts or intense flashing.
//   - Seamless loop preferred — all motion below is sin/cos driven so frame[0] == frame[N].
export const SPOTIFY_DEFAULTS = Object.freeze({
  width: 1080,
  height: 1920,
  duration: 6,
  fps: 30,
  layout: 'fill',
  animation: 'zoom',
  fgScale: 0.92,
  crf: 23,
  maxBitrateKbps: 6000,
  preset: 'medium',
});

function buildMotion({ animation, frames, fps, duration, outW, outH, prepW, prepH }) {
  const xCenter = `iw/2-(iw/zoom/2)`;
  const yCenter = `ih/2-(ih/zoom/2)`;
  const size = `${outW}x${outH}`;

  switch (animation) {
    case 'zoom':
      return (
        `zoompan=z='1.08+0.06*sin(2*PI*on/${frames})'` +
        `:d=${frames}:x='${xCenter}':y='${yCenter}':s=${size}:fps=${fps}`
      );
    case 'drift': {
      const ax = Math.round(prepW * 0.04);
      const ay = Math.round(prepH * 0.04);
      return (
        `zoompan=z=1.15:d=${frames}` +
        `:x='${xCenter}+${ax}*sin(2*PI*on/${frames})'` +
        `:y='${yCenter}+${ay}*cos(2*PI*on/${frames})'` +
        `:s=${size}:fps=${fps}`
      );
    }
    case 'pulse':
      // Heartbeat-cadence zoom: 2 sharp beats per second (~120bpm). The sin^6
      // envelope keeps z parked at 1.05 most of the time and snaps to 1.20 at
      // each beat, then snaps back — reads as a heartbeat instead of a sine
      // breath. Frequency is derived from fps so it stays at 2 beats/sec
      // regardless of fps; loop is seamless because (2 beats/sec * integer
      // duration) is always an integer number of full cycles. No per-frame
      // color modulation here — that conflicts with look filters.
      return (
        `zoompan=z='1.05+0.15*pow(sin(PI*2*on/${fps})\\,6)'` +
        `:d=${frames}:x='${xCenter}':y='${yCenter}':s=${size}:fps=${fps}`
      );
    case 'kenburns': {
      // Zoom from 1.05 to 1.25 with diagonal drift. (1-cos) envelope = ease in/out, seamless loop.
      const ax = Math.round(prepW * 0.06);
      const ay = Math.round(prepH * 0.05);
      return (
        `zoompan=z='1.05+0.10*(1-cos(2*PI*on/${frames}))'` +
        `:d=${frames}` +
        `:x='${xCenter}+${ax}*(1-cos(2*PI*on/${frames}))/2'` +
        `:y='${yCenter}+${ay}*(1-cos(2*PI*on/${frames}))/2'` +
        `:s=${size}:fps=${fps}`
      );
    }
    case 'tilt': {
      // ±3° rocking. Zoompan outputs 1.15x the target so rotate's center crop has no black corners.
      const marginW = Math.round(outW * 1.15);
      const marginH = Math.round(outH * 1.15);
      return (
        `zoompan=z=1.05:d=${frames}:x='${xCenter}':y='${yCenter}':s=${marginW}x${marginH}:fps=${fps},` +
        `rotate=angle='0.052*sin(2*PI*t/${duration})':ow=${outW}:oh=${outH}:c=black`
      );
    }
    case 'vertigo': {
      // Breathing zoom + ±5.7° rotation. 1.25x margin for rotation headroom.
      const marginW = Math.round(outW * 1.25);
      const marginH = Math.round(outH * 1.25);
      return (
        `zoompan=z='1.08+0.06*sin(2*PI*on/${frames})':d=${frames}` +
        `:x='${xCenter}':y='${yCenter}':s=${marginW}x${marginH}:fps=${fps},` +
        `rotate=angle='0.10*sin(2*PI*t/${duration})':ow=${outW}:oh=${outH}:c=black`
      );
    }
    case 'glow':
      // Glow is about light, not motion. Hold the photo essentially static
      // (a barely-perceptible 1.04↔1.06 breath, just so it doesn't feel like
      // a still image) and let the halation bloom in buildFilterGraph carry
      // the rhythm. The bloom is composited *after* the user's look filter
      // (chains-aware split → gblur → screen-blend), so the look's color
      // grade survives unchanged underneath.
      return (
        `zoompan=z='1.05+0.01*sin(2*PI*on/${frames})'` +
        `:d=${frames}:x='${xCenter}':y='${yCenter}':s=${size}:fps=${fps}`
      );
    case 'rotate': {
      // One full turn. Pre-scale to 2.1x output — enough diagonal coverage for any rotation angle.
      const marginW = Math.round(outW * 2.1);
      const marginH = Math.round(outH * 2.1);
      return (
        `fps=${fps},scale=${marginW}:${marginH}:flags=lanczos,` +
        `rotate=angle='2*PI*t/${duration}':ow=${outW}:oh=${outH}:c=black`
      );
    }
    default:
      throw new Error(`Unknown animation "${animation}"`);
  }
}

// Watermark — drawtext requires an explicit font file. Probed at runtime;
// first hit wins. fonts-dejavu-core is in the Docker image, ships with most
// Linux distros, and is also widely available on macOS via Homebrew. Local
// mac dev without a TTF in any of these paths gets a console warning and
// renders without the watermark — a graceful no-op rather than a crash.
const WATERMARK_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/opt/homebrew/share/fonts/DejaVuSans-Bold.ttf',
  '/usr/local/share/fonts/DejaVuSans-Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
];

function findWatermarkFont() {
  for (const p of WATERMARK_FONT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Drawtext filter for the dead-center wordmark.
//
// Why dead-center: Spotify's mobile player overlays its now-playing UI
// across the bottom ~35% of the Canvas (song title, scrubber, transport
// controls), and a status bar across the top ~10%. A bottom-right or
// bottom-left mark is invisible in the actual player, defeating the
// upgrade hook. The middle is the only zone guaranteed visible across
// the player's various states (lock screen, full player, mini-player).
function watermarkFilter() {
  const font = findWatermarkFont();
  if (!font) {
    console.warn('[canvas-maker] no watermark font found; rendering without watermark');
    return null;
  }
  // FFmpeg drawtext requires single quotes around fontfile and text, with
  // colons/backslashes escaped via backslash. The wordmark itself is plain
  // ASCII so we don't need extra escaping.
  return (
    `drawtext=fontfile='${font.replace(/:/g, '\\:').replace(/'/g, "\\'")}':` +
    `text='canvasbuddy.io':` +
    `fontcolor=white@0.5:` +
    `fontsize=64:` +
    `x=(w-tw)/2:y=(h-th)/2:` +
    `shadowcolor=black@0.45:shadowx=2:shadowy=2`
  );
}

function buildFilterGraph({ animation, duration, fps, width, height, layout, fgScale, look, watermark }) {
  const frames = Math.round(duration * fps);

  // Post-processing: apply the selected look filter (color, blur, shimmer, etc.)
  // The motion chain always ends with [main]; this function appends the look
  // and returns the final graph plus the output label to map.
  const appendPostprocess = (mainChain) => {
    let graph = mainChain;
    let label = '[main]';

    if (look && look !== 'none') {
      if (look === 'softfocus') {
        // Dreamy, soft, slightly washed look. Earlier version used split +
        // gblur + screen-blend, which dragged darks toward magenta on
        // low-light photos. This simpler chain (blur + light/desaturated
        // tone curve) reads as "soft focus" without the color cast.
        graph +=
          `;${label}gblur=sigma=2.0,` +
          `eq=brightness=0.04:saturation=0.92:contrast=0.88,` +
          `format=yuv420p[styled]`;
      } else if (look === 'shimmer') {
        // Animated sparkles. `screen` blend was dragging chroma pink because
        // FFmpeg evaluates the blend per-plane and the dense-noise/opaque
        // luma layer + opacity-mix on chroma produced a tint. `lighten`
        // (per-pixel max) keeps the photo's color where there's no sparkle
        // and shows the bright sparkle where there is. Tuned to be subtle.
        const sparkle =
          `color=black:s=${width}x${height}:d=${duration}:r=${fps},` +
          `noise=alls=22:allf=t+p,` +
          `lutyuv=y='gt(val\\,252)*255':u=128:v=128,` +
          `gblur=sigma=0.8`;
        graph +=
          `;${sparkle}[shimmer_layer];` +
          `${label}[shimmer_layer]blend=all_mode=lighten:all_opacity=0.55,` +
          `format=yuv420p[styled]`;
      } else {
        const chain = FILTER_CHAINS[look];
        if (chain) {
          graph += `;${label}${chain},format=yuv420p[styled]`;
        }
      }
      label = '[styled]';
    }

    // Glow halation pass — split the styled output, soft-blur one copy
    // heavily, and screen-blend the bloom back on top with a time-varying
    // alpha that throbs once per second. Runs *after* the look filter so
    // the look's color grade is the static baseline; glow only adds the
    // rhythmic bloom on top of that grade.
    //
    // c0 (Y / luma) takes the screen-blend:
    //   out = A + (255-A) * alpha(T) * B / 255
    //   alpha(T) = 0.40 - 0.40*cos(2*PI*T)  → range 0 → 0.80, 1Hz throb
    // The cos-with-offset form starts each loop at alpha=0 (no glow) and
    // peaks halfway through the second at alpha=0.80, reading as a clear
    // "throbbing glow" instead of a constant haze.
    // c1/c2 (U/V chroma) pass through unchanged so the bloom never tints
    // the photo's colours — it only brightens.
    if (animation === 'glow') {
      const alphaExpr = `(0.40-0.40*cos(2*PI*T))`;
      graph +=
        `;${label}split=2[g_a][g_b];` +
        `[g_b]gblur=sigma=22[g_blurred];` +
        `[g_a][g_blurred]blend=` +
        `c0_expr='A+(255-A)*${alphaExpr}*B/255':` +
        `c1_expr='A':c2_expr='A',` +
        `format=yuv420p[glown]`;
      label = '[glown]';
    }

    // Free-tier watermark — applied last so it sits above the look filter and
    // never gets blurred/colour-shifted by it.
    if (watermark) {
      const wm = watermarkFilter();
      if (wm) {
        graph += `;${label}${wm},format=yuv420p[wmd]`;
        label = '[wmd]';
      }
    }

    return { filter: graph, outputLabel: label };
  };

  // FILL: crop the square cover into the 9:16 frame and animate the whole thing.
  // Trades cover content (~43% lost horizontally) for a full-bleed effect.
  if (layout === 'fill') {
    const prepW = width * 3;
    const prepH = height * 3;
    const prep =
      `scale=${prepW}:${prepH}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${prepW}:${prepH},setsar=1`;
    const motion = buildMotion({
      animation, frames, fps, duration,
      outW: width, outH: height, prepW, prepH,
    });
    return appendPostprocess(`[0:v]${prep},${motion},format=yuv420p[main]`);
  }

  // fit / letterbox: animate a square foreground and composite onto a full-frame background.
  const fgSize = Math.round(Math.min(width, height) * fgScale);
  const big = fgSize * 3;
  const fgPrep =
    `scale=${big}:${big}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${big}:${big},setsar=1`;
  const fgMotion = buildMotion({
    animation, frames, fps, duration,
    outW: fgSize, outH: fgSize, prepW: big, prepH: big,
  });

  let chain;
  if (layout === 'fit') {
    // FIT (default for vertical canvas): blurred + darkened cover fills the frame,
    // sharp animated cover sits centered on top. No cover content is lost.
    // Downscale-then-blur-then-upscale is MUCH faster than gblur at native res.
    const bgChain =
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${width}:${height},` +
      `scale=${Math.round(width / 10)}:${Math.round(height / 10)}:flags=lanczos,` +
      `gblur=sigma=8,` +
      `scale=${width}:${height}:flags=lanczos,` +
      `eq=brightness=-0.18:saturation=1.15`;
    chain =
      `[0:v]split=2[bg_src][fg_src];` +
      `[bg_src]${bgChain},format=yuv420p[bg];` +
      `[fg_src]${fgPrep},${fgMotion},format=yuv420p[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[main]`;
  } else if (layout === 'letterbox') {
    chain =
      `color=black:s=${width}x${height}:d=${duration}:r=${fps},format=yuv420p[bg];` +
      `[0:v]${fgPrep},${fgMotion},format=yuv420p[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[main]`;
  } else {
    throw new Error(`Unknown layout "${layout}". Must be one of: ${LAYOUTS.join(', ')}`);
  }

  return appendPostprocess(chain);
}

export async function generateCanvas({
  input,
  output,
  animation = SPOTIFY_DEFAULTS.animation,
  duration = SPOTIFY_DEFAULTS.duration,
  fps = SPOTIFY_DEFAULTS.fps,
  width = SPOTIFY_DEFAULTS.width,
  height = SPOTIFY_DEFAULTS.height,
  layout = SPOTIFY_DEFAULTS.layout,
  fgScale = SPOTIFY_DEFAULTS.fgScale,
  look = 'none',
  crf = SPOTIFY_DEFAULTS.crf,
  maxBitrateKbps = SPOTIFY_DEFAULTS.maxBitrateKbps,
  preset = SPOTIFY_DEFAULTS.preset,
  watermark = false,
  overwrite = true,
}) {
  if (!ANIMATIONS.includes(animation)) {
    throw new Error(`Unknown animation "${animation}". Must be one of: ${ANIMATIONS.join(', ')}`);
  }
  if (!LAYOUTS.includes(layout)) {
    throw new Error(`Unknown layout "${layout}". Must be one of: ${LAYOUTS.join(', ')}`);
  }
  if (!FILTERS.includes(look)) {
    throw new Error(`Unknown filter "${look}". Must be one of: ${FILTERS.join(', ')}`);
  }
  if (duration < 3 || duration > 8) {
    throw new Error(`duration must be between 3 and 8 seconds per Spotify Canvas spec (got ${duration})`);
  }

  const { filter, outputLabel } = buildFilterGraph({
    animation, duration, fps, width, height, layout, fgScale, look, watermark,
  });

  const args = [
    overwrite ? '-y' : '-n',
    '-loop', '1',
    '-i', input,
    '-filter_complex', filter,
    '-map', outputLabel,
    '-t', String(duration),
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-pix_fmt', 'yuv420p',
    // Explicit BT.709 color tags — without these, some platforms (including
    // Spotify's Canvas ingestion) either flag the file or decode with wrong
    // color. HD content (>=720p) should always be tagged bt709.
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-maxrate', `${maxBitrateKbps}k`,
    '-bufsize', `${maxBitrateKbps * 2}k`,
    '-g', String(fps), // keyframe every second for reliable looping
    '-movflags', '+faststart',
    '-an',
    output,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`ffmpeg exited ${code}:\n${tail}`));
      } else {
        resolve({ input, output });
      }
    });
  });
}

// Render a single-frame still preview of the look filter applied to a photo,
// at small size, output as JPEG. Used by the UI's filter-thumbnail strip so
// users can see all 11 filters side-by-side without rendering a full video.
export async function generatePreview({
  input,
  output,
  look = 'none',
  width = 270,
  height = 480, // 9:16
}) {
  if (!FILTERS.includes(look)) {
    throw new Error(`Unknown filter "${look}". Must be one of: ${FILTERS.join(', ')}`);
  }

  // Same prep as the canvas pipeline so the preview matches the final output
  // (just smaller and without motion).
  const prep =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},setsar=1`;

  let chain;
  if (look === 'softfocus') {
    // Match the canvas-pipeline soft focus: blur + slight desat + brightness
    // bump. No screen-blend, so no magenta cast on dark images.
    chain =
      `${prep},gblur=sigma=1.6,` +
      `eq=brightness=0.04:saturation=0.92:contrast=0.88[out]`;
  } else if (look === 'shimmer') {
    // Lighten blend instead of screen — kills the pink chroma wash.
    chain =
      `${prep}[base];` +
      `color=black:s=${width}x${height}:d=1,noise=alls=22:allf=t+p,` +
      `lutyuv=y='gt(val\\,252)*255':u=128:v=128,gblur=sigma=0.8[shimmer_layer];` +
      `[base][shimmer_layer]blend=all_mode=lighten:all_opacity=0.55[out]`;
  } else if (look !== 'none' && FILTER_CHAINS[look]) {
    chain = `${prep},${FILTER_CHAINS[look]}[out]`;
  } else {
    chain = `${prep}[out]`;
  }

  const args = [
    '-y',
    '-i', input,
    '-filter_complex', chain,
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', '5', // JPEG quality (1=best, 31=worst). 5 ≈ 80% JPEG.
    output,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-4).join('\n');
        reject(new Error(`ffmpeg preview exited ${code}:\n${tail}`));
      } else {
        resolve({ input, output });
      }
    });
  });
}
