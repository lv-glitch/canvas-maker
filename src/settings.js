import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.canvas-maker');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * Resolve settings with the precedence:
 *   1. Environment variables (production: set via `fly secrets set`)
 *   2. Config file at ~/.canvas-maker/config.json (local dev: persisted by the
 *      Settings modal in the UI)
 *
 * Env vars take priority so a deploy can override whatever's in the file.
 */
export async function loadSettings() {
  let stored = {};
  try {
    const data = await readFile(CONFIG_PATH, 'utf8');
    stored = JSON.parse(data);
  } catch {
    // No config file yet — fine. Env vars (if set) will fill in.
  }

  return {
    ...stored,
    ...(process.env.FAL_API_KEY ? { falApiKey: process.env.FAL_API_KEY } : {}),
    ...(process.env.FAL_MODEL ? { falModel: process.env.FAL_MODEL } : {}),
  };
}

export async function saveSettings(settings) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(settings, null, 2));
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
}

// Mask the api key for display: keep first 7 + last 4 chars
export function maskKey(key) {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
