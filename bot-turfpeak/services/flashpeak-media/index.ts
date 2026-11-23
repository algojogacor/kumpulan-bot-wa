import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}
loadEnv();

export * from './config.js';
export * from './db.js';
export * from './storage.js';
export * from './detector.js';
export * from './security.js';
export * from './server.js';

import { createMediaServer } from './server.js';

export async function startMediaService() {
  const mediaServer = createMediaServer();
  const info = await mediaServer.start();
  console.log(`[flashpeak-media] Server running at http://${info.host}:${info.port}`);
  return mediaServer;
}

// Allow direct CLI execution if run directly via node/tsx
const scriptPath = (process.argv[1] || '').replace(/\\/g, '/');
if (scriptPath.endsWith('index.ts') || scriptPath.endsWith('index.js')) {
  startMediaService().catch((err) => {
    console.error('[flashpeak-media] Failed to start:', err);
    process.exit(1);
  });
}
