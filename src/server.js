#!/usr/bin/env node
// MUST be the first import — Sentry has to patch node internals before
// other modules load. Fail-open when SENTRY_DSN is unset.
import './instrument.js';
import * as Sentry from '@sentry/node';
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, unlink, rm } from 'node:fs/promises';
import { generateCanvas, generatePreview, ANIMATIONS, ANIMATION_META, LAYOUTS, FILTERS, FILTER_META, SPOTIFY_DEFAULTS } from './index.js';
import { loadSettings, saveSettings, maskKey } from './settings.js';
import { validateCanvasSpec } from './spec.js';
import { verifyTurnstile } from './turnstile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_MB = 25;

export function createApp() {
  const app = express();
  const upload = multer({
    dest: tmpdir(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });

  // CORS — allow the marketing site / app to call this backend from the
  // browser. In production, ALLOWED_ORIGINS is a comma-separated list set as
  // a Fly secret (e.g. "https://canvasbuddy.com,https://canvas-buddy-landing.vercel.app").
  // In local dev, defaults to the localhost origins both apps run on.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
    'http://localhost:3030,http://localhost:3000,http://localhost:5173,http://127.0.0.1:3030')
    .split(',').map((s) => s.trim()).filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Allow any origin if the app explicitly sets ALLOWED_ORIGINS=* (escape hatch);
    // otherwise echo the matching origin so credentials / strict CORS work.
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(join(__dirname, '..', 'public')));
  app.use(express.json({ limit: '4kb' }));

  // Auth gate. Accepts either:
  //   - X-Backend-Token: $BACKEND_TOKEN  (used by canvas-buddy server-side
  //     proxy routes — doesn't reach the browser, so it's a true secret)
  //   - turnstileToken in body  (used by the marketing-site demo where
  //     visitors don't have a Clerk session — Cloudflare Turnstile is the
  //     bot-prevention layer instead)
  // Fail-open when BACKEND_TOKEN is unset so local dev / Electron keep
  // working. Production sets the secret via fly secrets.
  async function requireAuth(req, res, next) {
    const expected = process.env.BACKEND_TOKEN;
    if (!expected) return next(); // fail-open in dev

    const headerToken = req.header('x-backend-token');
    if (headerToken && headerToken === expected) return next();

    // Fall through to Turnstile — only valid for endpoints whose body has
    // a turnstileToken field (we expect /api/generate-image to set it; for
    // others the browser-direct path also wires it before this middleware
    // becomes active in production).
    if (req.body?.turnstileToken) {
      const remoteIP = req.headers['fly-client-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      const verdict = await verifyTurnstile(req.body.turnstileToken, remoteIP);
      if (verdict.ok) return next();
    }
    res.status(401).json({ error: 'Auth required.' });
  }

  // ---- Settings ----------------------------------------------------------
  // GET reports configuration state without ever exposing the raw key.

  app.get('/api/settings', async (_req, res) => {
    const s = await loadSettings();
    res.json({
      hasApiKey: !!s.falApiKey,
      keyPreview: maskKey(s.falApiKey),
      model: s.falModel || 'fal-ai/flux-pro/v1.1',
      provider: 'fal.ai',
    });
  });

  app.post('/api/settings', async (req, res) => {
    const cur = await loadSettings();
    const updated = { ...cur };
    if (typeof req.body.falApiKey === 'string') {
      const k = req.body.falApiKey.trim();
      if (k.length === 0) delete updated.falApiKey;
      else if (k.length > 10) updated.falApiKey = k;
    }
    if (typeof req.body.falModel === 'string' && req.body.falModel) {
      // Allow tier override: 'fal-ai/flux-pro/v1.1' (default) | 'fal-ai/flux/dev' | 'fal-ai/flux/schnell'
      updated.falModel = req.body.falModel;
    }
    try {
      await saveSettings(updated);
      res.json({ ok: true, hasApiKey: !!updated.falApiKey });
    } catch (err) {
      res.status(500).json({ error: `Failed to save settings: ${err.message}` });
    }
  });

  // ---- AI image generation -----------------------------------------------
  // Calls OpenAI's image generation endpoint with the user's stored key,
  // returns the generated PNG as the response body. The UI then treats it
  // exactly like an uploaded photo (sets it as currentPhotoFile, kicks off
  // filter previews, etc.).

  app.post('/api/generate-image', requireAuth, async (req, res) => {
    // Bot check before doing any expensive work — fal.ai is the prime
    // abuse target on this site (~$0.06 per call). The verifier fails open
    // when TURNSTILE_SECRET isn't set so local dev keeps working.
    const remoteIP = req.headers['fly-client-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    const verdict = await verifyTurnstile(req.body.turnstileToken, remoteIP);
    if (!verdict.ok) {
      console.warn(`[generate-image] turnstile rejected: ${verdict.reason}`);
      return res.status(403).json({ error: 'Bot verification failed. Refresh the page and try again.' });
    }

    const settings = await loadSettings();
    if (!settings.falApiKey) {
      return res.status(400).json({ error: 'No fal.ai API key configured. Click the gear icon to add one.' });
    }
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Prompt is empty' });
    if (prompt.length > 4000) return res.status(400).json({ error: 'Prompt is too long (max 4000 chars)' });

    // Flux model tier — Pro 1.1 is the sweet spot for our use case. Flux Dev
    // is half the cost but visibly lower quality on portraits; Schnell is
    // 4-step ultra-fast but rough. User can override via settings.
    const model = settings.falModel || 'fal-ai/flux-pro/v1.1';
    const endpoint = `https://fal.run/${model}`;

    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          // fal.ai uses `Authorization: Key <KEY>`, NOT `Bearer`.
          'Authorization': `Key ${settings.falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          // Custom 9:16 portrait — matches Spotify Canvas spec exactly.
          // Flux Pro caps each side around 1440; 1080×1920 fits.
          image_size: { width: 1080, height: 1920 },
          num_inference_steps: 28,
          guidance_scale: 3.5,
          num_images: 1,
          enable_safety_checker: true,
          output_format: 'png',
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!upstream.ok) {
        const errBody = await upstream.json().catch(() => ({}));
        const msg = errBody?.detail || errBody?.message || errBody?.error || `fal.ai returned HTTP ${upstream.status}`;
        return res.status(upstream.status).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
      }

      const data = await upstream.json();
      // fal.ai returns: { images: [{ url, width, height, content_type }], ... }
      const imageUrl = data?.images?.[0]?.url;
      if (!imageUrl) return res.status(502).json({ error: 'fal.ai returned no image data' });

      // Stream the actual PNG bytes back to the browser instead of redirecting,
      // so the client can treat the response uniformly (blob → File → setImage).
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
      if (!imgRes.ok) {
        return res.status(502).json({ error: `Failed to fetch image from fal.ai CDN (HTTP ${imgRes.status})` });
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Image-Bytes', String(buffer.length));
      res.send(buffer);
    } catch (err) {
      Sentry.captureException(err, { tags: { route: 'generate-image' } });
      const msg = err.name === 'TimeoutError'
        ? 'fal.ai took too long (>2 min). Try again.'
        : err.message;
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/options', (_req, res) => {
    res.json({
      animations: ANIMATIONS.map((name) => ({ name, description: ANIMATION_META[name] })),
      filters: FILTERS.map((name) => ({
        name,
        label: FILTER_META[name].label,
        description: FILTER_META[name].description,
      })),
      layouts: LAYOUTS,
      defaults: { ...SPOTIFY_DEFAULTS, look: 'none' },
    });
  });

  // Single-frame still preview with a look filter applied. Fast (~100-300ms)
  // so the UI can fire 11 of these in parallel on photo upload to populate
  // the filter-thumbnail strip.
  app.post('/api/preview', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const workDir = await mkdtemp(join(tmpdir(), 'canvas-preview-'));
    const outputPath = join(workDir, 'preview.jpg');
    const cleanup = async () => {
      await unlink(req.file.path).catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      const look = FILTERS.includes(req.body.filter) ? req.body.filter : 'none';
      await generatePreview({ input: req.file.path, output: outputPath, look });

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(outputPath, async () => {
        await cleanup();
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { route: 'preview' } });
      await cleanup();
      res.status(500).json({ error: err.message.split('\n').slice(-2).join('\n') });
    }
  });

  app.post('/api/generate', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const workDir = await mkdtemp(join(tmpdir(), 'canvas-'));
    const outputPath = join(workDir, 'canvas.mp4');
    const cleanup = async () => {
      await unlink(req.file.path).catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      const animation = ANIMATIONS.includes(req.body.animation) ? req.body.animation : SPOTIFY_DEFAULTS.animation;
      const layout = LAYOUTS.includes(req.body.layout) ? req.body.layout : SPOTIFY_DEFAULTS.layout;
      const look = FILTERS.includes(req.body.filter) ? req.body.filter : 'none';
      const duration = Math.min(8, Math.max(3, Number(req.body.duration) || SPOTIFY_DEFAULTS.duration));
      // Watermark policy: only privileged callers (those holding the
      // backend token, i.e. our own server-side proxy /api/render and the
      // Stripe-webhook re-render path) can opt out. Anyone else (random
      // curl, browser-direct call) gets watermarked no matter what they
      // pass, closing the "spoof Pro client-side to skip watermark" hole.
      // Local dev / Electron desktop fail-open when BACKEND_TOKEN is unset.
      const expectedToken = process.env.BACKEND_TOKEN;
      const isPrivileged = !expectedToken || req.header('x-backend-token') === expectedToken;
      const watermark = isPrivileged ? (String(req.body.watermark) !== 'false') : true;

      await generateCanvas({
        input: req.file.path,
        output: outputPath,
        animation, layout, look, duration, watermark,
      });

      // Verify the rendered MP4 against Spotify's Canvas spec before shipping.
      // A bad render here would land in a paying user's library and fail at
      // Spotify's ingest with no useful error.
      const violations = await validateCanvasSpec(outputPath);
      if (violations.length) {
        console.warn(`[spec] reject canvas: ${violations.join(' | ')}`);
        Sentry.captureMessage('canvas failed Spotify spec check', {
          level: 'error',
          tags: { route: 'generate', kind: 'spec-violation' },
          extra: { violations, animation, layout, look, duration },
        });
        await cleanup();
        return res.status(500).json({
          error: 'Render did not pass Spotify Canvas spec check.',
          violations,
        });
      }

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline; filename="canvas.mp4"');
      res.sendFile(outputPath, { headers: { 'Cache-Control': 'no-store' } }, async () => {
        await cleanup();
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { route: 'generate' },
        extra: {
          animation: req.body.animation,
          layout: req.body.layout,
          filter: req.body.filter,
          duration: req.body.duration,
        },
      });
      await cleanup();
      const tail = err.message.split('\n').slice(-4).join('\n');
      res.status(500).json({ error: tail });
    }
  });

  // Sentry's express error handler — must be added AFTER all routes so it
  // catches errors thrown from them. No-op when SENTRY_DSN is unset.
  Sentry.setupExpressErrorHandler(app);

  return app;
}

export function startServer({ port = 3737, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://${host}:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// Run as standalone CLI (canvas-maker-web) when invoked directly.
// In production (Docker / Fly.io) NODE_ENV=production sets HOST to 0.0.0.0
// so the container's internal port is reachable from the proxy. Locally,
// stay on 127.0.0.1 so we don't accidentally expose the dev server on a LAN.
const isDirectlyInvoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyInvoked) {
  const port = Number(process.env.PORT) || 3737;
  const host = process.env.HOST
    || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  startServer({ port, host }).then(({ url }) => {
    console.log(`canvas-maker web UI: ${url}`);
    if (platform() === 'darwin' && !process.env.NO_OPEN && process.env.NODE_ENV !== 'production') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  }).catch((err) => {
    console.error(`Server failed to start: ${err.message}`);
    process.exit(1);
  });
}
