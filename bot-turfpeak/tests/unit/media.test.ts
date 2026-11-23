import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createMediaServer,
  type FlashPeakMediaServer,
} from '../../services/flashpeak-media/server.js';
import {
  generateAuthHeaders,
} from '../../services/flashpeak-media/security.js';
import { FlashPeakMediaClient } from '../../src/media/client.js';

const VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

const VALID_JPEG_BUFFER = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333431ffc0000b080001000101011100ffda0008010100003f00d2cf20ffd9',
  'hex'
);

describe('Flash Peak Media Service & Client Adapter', () => {
  let tempDir: string;
  let server: FlashPeakMediaServer;
  let serverUrl: string;
  let secret: string;
  let db: Client;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'flashpeak-media-test-'));
    secret = 'test-media-hmac-secret-1234567890';

    server = createMediaServer({
      storageRoot: tempDir,
      hmacSecret: secret,
      port: 0, // dynamic port for tests
    });

    const info = await server.start(0, '127.0.0.1');
    serverUrl = `http://127.0.0.1:${info.port}`;

    // Setup in-memory Turso client
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('Health and Stats Endpoints', () => {
    it('returns healthy status on /health without authentication', async () => {
      const res = await fetch(`${serverUrl}/health`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { status: string; database: string };
      expect(data.status).toBe('ok');
      expect(data.database).toBe('ok');
    });

    it('returns storage and media statistics on /api/v1/media/stats with HMAC auth', async () => {
      const path = '/api/v1/media/stats';
      const authHeaders = generateAuthHeaders(
        { method: 'GET', path, action: 'stats' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'GET',
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; storage: { usedBytes: number }; media: { totalItems: number } };
      expect(data.status).toBe('ok');
      expect(data.media.totalItems).toBe(0);
    });

    it('rejects /api/v1/media/stats without HMAC auth', async () => {
      const res = await fetch(`${serverUrl}/api/v1/media/stats`);
      expect(res.status).toBe(401);
    });
  });

  describe('HMAC Authentication & Nonce Replay Protection', () => {
    it('rejects tampered signature with 403', async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'X-Media-Auth-Signature': 'tampered-signature-00000000000000000000000000000000',
        },
        body: VALID_PNG_BUFFER,
      });

      expect(res.status).toBe(403);
    });

    it('rejects request signed with incorrect secret with 403', async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload' },
        'wrong-secret-signature'
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers,
        body: VALID_PNG_BUFFER,
      });

      expect(res.status).toBe(403);
    });

    it('rejects expired authorization signature with 401', async () => {
      const path = '/api/v1/media/upload';
      const now = Date.now();
      const payload = {
        method: 'POST',
        path,
        action: 'upload',
        resourceId: null,
        timestamp: now - 600_000,
        expiresAt: now - 1000, // expired 1s ago
        nonce: crypto.randomUUID(),
      };
      const rawPayload = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'X-Media-Auth-Signature': signature,
          'X-Media-Auth-Payload': rawPayload,
        },
        body: VALID_PNG_BUFFER,
      });

      expect(res.status).toBe(401);
    });

    it('prevents replay attacks by rejecting already consumed nonce with 401', async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload' },
        secret
      );

      // First request: valid
      const firstRes = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/png',
          'X-Media-Role': 'MAIN_MATCH',
        },
        body: VALID_PNG_BUFFER,
      });
      expect(firstRes.status).toBe(201);

      // Second request reusing exact same auth headers and nonce
      const replayRes = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/png',
          'X-Media-Role': 'MAIN_MATCH',
        },
        body: VALID_PNG_BUFFER,
      });
      expect(replayRes.status).toBe(401);
      const errJson = (await replayRes.json()) as { error: string };
      expect(errJson.error).toContain('replay attack prevented');
    });

    it('rejects HTTP method mismatch with 403', async () => {
      // Signature signed for POST
      const headers = generateAuthHeaders(
        { method: 'POST', path: '/api/v1/media/upload', action: 'upload' },
        secret
      );

      // Send GET instead
      const res = await fetch(`${serverUrl}/api/v1/media/upload`, {
        method: 'GET',
        headers,
      });

      expect(res.status).toBe(403);
    });
  });

  describe('File Upload, Sniffing & Storage Structure', () => {
    it('successfully uploads valid PNG and stores in private/match_evidence/', async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload', mediaRole: 'MAIN_MATCH' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/png',
          'X-Media-Role': 'MAIN_MATCH',
          'X-Original-Filename': 'match_result.png',
        },
        body: VALID_PNG_BUFFER,
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        id: string;
        storage_key: string;
        mime_type: string;
        byte_size: number;
        sha256: string;
        media_role: string;
        status: string;
      };

      expect(data.id).toBeDefined();
      expect(data.storage_key).toMatch(/^private\/match_evidence\/[a-f0-9-]+\.png$/);
      expect(data.mime_type).toBe('image/png');
      expect(data.byte_size).toBe(VALID_PNG_BUFFER.length);
      expect(data.media_role).toBe('MAIN_MATCH');
      expect(data.status).toBe('stored');

      // Verify SHA-256 matches actual buffer
      const expectedSha256 = crypto.createHash('sha256').update(VALID_PNG_BUFFER).digest('hex');
      expect(data.sha256).toBe(expectedSha256);

      // Verify file exists on disk inside storage tree
      const fullDiskPath = nodePath.join(tempDir, data.storage_key);
      expect(fs.existsSync(fullDiskPath)).toBe(true);
      expect(fs.readFileSync(fullDiskPath)).toEqual(VALID_PNG_BUFFER);
    });

    it('stores GOALKEEPER_DETAIL in private/goalkeeper_detail/', async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload', mediaRole: 'GOALKEEPER_DETAIL' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/jpeg',
          'X-Media-Role': 'GOALKEEPER_DETAIL',
          'X-Original-Filename': 'gk_detail.jpg',
        },
        body: VALID_JPEG_BUFFER,
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { storage_key: string; media_role: string };
      expect(data.storage_key).toMatch(/^private\/goalkeeper_detail\/[a-f0-9-]+\.jpg$/);
      expect(data.media_role).toBe('GOALKEEPER_DETAIL');
    });

    it('rejects spoofed image (text file with image/jpeg header) via MIME sniffing', async () => {
      const path = '/api/v1/media/upload';
      const fakeImageBuffer = Buffer.from('Hello world! I am a plain text file pretending to be JPEG');
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/jpeg',
        },
        body: fakeImageBuffer,
      });

      expect(res.status).toBe(415);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects disallowed format (SVG/XML file)', async () => {
      const path = '/api/v1/media/upload';
      const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers,
        body: svgBuffer,
      });

      expect(res.status).toBe(415); // Disallowed non-image or unsupported
    });

    it('enforces maximum file size limit', async () => {
      // Create server with 1KB limit
      const smallServer = createMediaServer({
        storageRoot: tempDir,
        hmacSecret: secret,
        maxFileSize: 1024, // 1KB
        port: 0,
      });
      const smallInfo = await smallServer.start(0, '127.0.0.1');
      const smallUrl = `http://127.0.0.1:${smallInfo.port}`;

      try {
        const largeBuffer = Buffer.alloc(2048, 0xff); // 2KB
        const path = '/api/v1/media/upload';
        const headers = generateAuthHeaders({ method: 'POST', path, action: 'upload' }, secret);

        const res = await fetch(`${smallUrl}${path}`, {
          method: 'POST',
          headers,
          body: largeBuffer,
        });

        expect(res.status).toBe(413);
        const data = (await res.json()) as { code: string };
        expect(data.code).toBe('FILE_TOO_LARGE');
      } finally {
        await smallServer.stop();
      }
    });
  });

  describe('Download, Metadata and Quarantine', () => {
    let uploadedMediaId: string;

    beforeEach(async () => {
      const path = '/api/v1/media/upload';
      const headers = generateAuthHeaders(
        { method: 'POST', path, action: 'upload', mediaRole: 'MAIN_MATCH' },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/png',
          'X-Media-Role': 'MAIN_MATCH',
        },
        body: VALID_PNG_BUFFER,
      });

      const data = (await res.json()) as { id: string };
      uploadedMediaId = data.id;
    });

    it('downloads media binary with valid HMAC download scope', async () => {
      const path = `/api/v1/media/${uploadedMediaId}`;
      const headers = generateAuthHeaders(
        { method: 'GET', path, action: 'download', resourceId: uploadedMediaId },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'GET',
        headers,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const arrayBuffer = await res.arrayBuffer();
      const downloadedBuffer = Buffer.from(arrayBuffer);
      expect(downloadedBuffer).toEqual(VALID_PNG_BUFFER);
    });

    it('retrieves media metadata via /api/v1/media/:id/metadata', async () => {
      const path = `/api/v1/media/${uploadedMediaId}/metadata`;
      const headers = generateAuthHeaders(
        { method: 'GET', path, action: 'metadata', resourceId: uploadedMediaId },
        secret
      );

      const res = await fetch(`${serverUrl}${path}`, {
        method: 'GET',
        headers,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string; status: string; sha256: string };
      expect(data.id).toBe(uploadedMediaId);
      expect(data.status).toBe('stored');
      expect(data.sha256).toBeDefined();
    });

    it('quarantines media upon DELETE and rejects subsequent download requests with 404', async () => {
      const deletePath = `/api/v1/media/${uploadedMediaId}`;
      const deleteHeaders = generateAuthHeaders(
        { method: 'DELETE', path: deletePath, action: 'delete', resourceId: uploadedMediaId },
        secret
      );

      const delRes = await fetch(`${serverUrl}${deletePath}`, {
        method: 'DELETE',
        headers: deleteHeaders,
      });

      expect(delRes.status).toBe(200);
      const delData = (await delRes.json()) as { success: boolean; status: string };
      expect(delData.success).toBe(true);
      expect(delData.status).toBe('quarantined');

      // Subsequent download should return 404
      const downloadHeaders = generateAuthHeaders(
        { method: 'GET', path: deletePath, action: 'download', resourceId: uploadedMediaId },
        secret
      );
      const downRes = await fetch(`${serverUrl}${deletePath}`, {
        method: 'GET',
        headers: downloadHeaders,
      });
      expect(downRes.status).toBe(404);

      // Verify file moved to quarantine directory
      const quarantineDir = nodePath.join(tempDir, 'quarantine');
      const quarantinedFiles = fs.readdirSync(quarantineDir);
      expect(quarantinedFiles.length).toBeGreaterThan(0);
    });
  });

  describe('FlashPeakMediaClient Adapter Integration with Turso', () => {
    let client: FlashPeakMediaClient;

    beforeEach(async () => {
      client = new FlashPeakMediaClient({
        apiUrl: serverUrl,
        secret,
        db,
      });

      // Insert prerequisites for foreign key constraints: tournament, team, delegate, inbound message
      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
              VALUES ('tourney-1', 'Test Tournament', 'ACTIVE', '1.0', '{}', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')`,
        args: [],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES ('team-1', 'tourney-1', 'Team Alpha', 'VERIFIED', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')`,
        args: [],
      });
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES ('delegate-1', 'Captain Alpha', 'ACTIVE', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')`,
        args: [],
      });
      await db.execute({
        sql: `INSERT INTO inbound_messages (
          id, provider_message_key, chat_id, sender_raw_address,
          message_timestamp, received_at, message_type, raw_metadata_json, created_at
        ) VALUES (
          'msg-1', 'key-test-1', 'group-1@g.us', 'sender-1@s.whatsapp.net',
          '2026-11-18T08:00:00Z', '2026-11-18T08:00:00Z', 'IMAGE', '{}', '2026-11-18T08:00:00Z'
        )`,
        args: [],
      });
    });

    it('uploads media, verifies SHA-256 before & after, and stores in Turso media_assets', async () => {
      const asset = await client.uploadMedia({
        buffer: VALID_PNG_BUFFER,
        filename: 'match_score.png',
        mimeType: 'image/png',
        mediaRole: 'MAIN_MATCH',
        sourceMessageId: 'msg-1',
        uploadedByDelegateId: 'delegate-1',
      });

      expect(asset.id).toBeDefined();
      expect(asset.storage_provider).toBe('FLASHPEAK_VM_MEDIA');
      expect(asset.media_role).toBe('MAIN_MATCH');
      expect(asset.mime_type).toBe('image/png');
      expect(asset.status).toBe('STORED');

      // Verify row exists in Turso database
      const rows = await db.execute({
        sql: 'SELECT * FROM media_assets WHERE id = ?',
        args: [asset.id],
      });
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0] as unknown as Record<string, unknown>;
      expect(row.storage_key).toBe(asset.storage_key);
      expect(row.sha256).toBe(asset.sha256);
      expect(row.uploaded_by_delegate_id).toBe('delegate-1');
    });

    it('downloads media and verifies hash integrity', async () => {
      const asset = await client.uploadMedia({
        buffer: VALID_JPEG_BUFFER,
        filename: 'gk_evidence.jpg',
        mimeType: 'image/jpeg',
        mediaRole: 'GOALKEEPER_DETAIL',
        sourceMessageId: 'msg-1',
      });

      // Extract remote ID from storage key or metadata
      const filename = nodePath.basename(asset.storage_key);
      const remoteId = filename.split('.')[0]!;

      const downloaded = await client.downloadMedia(remoteId, asset.sha256);
      expect(downloaded.buffer).toEqual(VALID_JPEG_BUFFER);
      expect(downloaded.sha256).toBe(asset.sha256);
    });

    it('quarantines media and updates status in Turso', async () => {
      const asset = await client.uploadMedia({
        buffer: VALID_PNG_BUFFER,
        filename: 'disputed.png',
        mimeType: 'image/png',
        mediaRole: 'MANUAL_REVIEW',
        sourceMessageId: 'msg-1',
      });

      const filename = nodePath.basename(asset.storage_key);
      const remoteId = filename.split('.')[0]!;

      await client.quarantineMedia(remoteId, asset.id);

      // Verify status in Turso
      const rows = await db.execute({
        sql: 'SELECT status FROM media_assets WHERE id = ?',
        args: [asset.id],
      });
      expect(rows.rows[0]?.[0]).toBe('QUARANTINED');
    });
  });
});
