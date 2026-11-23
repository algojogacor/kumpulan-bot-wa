import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ROLE_DIRS } from './config.js';

export function initStorageTree(storageRoot: string): void {
  const dirs = [
    'private/match_evidence',
    'private/goalkeeper_detail',
    'private/supporting',
    'private/manual_review',
    'quarantine',
    'tmp',
    'backups',
    'database',
  ];

  for (const dir of dirs) {
    const fullPath = path.join(storageRoot, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true, mode: 0o750 });
    }
  }
}

export function getSafeFilePath(
  storageRoot: string,
  mediaRole: string,
  filename: string
): { relativePath: string; absolutePath: string } {
  const roleDir = MEDIA_ROLE_DIRS[mediaRole] || 'private/supporting';

  // Prevent path traversal in filename
  const sanitizedFilename = path.basename(filename);
  if (
    !sanitizedFilename ||
    sanitizedFilename !== filename ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('Path traversal attempt detected in filename');
  }

  const targetDir = path.join(storageRoot, roleDir);
  const targetPath = path.join(targetDir, sanitizedFilename);

  // Assert targetPath is strictly inside targetDir
  const rel = path.relative(targetDir, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path traversal assertion failed');
  }

  const relativePath = path.join(roleDir, sanitizedFilename).replace(/\\/g, '/');
  return { relativePath, absolutePath: targetPath };
}

export function getStorageStats(
  storageRoot: string,
  quotaBytes: number
): {
  storageRoot: string;
  usedBytes: number;
  quotaBytes: number;
  freeBytes: number;
  usagePercent: string;
} {
  function getDirSize(dir: string): number {
    let size = 0;
    if (!fs.existsSync(dir)) return 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(full);
      } else if (entry.isFile()) {
        try {
          size += fs.statSync(full).size;
        } catch {
          // Ignore transient file errors
        }
      }
    }
    return size;
  }

  const usedBytes = getDirSize(storageRoot);
  const freeBytes = Math.max(0, quotaBytes - usedBytes);
  const usagePercent = quotaBytes > 0 ? ((usedBytes / quotaBytes) * 100).toFixed(2) : '0.00';

  return {
    storageRoot,
    usedBytes,
    quotaBytes,
    freeBytes,
    usagePercent,
  };
}

export function checkQuotaAvailable(
  storageRoot: string,
  quotaBytes: number,
  additionalBytes = 0
): void {
  const stats = getStorageStats(storageRoot, quotaBytes);
  if (stats.usedBytes + additionalBytes > stats.quotaBytes) {
    const err = new Error(
      `Storage quota exceeded. Used: ${stats.usedBytes} bytes, Quota: ${stats.quotaBytes} bytes`
    );
    (err as unknown as { code: string; statusCode: number }).code = 'QUOTA_EXCEEDED';
    (err as unknown as { code: string; statusCode: number }).statusCode = 507;
    throw err;
  }
}

export function moveToQuarantine(
  storageRoot: string,
  currentPath: string,
  storedFilename: string
): string {
  const quarantineDir = path.join(storageRoot, 'quarantine');
  if (!fs.existsSync(quarantineDir)) {
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  }

  const destination = path.join(quarantineDir, `${Date.now()}_${path.basename(storedFilename)}`);
  if (fs.existsSync(currentPath)) {
    fs.renameSync(currentPath, destination);
  }
  return destination;
}

export function cleanupStaleTempFiles(storageRoot: string, maxAgeMs = 15 * 60 * 1000): number {
  const tmpDir = path.join(storageRoot, 'tmp');
  if (!fs.existsSync(tmpDir)) return 0;

  const now = Date.now();
  let cleaned = 0;
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith('upload_') && entry.endsWith('.tmp')) {
        const fullPath = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch {
          // Ignore transient errors
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return cleaned;
}
