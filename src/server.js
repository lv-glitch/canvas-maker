#!/usr/bin/env node
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, unlink, rm } from 'node:fs/promises';
import { generateCanvas, ANIMATIONS, ANIMATION_META, LAYOUTS, SPOTIFY_DEFAULTS } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_MB = 25;

export function createApp() {
  const app = express();
  const upload = multer({
    dest: tmpdir(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });

  app.use(express.static(join(__dirname, '..', 'public')));

  app.get('/api/options', (_req, res) => {
    res.json({
      animations: ANIMATIONS.map((name) => ({ name, description: ANIMATION_META[name] })),
      layouts: LAYOUTS,
      defaults: SPOTIFY_DEFAULTS,
    });
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
      const duration = Math.min(8, Math.max(3, Number(req.body.duration) || SPOTIFY_DEFAULTS.duration));
      const particles = req.body.particles === 'true' || req.body.particles === 'on';

      await generateCanvas({
        input: req.file.path,
        output: outputPath,
        animation, layout, duration, particles,
      });

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline; filename="canvas.mp4"');
      res.sendFile(outputPath, { headers: { 'Cache-Control': 'no-store' } }, async () => {
        await cleanup();
      });
    } catch (err) {
      await cleanup();
      const tail = err.message.split('\n').slice(-4).join('\n');
      res.status(500).json({ error: tail });
    }
  });

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

// Run as standalone CLI (canvas-maker-web) when invoked directly
const isDirectlyInvoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyInvoked) {
  const port = Number(process.env.PORT) || 3737;
  startServer({ port, host: '127.0.0.1' }).then(({ url }) => {
    console.log(`canvas-maker web UI: ${url}`);
    if (platform() === 'darwin' && !process.env.NO_OPEN) {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  }).catch((err) => {
    console.error(`Server failed to start: ${err.message}`);
    process.exit(1);
  });
}
