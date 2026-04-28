// Post-render Spotify-Canvas-spec validator.
//
// Spotify rejects Canvas uploads that miss any of:
//   - 9:16 aspect (we ship 1080×1920)
//   - 3–8 seconds
//   - H.264 (avc1) in MP4
//   - No audio track
//   - <8MB
//   - Explicit BT.709 colorspace/primaries/trc (covered by feedback memory:
//     unset/bt470bg tags get silently rejected at ingest)
//
// We probe every render and refuse to ship the file if anything misses.
// Better to fail loud here than to ship a bad MP4 the user pays for and
// Spotify silently drops.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import ffprobeStatic from 'ffprobe-static';

// In production (Docker) we install full ffmpeg via apt and ffprobe is on PATH.
// In local dev / Electron we don't, so fall back to the bundled binary.
// Set FFPROBE_PATH to override (e.g. for nonstandard system installs).
const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe';

const SPEC = Object.freeze({
  minWidth: 720,
  minHeight: 1280,
  aspectRatio: 9 / 16,
  aspectTolerance: 0.01,
  minDurationSec: 3,
  maxDurationSec: 8,
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  expectedColor: 'bt709',
  maxBytes: 8 * 1024 * 1024,
});

function runProbe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const child = spawn(FFPROBE, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr.trim()}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`ffprobe JSON parse failed: ${e.message}`)); }
    });
  });
}

/**
 * Probe the rendered MP4 and return a list of human-readable spec
 * violations. Empty list = passes.
 */
export async function validateCanvasSpec(filePath) {
  const violations = [];

  // File size first — cheapest check, catches grossly oversized renders.
  const fileStat = await stat(filePath);
  if (fileStat.size > SPEC.maxBytes) {
    violations.push(`File size ${(fileStat.size / 1024 / 1024).toFixed(2)}MB exceeds 8MB limit.`);
  }

  let probe;
  try { probe = await runProbe(filePath); }
  catch (err) { return [`ffprobe failed: ${err.message}`]; }

  const video = (probe.streams || []).find((s) => s.codec_type === 'video');
  const audio = (probe.streams || []).find((s) => s.codec_type === 'audio');

  if (!video) {
    violations.push('No video stream found.');
    return violations;
  }

  if (audio) {
    violations.push('Audio track present — Spotify Canvas must be silent.');
  }

  if (video.codec_name !== SPEC.videoCodec) {
    violations.push(`Codec ${video.codec_name} — expected ${SPEC.videoCodec} (H.264).`);
  }

  if (video.pix_fmt !== SPEC.pixelFormat) {
    violations.push(`Pixel format ${video.pix_fmt} — expected ${SPEC.pixelFormat}.`);
  }

  const w = Number(video.width);
  const h = Number(video.height);
  if (!w || !h) {
    violations.push('Could not read video dimensions.');
  } else {
    if (w < SPEC.minWidth || h < SPEC.minHeight) {
      violations.push(`Dimensions ${w}×${h} below 720×1280 minimum.`);
    }
    const aspect = w / h;
    if (Math.abs(aspect - SPEC.aspectRatio) > SPEC.aspectTolerance) {
      violations.push(`Aspect ${aspect.toFixed(4)} not 9:16 (expected ~${SPEC.aspectRatio.toFixed(4)}).`);
    }
  }

  // Duration: prefer container's format.duration, fall back to stream duration.
  const duration = Number(probe.format?.duration || video.duration);
  if (!duration || Number.isNaN(duration)) {
    violations.push('Could not read duration.');
  } else if (duration < SPEC.minDurationSec || duration > SPEC.maxDurationSec) {
    violations.push(`Duration ${duration.toFixed(2)}s outside 3–8s range.`);
  }

  // Color tags — Spotify silently rejects without explicit BT.709.
  const cs = video.color_space || '';
  const cp = video.color_primaries || '';
  const ct = video.color_transfer || '';
  if (cs !== SPEC.expectedColor || cp !== SPEC.expectedColor || ct !== SPEC.expectedColor) {
    violations.push(
      `Color tags missing or wrong: colorspace=${cs || 'unset'}, primaries=${cp || 'unset'}, ` +
      `transfer=${ct || 'unset'} — all three must be ${SPEC.expectedColor}.`
    );
  }

  return violations;
}
