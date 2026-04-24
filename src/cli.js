#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir, stat, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { cpus } from 'node:os';
import pLimit from 'p-limit';
import { generateCanvas, ANIMATIONS, LAYOUTS, SPOTIFY_DEFAULTS } from './index.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const SPOTIFY_SIZE_LIMIT_MB = 8; // conservative community-consensus cap; Spotify doesn't publish one

function printHelp() {
  process.stdout.write(`canvas-maker — Spotify Canvas video generator

Defaults target Spotify's official Canvas spec: 9:16 vertical MP4,
1080x1920, 3-8 seconds, seamlessly looping.

Usage:
  canvas-maker <input> [options]

Arguments:
  input                  Image file OR directory of cover art

Options:
  -o, --output DIR       Output directory (default: ./output)
  -a, --animation NAME   ${ANIMATIONS.join(', ')} (default: ${SPOTIFY_DEFAULTS.animation})
  -l, --layout NAME      ${LAYOUTS.join(', ')} (default: ${SPOTIFY_DEFAULTS.layout})
                           fit        — blurred cover background + centered animated cover
                           fill       — crop square cover to fill 9:16 (loses sides)
                           letterbox  — black bars + centered animated cover
  -d, --duration SEC     Duration in seconds, 3-8 (default: ${SPOTIFY_DEFAULTS.duration})
      --fps N            Frames per second (default: ${SPOTIFY_DEFAULTS.fps})
      --width N          Output width  (default: ${SPOTIFY_DEFAULTS.width})
      --height N         Output height (default: ${SPOTIFY_DEFAULTS.height})
      --fg-scale FLOAT   Centered-cover size, 0-1, for fit/letterbox (default: ${SPOTIFY_DEFAULTS.fgScale})
  -p, --particles        Subtle shimmering particle overlay
  -c, --concurrency N    Parallel ffmpeg jobs (default: CPU count)
      --crf N            H.264 quality, lower = better (default: ${SPOTIFY_DEFAULTS.crf})
      --maxrate K        Max bitrate in kbps (default: ${SPOTIFY_DEFAULTS.maxBitrateKbps})
      --preset NAME      libx264 preset (default: ${SPOTIFY_DEFAULTS.preset})
  -h, --help             Show this help

Examples:
  canvas-maker cover.jpg
  canvas-maker ./albums -a drift -d 5
  canvas-maker ./albums -l fill -a pulse
  canvas-maker ./albums -o ./canvases -c 8 -p
`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o', default: './output' },
    animation: { type: 'string', short: 'a', default: SPOTIFY_DEFAULTS.animation },
    layout: { type: 'string', short: 'l', default: SPOTIFY_DEFAULTS.layout },
    duration: { type: 'string', short: 'd', default: String(SPOTIFY_DEFAULTS.duration) },
    fps: { type: 'string', default: String(SPOTIFY_DEFAULTS.fps) },
    width: { type: 'string', default: String(SPOTIFY_DEFAULTS.width) },
    height: { type: 'string', default: String(SPOTIFY_DEFAULTS.height) },
    'fg-scale': { type: 'string', default: String(SPOTIFY_DEFAULTS.fgScale) },
    particles: { type: 'boolean', short: 'p', default: false },
    concurrency: { type: 'string', short: 'c' },
    crf: { type: 'string', default: String(SPOTIFY_DEFAULTS.crf) },
    maxrate: { type: 'string', default: String(SPOTIFY_DEFAULTS.maxBitrateKbps) },
    preset: { type: 'string', default: SPOTIFY_DEFAULTS.preset },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) { printHelp(); process.exit(0); }
if (positionals.length === 0) { printHelp(); process.exit(1); }

async function collectInputs(p) {
  const s = await stat(p);
  if (s.isDirectory()) {
    const entries = await readdir(p, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
      .map((e) => join(p, e.name))
      .sort();
  }
  return [p];
}

const inputPath = resolve(positionals[0]);
const outputDir = resolve(values.output);
const duration = Number(values.duration);
const fps = Number(values.fps);
const width = Number(values.width);
const height = Number(values.height);
const fgScale = Number(values['fg-scale']);
const crf = Number(values.crf);
const maxBitrateKbps = Number(values.maxrate);
const concurrency = values.concurrency ? Number(values.concurrency) : cpus().length;

await mkdir(outputDir, { recursive: true });
const inputs = await collectInputs(inputPath);
if (inputs.length === 0) {
  console.error(`No images found at ${inputPath}`);
  process.exit(1);
}

console.log(
  `Found ${inputs.length} image(s). ` +
  `${width}x${height} layout=${values.layout} animation=${values.animation} ` +
  `duration=${duration}s fps=${fps}${values.particles ? ' particles=on' : ''} ` +
  `concurrency=${concurrency}`
);

const limit = pLimit(concurrency);
let done = 0;
let failed = 0;
let oversized = 0;
const failures = [];
const started = Date.now();

const tasks = inputs.map((file) => limit(async () => {
  const name = basename(file, extname(file));
  const output = join(outputDir, `${name}.mp4`);
  try {
    await generateCanvas({
      input: file,
      output,
      animation: values.animation,
      layout: values.layout,
      duration,
      fps,
      width,
      height,
      fgScale,
      particles: values.particles,
      crf,
      maxBitrateKbps,
      preset: values.preset,
    });
    const { size } = await stat(output);
    if (size / 1024 / 1024 > SPOTIFY_SIZE_LIMIT_MB) oversized++;
    done++;
  } catch (err) {
    failed++;
    failures.push({ file, message: err.message });
  }
  const total = done + failed;
  process.stdout.write(`\r[${total}/${inputs.length}] (${done} ok, ${failed} failed)    `);
}));

await Promise.all(tasks);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write('\n');
if (failures.length) {
  console.error(`\nFailures:`);
  for (const { file, message } of failures) {
    console.error(`  ${file}\n    ${message.split('\n').slice(-3).join('\n    ')}`);
  }
}
console.log(`\nDone in ${elapsed}s — ${done} ok, ${failed} failed. Output: ${outputDir}`);
if (oversized > 0) {
  console.warn(`Note: ${oversized} file(s) exceeded ${SPOTIFY_SIZE_LIMIT_MB} MB. Retry with --crf 26 or --maxrate 4000 for smaller files.`);
}
