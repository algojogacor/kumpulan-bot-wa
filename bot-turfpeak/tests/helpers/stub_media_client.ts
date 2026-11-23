/**
 * Flash Peak TMS - Test helper: stub FlashPeakMediaClient (B-2 regression support)
 *
 * The evidence pipeline now requires REAL bytes from mediaClient.downloadMedia
 * (the MOCK_BASE64_DATA placeholder was removed). Tests that exercise the
 * evidence pipeline inject this stub so the download path is exercised with
 * deterministic bytes instead of placeholder data.
 */

import { vi } from 'vitest';
import { FlashPeakMediaClient } from '../../src/media/client.js';

export const STUB_IMAGE_BYTES = Buffer.from('stub-jpeg-evidence-bytes');

export interface StubMediaClientOptions {
  /** Reject every download (simulates media service outage). */
  failAllDownloads?: boolean;
  /** Custom behavior keyed by remote id; return false to reject. */
  allowRemoteId?: (remoteId: string) => boolean;
}

export function createStubMediaClient(
  options: StubMediaClientOptions = {}
): FlashPeakMediaClient {
  const client = new FlashPeakMediaClient({
    apiUrl: 'http://stub.invalid',
    secret: 'test-media-secret',
  });

  const spy = vi.spyOn(client, 'downloadMedia').mockImplementation(
    async (remoteId: string) => {
      if (options.failAllDownloads) {
        throw new Error(`stub: media service download failed for ${remoteId}`);
      }
      if (options.allowRemoteId && !options.allowRemoteId(remoteId)) {
        throw new Error(`stub: media service download failed for ${remoteId}`);
      }
      return {
        buffer: STUB_IMAGE_BYTES,
        mimeType: 'image/jpeg',
        sha256: 'stub-sha256',
      };
    }
  );

  void spy;
  return client;
}
