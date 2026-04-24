import { spawn } from 'node:child_process';
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
  pulse:    'Zoom with color wash',
  kenburns: 'Cinematic zoom and pan',
  tilt:     'Gentle side-to-side rocking',
  vertigo:  'Hypnotic zoom with rotation',
  glow:     'Pulsing brightness and saturation',
  rotate:   'Full 360° rotation',
});
export const LAYOUTS = ['fill', 'fit', 'letterbox'];

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
      return (
        `zoompan=z='1.10+0.04*sin(2*PI*on/${frames})'` +
        `:d=${frames}:x='${xCenter}':y='${yCenter}':s=${size}:fps=${fps},` +
        `hue=h='6*sin(2*PI*t/${duration})'`
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
      return (
        `zoompan=z='1.06+0.04*sin(2*PI*on/${frames})'` +
        `:d=${frames}:x='${xCenter}':y='${yCenter}':s=${size}:fps=${fps},` +
        `eq=brightness='0.08*sin(2*PI*t/${duration})':saturation='1+0.10*sin(2*PI*t/${duration})'`
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

function buildFilterGraph({ animation, duration, fps, width, height, particles, layout, fgScale }) {
  const frames = Math.round(duration * fps);

  // Particles use source-filtered animated noise, kept subtle to respect Canvas guideline
  // ("avoid rapid cuts or intense flashing graphics").
  const addParticles = (mainChain) => {
    if (!particles) return { filter: mainChain, outputLabel: '[main]' };
    const sparkle =
      `color=black:s=${width}x${height}:d=${duration}:r=${fps},` +
      `noise=alls=60:allf=t+p,` +
      `lutyuv=y='gt(val\\,248)*220':u=128:v=128,` +
      `gblur=sigma=1.4`;
    return {
      filter:
        `${mainChain};` +
        `${sparkle}[spark];` +
        `[main][spark]blend=all_mode=screen:all_opacity=0.25,format=yuv420p[out]`,
      outputLabel: '[out]',
    };
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
    return addParticles(`[0:v]${prep},${motion},format=yuv420p[main]`);
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

  return addParticles(chain);
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
  particles = false,
  crf = SPOTIFY_DEFAULTS.crf,
  maxBitrateKbps = SPOTIFY_DEFAULTS.maxBitrateKbps,
  preset = SPOTIFY_DEFAULTS.preset,
  overwrite = true,
}) {
  if (!ANIMATIONS.includes(animation)) {
    throw new Error(`Unknown animation "${animation}". Must be one of: ${ANIMATIONS.join(', ')}`);
  }
  if (!LAYOUTS.includes(layout)) {
    throw new Error(`Unknown layout "${layout}". Must be one of: ${LAYOUTS.join(', ')}`);
  }
  if (duration < 3 || duration > 8) {
    throw new Error(`duration must be between 3 and 8 seconds per Spotify Canvas spec (got ${duration})`);
  }

  const { filter, outputLabel } = buildFilterGraph({
    animation, duration, fps, width, height, particles, layout, fgScale,
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
