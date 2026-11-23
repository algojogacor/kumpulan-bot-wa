/**
 * Flash Peak TMS - Bounded Media Download unit tests (audit fix B-1)
 *
 * Regression contract:
 * - A stalled downloadMediaMessage must ABANDON the wait within the configured
 *   timeout (skipReason TIMEOUT) — it may never hang the caller forever.
 * - An attachment larger than the size cap must be rejected BEFORE downloading
 *   (declared fileLength pre-check) and again after (actual buffer length).
 * - Failures never throw; the caller gets { buffer: null, skipReason }.
 *
 * On master these tests cannot pass: the bounded wrapper does not exist and the
 * production call site awaited downloadMediaMessage with no bound at all
 * (src/cli/start.ts `messages.upsert` handler).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const downloadMediaMessageMock = vi.fn();

vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: (...args: unknown[]) => downloadMediaMessageMock(...args),
}));

import {
  downloadMediaWithLimits,
  declaredMediaBytes,
  DEFAULT_MEDIA_MAX_BYTES,
} from '../../src/whatsapp/media-download.js';

const SOCK_STUB = {
  updateMediaMessage: vi.fn(async () => undefined),
};

function imageMessage(fileLength?: number): any {
  return {
    key: { id: 'msg-1' },
    message: {
      imageMessage: fileLength !== undefined ? { fileLength } : { url: 'x' },
    },
  };
}

describe('Bounded media download (B-1)', () => {
  beforeEach(() => {
    downloadMediaMessageMock.mockReset();
    SOCK_STUB.updateMediaMessage.mockClear();
  });

  it('abandons a stalled download within the timeout budget (skipReason TIMEOUT)', async () => {
    // Never settles — the exact failure mode B-1 protects against.
    downloadMediaMessageMock.mockReturnValue(new Promise<Buffer>(() => undefined));

    const startedAt = Date.now();
    const result = await downloadMediaWithLimits(imageMessage(), {
      sock: SOCK_STUB,
      timeoutMs: 60,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.buffer).toBeNull();
    expect(result.skipReason).toBe('TIMEOUT');
    // Bounded: must return promptly, not wait for the stalled promise.
    expect(elapsed).toBeLessThan(2000);
  });

  it('rejects an oversized attachment via the declared fileLength WITHOUT downloading it', async () => {
    downloadMediaMessageMock.mockImplementation(() => {
      throw new Error('downloadMediaMessage must not be called for oversized media');
    });

    const result = await downloadMediaWithLimits(
      imageMessage(DEFAULT_MEDIA_MAX_BYTES + 1),
      { sock: SOCK_STUB }
    );

    expect(result.buffer).toBeNull();
    expect(result.skipReason).toBe('TOO_LARGE');
    expect(result.declaredBytes).toBe(DEFAULT_MEDIA_MAX_BYTES + 1);
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
  });

  it('rejects a downloaded buffer that exceeds the size cap', async () => {
    const oversized = Buffer.alloc(DEFAULT_MEDIA_MAX_BYTES + 1024, 1);
    downloadMediaMessageMock.mockResolvedValue(oversized);

    const result = await downloadMediaWithLimits(imageMessage(), {
      sock: SOCK_STUB,
    });

    expect(result.buffer).toBeNull();
    expect(result.skipReason).toBe('TOO_LARGE');
  });

  it('returns the buffer for a healthy download', async () => {
    const small = Buffer.from('hello-image');
    downloadMediaMessageMock.mockResolvedValue(small);

    const result = await downloadMediaWithLimits(imageMessage(11), {
      sock: SOCK_STUB,
    });

    expect(result.buffer).toBe(small);
    expect(result.skipReason).toBeUndefined();
    expect(result.declaredBytes).toBe(11);
  });

  it('maps a rejected download to DOWNLOAD_FAILED (never throws)', async () => {
    downloadMediaMessageMock.mockRejectedValue(new Error('boom'));

    const result = await downloadMediaWithLimits(imageMessage(), {
      sock: SOCK_STUB,
    });

    expect(result.buffer).toBeNull();
    expect(result.skipReason).toBe('DOWNLOAD_FAILED');
  });

  it('does not surface an unhandled rejection when the abandoned download later fails', async () => {
    let rejectDownload: (err: Error) => void = () => undefined;
    downloadMediaMessageMock.mockReturnValue(
      new Promise<Buffer>((_, reject) => {
        rejectDownload = reject;
      })
    );

    const result = await downloadMediaWithLimits(imageMessage(), {
      sock: SOCK_STUB,
      timeoutMs: 30,
    });
    expect(result.skipReason).toBe('TIMEOUT');

    // The abandoned promise rejects AFTER the race already returned. This must
    // not produce an unhandled rejection crash.
    rejectDownload(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });

  it('reads declared size from ephemeral/viewOnce wrappers too', () => {
    const msg: any = {
      message: {
        ephemeralMessage: {
          message: { imageMessage: { fileLength: 12345 } },
        },
      },
    };
    expect(declaredMediaBytes(msg)).toBe(12345);
    expect(declaredMediaBytes(imageMessage(77))).toBe(77);
    expect(declaredMediaBytes({ message: { imageMessage: {} } })).toBeUndefined();
  });
});
