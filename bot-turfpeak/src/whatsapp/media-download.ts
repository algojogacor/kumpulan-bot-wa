/**
 * Flash Peak TMS - Bounded WhatsApp Media Download (audit fix B-1)
 *
 * Wraps Baileys `downloadMediaMessage` with a hard timeout and a size cap so a
 * stalled or oversized attachment can never block the inbound message loop
 * forever (finding B-1: the raw await in the `messages.upsert` handler had no
 * bound at all, so one hanging download froze the whole bot).
 *
 * Rules:
 * - Timeout (default 20s, env WA_MEDIA_DOWNLOAD_TIMEOUT_MS): a download that
 *   has not settled within the budget is abandoned (skipReason TIMEOUT).
 * - Size cap (default 10MB, env WA_MEDIA_MAX_BYTES): enforced twice — on the
 *   message's declared fileLength BEFORE downloading a single byte, and again
 *   on the actual buffer length after the download (skipReason TOO_LARGE).
 * - Never throws: callers receive { buffer: null, skipReason } and decide how
 *   to surface it. The message is still processed as text-only downstream.
 */

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

export const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000;
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type MediaDownloadSkipReason =
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'DOWNLOAD_FAILED';

export interface MediaDownloadResult {
  buffer: Buffer | null;
  skipReason?: MediaDownloadSkipReason;
  /** Declared size from the message metadata, when available (bytes). */
  declaredBytes?: number;
}

export interface MediaDownloadOptions {
  /** Socket used for media re-upload requests after WhatsApp media expiry. */
  sock: { updateMediaMessage: (message: any) => Promise<any> };
  logger?: Logger;
  timeoutMs?: number;
  maxBytes?: number;
}

class MediaDownloadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`media download timed out after ${timeoutMs}ms`);
    this.name = 'MediaDownloadTimeoutError';
  }
}

function unwrapEphemeral(msg: any): any {
  return (
    msg?.message?.ephemeralMessage?.message ||
    msg?.message?.viewOnceMessage?.message ||
    msg?.message?.viewOnceMessageV2?.message ||
    msg?.message?.viewOnceMessageV2Extension?.message ||
    msg?.message?.documentWithCaptionMessage?.message ||
    msg?.message
  );
}

/** Best-effort declared byte size from Baileys media metadata (fileLength). */
export function declaredMediaBytes(msg: any): number | undefined {
  const unwrapped = unwrapEphemeral(msg);
  const candidates = [
    unwrapped?.imageMessage?.fileLength,
    unwrapped?.documentMessage?.fileLength,
    unwrapped?.videoMessage?.fileLength,
    unwrapped?.audioMessage?.fileLength,
    unwrapped?.stickerMessage?.fileLength,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export async function downloadMediaWithLimits(
  msg: any,
  options: MediaDownloadOptions
): Promise<MediaDownloadResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const declared = declaredMediaBytes(msg);

  // Pre-check the declared size so an oversized attachment is rejected without
  // transferring it at all.
  if (declared !== undefined && declared > maxBytes) {
    return { buffer: null, skipReason: 'TOO_LARGE', declaredBytes: declared };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Baileys' reuploadRequest/logger typings are stricter than this wrapper's
    // public contract (callers pass a plain socket + optional pino logger), so
    // the options bag is deliberately loosened here.
    const baileysOptions = {
      logger: options.logger,
      reuploadRequest: (reuploadMsg: any) => options.sock.updateMediaMessage(reuploadMsg),
    } as any;
    const download = downloadMediaMessage(msg, 'buffer', {}, baileysOptions);
    // The losing promise must never surface as a late unhandled rejection.
    void download.catch(() => undefined);

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MediaDownloadTimeoutError(timeoutMs)), timeoutMs);
    });

    const buffer = (await Promise.race([download, timeout])) as Buffer;

    if (!buffer || buffer.length === 0) {
      return { buffer: null, skipReason: 'DOWNLOAD_FAILED', declaredBytes: declared };
    }
    if (buffer.length > maxBytes) {
      return { buffer: null, skipReason: 'TOO_LARGE', declaredBytes: declared };
    }
    return { buffer, declaredBytes: declared };
  } catch (err) {
    const isTimeout = err instanceof MediaDownloadTimeoutError;
    return {
      buffer: null,
      skipReason: isTimeout ? 'TIMEOUT' : 'DOWNLOAD_FAILED',
      declaredBytes: declared,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
