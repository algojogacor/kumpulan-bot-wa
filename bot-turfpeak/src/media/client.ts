import crypto from 'node:crypto';
import path from 'node:path';
import type { Client } from '@libsql/client';
import type {
  MediaAsset,
  MediaRole,
  MediaVisibility,
} from '../shared/types/index.js';

export interface MediaClientConfig {
  apiUrl: string;
  secret: string;
  db?: Client;
}

export interface UploadMediaOptions {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  mediaRole: MediaRole;
  sourceMessageId: string;
  uploadedByDelegateId?: string | null;
  visibility?: MediaVisibility;
}

export interface RemoteUploadResponse {
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
  created_at: string;
}

function normalizeCanonicalPath(p?: string | null): string {
  if (!p) return '/';
  const clean = p.split('?')[0]!.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export function generateMediaAuthHeaders(
  options: {
    method: string;
    path: string;
    action: string;
    resourceId?: string | null;
    uploadedBy?: string;
    visibility?: string;
    mediaRole?: string;
    ttlMs?: number;
  },
  secret: string
): { 'X-Media-Auth-Signature': string; 'X-Media-Auth-Payload': string } {
  if (!secret) {
    throw new Error('HMAC secret is required to generate authentication headers');
  }

  const now = Date.now();
  const canonicalPath = normalizeCanonicalPath(options.path);
  const payload = {
    method: options.method.toUpperCase(),
    path: canonicalPath,
    action: options.action,
    resourceId: options.resourceId ? String(options.resourceId) : null,
    timestamp: now,
    expiresAt: now + (options.ttlMs || 300_000), // 5 min TTL
    nonce: crypto.randomUUID(),
    uploadedBy: options.uploadedBy || 'system',
    visibility: options.visibility || 'private',
    mediaRole: options.mediaRole || 'MAIN_MATCH',
  };

  const rawPayload = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(rawPayload)
    .digest('hex');

  return {
    'X-Media-Auth-Signature': signature,
    'X-Media-Auth-Payload': rawPayload,
  };
}

export class FlashPeakMediaClient {
  private apiUrl: string;
  private secret: string;
  private db?: Client;

  constructor(config?: Partial<MediaClientConfig>) {
    this.apiUrl = (
      config?.apiUrl ||
      process.env.FLASHPEAK_MEDIA_API_URL ||
      'http://127.0.0.1:4189'
    ).replace(/\/+$/, '');
    this.secret = config?.secret || process.env.FLASHPEAK_MEDIA_SECRET || '';
    this.db = config?.db;
  }

  setDb(db: Client): void {
    this.db = db;
  }

  /**
   * Upload binary media to the Flash Peak media service, verify SHA-256,
   * and persist metadata in the Turso `media_assets` table.
   */
  async uploadMedia(options: UploadMediaOptions): Promise<MediaAsset> {
    if (!this.secret) {
      throw new Error('FLASHPEAK_MEDIA_SECRET is required to upload media');
    }

    // 1. Pre-compute SHA-256 hash locally before upload
    const localHash = crypto
      .createHash('sha256')
      .update(options.buffer)
      .digest('hex');

    const path = '/api/v1/media/upload';
    const authHeaders = generateMediaAuthHeaders(
      {
        method: 'POST',
        path,
        action: 'upload',
        visibility: options.visibility || 'PRIVATE',
        mediaRole: options.mediaRole,
        uploadedBy: options.uploadedByDelegateId || 'system',
      },
      this.secret
    );

    const safeFilename = options.filename.replace(/[\r\n"\\]/g, '_');
    const endpoint = `${this.apiUrl}${path}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': options.mimeType,
        'Content-Length': String(options.buffer.length),
        'X-Media-Role': options.mediaRole,
        'X-Original-Filename': safeFilename,
        ...authHeaders,
      },
      body: new Uint8Array(options.buffer),
    });

    if (!res.ok) {
      const errorText = await res.text();
      let parsedError = errorText;
      try {
        const json = JSON.parse(errorText) as { error?: string };
        if (json.error) parsedError = json.error;
      } catch {
        // Fallback to raw text
      }
      throw new Error(
        `Media service upload failed (HTTP ${res.status}): ${parsedError}`
      );
    }

    const result = (await res.json()) as RemoteUploadResponse;

    // 2. Validate SHA-256 hash after upload (must match local computation)
    if (result.sha256 !== localHash) {
      throw new Error(
        `SHA-256 verification mismatch: local hash '${localHash}' !== remote hash '${result.sha256}'`
      );
    }

    const assetId = result.id || crypto.randomUUID();
    const now = new Date().toISOString();

    const asset: MediaAsset = {
      id: assetId,
      storage_provider: 'FLASHPEAK_VM_MEDIA',
      storage_key: result.storage_key,
      media_role: options.mediaRole,
      mime_type: result.mime_type,
      byte_size: result.byte_size,
      sha256: result.sha256,
      visibility: options.visibility || 'PRIVATE',
      status: 'STORED',
      uploaded_by_delegate_id: options.uploadedByDelegateId ?? null,
      source_message_id: options.sourceMessageId,
      created_at: now,
    };

    // 3. Persist metadata to Turso media_assets table if DB client provided
    if (this.db) {
      await this.db.execute({
        sql: `INSERT INTO media_assets (
          id, storage_provider, storage_key, media_role,
          mime_type, byte_size, sha256, visibility,
          status, uploaded_by_delegate_id, source_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          asset.id,
          asset.storage_provider,
          asset.storage_key,
          asset.media_role,
          asset.mime_type,
          asset.byte_size,
          asset.sha256,
          asset.visibility,
          asset.status,
          asset.uploaded_by_delegate_id,
          asset.source_message_id,
          asset.created_at,
        ],
      });
    }

    return asset;
  }

  /**
   * Retrieve binary media from the media service and verify its SHA-256 hash.
   */
  async downloadMedia(
    remoteId: string,
    expectedSha256?: string
  ): Promise<{ buffer: Buffer; mimeType: string; sha256: string }> {
    const filename = path.basename(remoteId);
    const cleanId = filename.split('.')[0] || filename;
    const downloadPath = `/api/v1/media/${encodeURIComponent(cleanId)}`;
    const authHeaders = generateMediaAuthHeaders(
      {
        method: 'GET',
        path: downloadPath,
        action: 'download',
        resourceId: cleanId,
      },
      this.secret
    );

    const endpoint = `${this.apiUrl}${downloadPath}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        ...authHeaders,
      },
    });

    if (!res.ok) {
      throw new Error(`Media download failed (HTTP ${res.status})`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get('content-type') || 'application/octet-stream';
    const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');

    if (expectedSha256 && computedHash !== expectedSha256) {
      throw new Error(
        `Downloaded media hash mismatch: computed '${computedHash}' !== expected '${expectedSha256}'`
      );
    }

    return {
      buffer,
      mimeType,
      sha256: computedHash,
    };
  }

  /**
   * Retrieve metadata from media service.
   */
  async getMetadata(remoteId: string): Promise<RemoteUploadResponse> {
    const path = `/api/v1/media/${encodeURIComponent(remoteId)}/metadata`;
    const authHeaders = generateMediaAuthHeaders(
      {
        method: 'GET',
        path,
        action: 'metadata',
        resourceId: remoteId,
      },
      this.secret
    );

    const endpoint = `${this.apiUrl}${path}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        ...authHeaders,
      },
    });

    if (!res.ok) {
      throw new Error(`Media metadata lookup failed (HTTP ${res.status})`);
    }

    return (await res.json()) as RemoteUploadResponse;
  }

  /**
   * Quarantine / delete media from storage and mark status in Turso.
   */
  async quarantineMedia(remoteId: string, localAssetId?: string): Promise<void> {
    const path = `/api/v1/media/${encodeURIComponent(remoteId)}`;
    const authHeaders = generateMediaAuthHeaders(
      {
        method: 'DELETE',
        path,
        action: 'delete',
        resourceId: remoteId,
      },
      this.secret
    );

    const endpoint = `${this.apiUrl}${path}`;
    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
      },
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Media quarantine failed (HTTP ${res.status})`);
    }

    if (this.db && localAssetId) {
      await this.db.execute({
        sql: `UPDATE media_assets SET status = 'QUARANTINED' WHERE id = ?`,
        args: [localAssetId],
      });
    }
  }
}
