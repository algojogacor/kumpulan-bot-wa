import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export interface MediaDbRecord {
  id: string;
  storage_key: string;
  relative_path: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  media_role: string;
  visibility: string;
  status: string;
  width?: number | null;
  height?: number | null;
  uploaded_by?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export function initMediaDb(storageRoot: string): DatabaseSync {
  const dbDir = path.join(storageRoot, 'database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  }

  const dbFilePath = path.join(dbDir, 'media.sqlite');
  const db = new DatabaseSync(dbFilePath);

  // Performance and durability pragmas
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      storage_key TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      media_role TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'stored',
      width INTEGER,
      height INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_media_items_sha256 ON media_items(sha256);
    CREATE INDEX IF NOT EXISTS idx_media_items_role ON media_items(media_role, status);

    CREATE TABLE IF NOT EXISTS consumed_nonces (
      nonce TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      consumed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON consumed_nonces(expires_at);
  `);

  return db;
}

export function insertMediaRecord(db: DatabaseSync, record: MediaDbRecord): MediaDbRecord {
  const stmt = db.prepare(`
    INSERT INTO media_items (
      id, storage_key, relative_path, original_filename,
      mime_type, byte_size, sha256, media_role,
      visibility, status, width, height, uploaded_by,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    record.id,
    record.storage_key,
    record.relative_path,
    record.original_filename,
    record.mime_type,
    record.byte_size,
    record.sha256,
    record.media_role,
    record.visibility,
    record.status,
    record.width ?? null,
    record.height ?? null,
    record.uploaded_by ?? null,
    record.created_at,
    record.updated_at
  );

  return record;
}

export function getMediaRecordById(db: DatabaseSync, id: string): MediaDbRecord | null {
  const stmt = db.prepare('SELECT * FROM media_items WHERE id = ?');
  const row = stmt.get(id);
  return (row as unknown as MediaDbRecord) || null;
}

export function getMediaRecordByStorageKey(db: DatabaseSync, key: string): MediaDbRecord | null {
  const stmt = db.prepare('SELECT * FROM media_items WHERE storage_key = ?');
  const row = stmt.get(key);
  return (row as unknown as MediaDbRecord) || null;
}

export function updateMediaStatus(
  db: DatabaseSync,
  id: string,
  status: 'stored' | 'quarantined' | 'deleted'
): boolean {
  const now = new Date().toISOString();
  const deletedAt = status === 'deleted' || status === 'quarantined' ? now : null;
  const stmt = db.prepare(`
    UPDATE media_items
    SET status = ?, updated_at = ?, deleted_at = COALESCE(?, deleted_at)
    WHERE id = ?
  `);
  const result = stmt.run(status, now, deletedAt, id);
  return Number(result.changes) > 0;
}

export function consumeNonce(
  db: DatabaseSync,
  nonce: string,
  action: string,
  expiresAt: number
): boolean {
  try {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO consumed_nonces (nonce, action, consumed_at, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(nonce, action, now, expiresAt);
    return true;
  } catch {
    // Unique constraint violation -> already consumed
    return false;
  }
}

export function cleanupExpiredNonces(db: DatabaseSync): number {
  const now = Date.now();
  const stmt = db.prepare('DELETE FROM consumed_nonces WHERE expires_at < ?');
  const result = stmt.run(now);
  return Number(result.changes);
}

export function getMediaStats(db: DatabaseSync): {
  totalItems: number;
  activeItems: number;
  quarantinedItems: number;
  totalFileBytes: number;
} {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS total_items,
      SUM(CASE WHEN status = 'stored' THEN 1 ELSE 0 END) AS active_items,
      SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined_items,
      TOTAL(byte_size) AS total_file_bytes
    FROM media_items
  `);
  const row = stmt.get() as {
    total_items: number;
    active_items: number | null;
    quarantined_items: number | null;
    total_file_bytes: number | null;
  };

  return {
    totalItems: row?.total_items || 0,
    activeItems: row?.active_items || 0,
    quarantinedItems: row?.quarantined_items || 0,
    totalFileBytes: row?.total_file_bytes || 0,
  };
}
