import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { getDefaultConfig, type MediaServerConfig } from './config.js';
import {
  initStorageTree,
  getSafeFilePath,
  getStorageStats,
  checkQuotaAvailable,
  moveToQuarantine,
  cleanupStaleTempFiles,
} from './storage.js';
import {
  initMediaDb,
  insertMediaRecord,
  getMediaRecordById,
  updateMediaStatus,
  getMediaStats,
  cleanupExpiredNonces,
  type MediaDbRecord,
} from './db.js';
import { verifyHmacAuth, normalizeCanonicalPath } from './security.js';
import { detectMagicMime, isDisallowedFormat, extractDimensions } from './detector.js';

export interface FlashPeakMediaServer {
  server: http.Server;
  config: MediaServerConfig;
  db: DatabaseSync;
  start: (port?: number, host?: string) => Promise<{ port: number; host: string }>;
  stop: () => Promise<void>;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  code = 'ERROR'
): void {
  sendJson(res, statusCode, { error: message, code });
}

export function createMediaServer(
  customConfig?: Partial<MediaServerConfig>
): FlashPeakMediaServer {
  const config = getDefaultConfig(customConfig);

  initStorageTree(config.storageRoot);
  const db = initMediaDb(config.storageRoot);

  // Periodic cleanup (every 15 min, unref'd so it does not block process exit)
  const cleanupTimer = setInterval(() => {
    try {
      cleanupStaleTempFiles(config.storageRoot);
      cleanupExpiredNonces(db);
    } catch {
      // Ignore background sweep errors
    }
  }, 15 * 60 * 1000);
  cleanupTimer.unref();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url || '/';
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = normalizeCanonicalPath(parsedUrl.pathname);
    const method = (req.method || 'GET').toUpperCase();

    try {
      // 1. Health check (unauthenticated public health check)
      if ((method === 'GET' || method === 'HEAD') && pathname === '/health') {
        let dbOk = false;
        try {
          const row = db.prepare('SELECT 1 AS alive').get() as { alive?: number };
          dbOk = row?.alive === 1;
        } catch {
          dbOk = false;
        }

        sendJson(res, dbOk ? 200 : 503, {
          status: dbOk ? 'ok' : 'degraded',
          service: 'flashpeak-media',
          database: dbOk ? 'ok' : 'unavailable',
          storage: 'ok',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 2. Authenticated storage and media stats
      if (method === 'GET' && pathname === '/api/v1/media/stats') {
        const auth = verifyHmacAuth(
          req,
          { method: 'GET', path: '/api/v1/media/stats', action: 'stats' },
          config.hmacSecret,
          db
        );
        if (!auth.authorized) {
          sendError(res, auth.statusCode || 401, auth.error || 'Unauthorized', 'UNAUTHORIZED');
          return;
        }

        const storageStats = getStorageStats(config.storageRoot, config.quotaBytes);
        const mediaStats = getMediaStats(db);

        sendJson(res, 200, {
          status: 'ok',
          storage: storageStats,
          media: mediaStats,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 3. Upload media (Streaming upload with hash & magic byte verification)
      if (method === 'POST' && pathname === '/api/v1/media/upload') {
        const auth = verifyHmacAuth(
          req,
          { method: 'POST', path: '/api/v1/media/upload', action: 'upload' },
          config.hmacSecret,
          db
        );
        if (!auth.authorized) {
          sendError(res, auth.statusCode || 401, auth.error || 'Unauthorized', 'UNAUTHORIZED');
          return;
        }

        const payload = auth.payload!;
        const mediaRole =
          (req.headers['x-media-role'] as string) || payload.mediaRole || 'MAIN_MATCH';
        const visibility = payload.visibility || 'private';
        const uploadedBy = payload.uploadedBy || 'system';
        const originalFilename =
          (req.headers['x-original-filename'] as string) || 'evidence.jpg';

        // Check storage quota
        try {
          checkQuotaAvailable(config.storageRoot, config.quotaBytes, 1024);
        } catch (err) {
          const typedErr = err as unknown as { statusCode?: number; message: string; code?: string };
          sendError(
            res,
            typedErr.statusCode || 507,
            typedErr.message,
            typedErr.code || 'INSUFFICIENT_STORAGE'
          );
          return;
        }

        const tempId = crypto.randomUUID();
        const tmpDir = path.join(config.storageRoot, 'tmp');
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        }
        const tempFilePath = path.join(tmpDir, `upload_${tempId}.tmp`);
        const writeStream = fs.createWriteStream(tempFilePath);

        const hash = crypto.createHash('sha256');
        let totalBytes = 0;
        const headChunks: Buffer[] = [];
        let headBytes = 0;
        let isAborted = false;

        const cleanupTemp = () => {
          if (fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch {
              // Ignore cleanup error
            }
          }
        };

        req.on('data', (chunk: Buffer) => {
          if (isAborted) return;
          totalBytes += chunk.length;

          if (totalBytes > config.maxFileSize) {
            isAborted = true;
            req.resume(); // drain stream
            writeStream.destroy();
            cleanupTemp();
            sendError(
              res,
              413,
              `File size exceeds limit of ${config.maxFileSize / 1024 / 1024}MB`,
              'FILE_TOO_LARGE'
            );
            return;
          }

          hash.update(chunk);
          if (headBytes < 4096) {
            headChunks.push(chunk);
            headBytes += chunk.length;
          }
          writeStream.write(chunk);
        });

        req.on('error', (err) => {
          if (isAborted) return;
          isAborted = true;
          writeStream.destroy();
          cleanupTemp();
          sendError(res, 500, `Upload stream error: ${err.message}`, 'STREAM_ERROR');
        });

        req.on('end', () => {
          if (isAborted) return;
          writeStream.end(async () => {
            const headBuffer = Buffer.concat(headChunks);

            // 1. Sniff MIME magic bytes
            const detected = detectMagicMime(headBuffer);
            if (!detected || !config.allowedMimes.includes(detected.mime)) {
              cleanupTemp();
              sendError(
                res,
                415,
                `Unsupported media type: detected '${detected?.mime || 'unknown'}'`,
                'UNSUPPORTED_MEDIA_TYPE'
              );
              return;
            }

            // 2. Disallowed format verification
            const formatCheck = isDisallowedFormat(headBuffer);
            if (formatCheck.rejected) {
              cleanupTemp();
              sendError(
                res,
                400,
                formatCheck.reason || 'File rejected by security policy',
                'DISALLOWED_FORMAT'
              );
              return;
            }

            // 3. Extract dimensions
            const dims = extractDimensions(headBuffer, detected.mime);
            const sha256 = hash.digest('hex');
            const mediaId = crypto.randomUUID();
            const storedFilename = `${mediaId}.${detected.ext}`;

            try {
              const safePath = getSafeFilePath(
                config.storageRoot,
                mediaRole,
                storedFilename
              );

              // Move temp to durable target destination
              fs.renameSync(tempFilePath, safePath.absolutePath);

              const now = new Date().toISOString();
              const record: MediaDbRecord = {
                id: mediaId,
                storage_key: safePath.relativePath,
                relative_path: safePath.relativePath,
                original_filename: path.basename(originalFilename),
                mime_type: detected.mime,
                byte_size: totalBytes,
                sha256,
                media_role: mediaRole,
                visibility,
                status: 'stored',
                width: dims.width,
                height: dims.height,
                uploaded_by: uploadedBy,
                created_at: now,
                updated_at: now,
              };

              insertMediaRecord(db, record);

              sendJson(res, 201, {
                id: record.id,
                storage_key: record.storage_key,
                relative_path: record.relative_path,
                original_filename: record.original_filename,
                mime_type: record.mime_type,
                byte_size: record.byte_size,
                sha256: record.sha256,
                media_role: record.media_role,
                visibility: record.visibility,
                status: record.status,
                width: record.width,
                height: record.height,
                created_at: record.created_at,
              });
            } catch (moveErr) {
              cleanupTemp();
              sendError(
                res,
                500,
                `Failed to persist media: ${(moveErr as Error).message}`,
                'STORAGE_WRITE_ERROR'
              );
            }
          });
        });
        return;
      }

      // 4. Download / stream media
      const downloadMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)$/);
      if (downloadMatch && method === 'GET') {
        const id = downloadMatch[1]!;
        const auth = verifyHmacAuth(
          req,
          { method: 'GET', path: `/api/v1/media/${id}`, action: 'download', resourceId: id },
          config.hmacSecret,
          db
        );
        if (!auth.authorized) {
          sendError(res, auth.statusCode || 401, auth.error || 'Unauthorized', 'UNAUTHORIZED');
          return;
        }

        const record = getMediaRecordById(db, id);
        if (!record || record.status !== 'stored') {
          sendError(res, 404, 'Media asset not found', 'NOT_FOUND');
          return;
        }

        const filePath = path.join(config.storageRoot, record.relative_path);
        if (!fs.existsSync(filePath)) {
          sendError(res, 404, 'Media file missing on disk', 'FILE_MISSING');
          return;
        }

        res.writeHead(200, {
          'Content-Type': record.mime_type,
          'Content-Length': record.byte_size,
          ETag: `"${record.sha256}"`,
          'Cache-Control': 'private, no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // 5. Get metadata
      const metadataMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/metadata$/);
      if (metadataMatch && method === 'GET') {
        const id = metadataMatch[1]!;
        const auth = verifyHmacAuth(
          req,
          {
            method: 'GET',
            path: `/api/v1/media/${id}/metadata`,
            action: 'metadata',
            resourceId: id,
          },
          config.hmacSecret,
          db
        );
        if (!auth.authorized) {
          sendError(res, auth.statusCode || 401, auth.error || 'Unauthorized', 'UNAUTHORIZED');
          return;
        }

        const record = getMediaRecordById(db, id);
        if (!record) {
          sendError(res, 404, 'Media asset not found', 'NOT_FOUND');
          return;
        }

        sendJson(res, 200, record);
        return;
      }

      // 6. Delete / Quarantine media
      if (downloadMatch && method === 'DELETE') {
        const id = downloadMatch[1]!;
        const auth = verifyHmacAuth(
          req,
          {
            method: 'DELETE',
            path: `/api/v1/media/${id}`,
            action: 'delete',
            resourceId: id,
          },
          config.hmacSecret,
          db
        );
        if (!auth.authorized) {
          sendError(res, auth.statusCode || 401, auth.error || 'Unauthorized', 'UNAUTHORIZED');
          return;
        }

        const record = getMediaRecordById(db, id);
        if (!record) {
          sendError(res, 404, 'Media asset not found', 'NOT_FOUND');
          return;
        }

        const filePath = path.join(config.storageRoot, record.relative_path);
        moveToQuarantine(config.storageRoot, filePath, record.relative_path);
        updateMediaStatus(db, id, 'quarantined');

        sendJson(res, 200, {
          success: true,
          id,
          status: 'quarantined',
        });
        return;
      }

      // Route not found
      sendError(res, 404, `Endpoint ${method} ${pathname} not found`, 'NOT_FOUND');
    } catch (err) {
      sendError(
        res,
        500,
        `Internal server error: ${(err as Error).message}`,
        'INTERNAL_ERROR'
      );
    }
  });

  return {
    server,
    config,
    db,
    start(port = config.port, host = config.host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          config.port = actualPort;
          resolve({ port: actualPort, host });
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        clearInterval(cleanupTimer);
        try {
          db.close();
        } catch {
          // Ignore close error if already closed
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
