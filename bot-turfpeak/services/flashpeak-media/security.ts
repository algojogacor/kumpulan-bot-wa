import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { consumeNonce } from './db.js';

export function normalizeCanonicalPath(p?: string | null): string {
  if (!p) return '/';
  const clean = p.split('?')[0]!.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export interface AuthPayload {
  method: string;
  path: string;
  action: string;
  resourceId?: string | null;
  timestamp: number;
  expiresAt: number;
  nonce: string;
  uploadedBy?: string;
  visibility?: string;
  mediaRole?: string;
}

export interface VerifyAuthResult {
  authorized: boolean;
  statusCode?: number;
  error?: string;
  payload?: AuthPayload;
}

export function verifyHmacAuth(
  req: IncomingMessage,
  expectedScope: {
    method?: string;
    path?: string;
    action?: string;
    resourceId?: string | null;
  },
  secret: string,
  db: DatabaseSync
): VerifyAuthResult {
  if (!secret) {
    return {
      authorized: false,
      statusCode: 500,
      error: 'Media service HMAC secret is not configured',
    };
  }

  const signature = req.headers['x-media-auth-signature'];
  const rawPayload = req.headers['x-media-auth-payload'];

  if (!signature || !rawPayload || typeof signature !== 'string' || typeof rawPayload !== 'string') {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Missing required authentication headers (X-Media-Auth-Signature, X-Media-Auth-Payload)',
    };
  }

  let payload: AuthPayload;
  try {
    payload = JSON.parse(rawPayload) as AuthPayload;
  } catch {
    return {
      authorized: false,
      statusCode: 400,
      error: 'Invalid authentication payload JSON',
    };
  }

  const { method, path: signedPath, action, timestamp, expiresAt, nonce } = payload;
  if (!method || !signedPath || !action || !timestamp || !expiresAt || !nonce) {
    return {
      authorized: false,
      statusCode: 400,
      error: 'Authentication payload missing required scope fields (method, path, action, timestamp, expiresAt, nonce)',
    };
  }

  const now = Date.now();
  if (now > expiresAt) {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Authorization signature has expired',
    };
  }

  // Allow max 5 minutes backward clock drift, max 1 minute future drift
  if (timestamp > now + 60_000 || timestamp < now - 300_000) {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Authorization timestamp out of valid window',
    };
  }

  // Verify HMAC signature in constant time
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(rawPayload)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedHmac, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return {
      authorized: false,
      statusCode: 403,
      error: 'Invalid authentication signature',
    };
  }

  // 1. Method verification
  const reqMethod = (req.method || 'GET').toUpperCase();
  const signedMethod = method.toUpperCase();
  if (reqMethod !== signedMethod) {
    return {
      authorized: false,
      statusCode: 403,
      error: `HTTP method mismatch: signature bound to ${signedMethod}, actual request is ${reqMethod}`,
    };
  }
  if (expectedScope.method && expectedScope.method.toUpperCase() !== signedMethod) {
    return {
      authorized: false,
      statusCode: 403,
      error: `HTTP method not authorized: expected ${expectedScope.method.toUpperCase()}`,
    };
  }

  // 2. Action verification
  if (expectedScope.action && expectedScope.action !== action) {
    return {
      authorized: false,
      statusCode: 403,
      error: `Action mismatch: signature bound to '${action}', expected '${expectedScope.action}'`,
    };
  }

  // 3. Canonical path verification
  const reqPath = normalizeCanonicalPath(req.url);
  const normSignedPath = normalizeCanonicalPath(signedPath);
  if (reqPath !== normSignedPath) {
    return {
      authorized: false,
      statusCode: 403,
      error: `Request path mismatch: signature bound to '${normSignedPath}', actual request is '${reqPath}'`,
    };
  }
  if (expectedScope.path) {
    const normExpectedPath = normalizeCanonicalPath(expectedScope.path);
    if (normSignedPath !== normExpectedPath) {
      return {
        authorized: false,
        statusCode: 403,
        error: `Scope path mismatch: expected '${normExpectedPath}', signature has '${normSignedPath}'`,
      };
    }
  }

  // 4. Resource ID verification (if expected)
  if (expectedScope.resourceId !== undefined && expectedScope.resourceId !== null) {
    const signedResourceId = payload.resourceId ? String(payload.resourceId) : '';
    const expectedResourceId = String(expectedScope.resourceId);
    if (signedResourceId !== expectedResourceId) {
      return {
        authorized: false,
        statusCode: 403,
        error: `Resource ID mismatch: signature bound to media '${signedResourceId || 'none'}', expected '${expectedResourceId}'`,
      };
    }
  }

  // 5. One-time Nonce consumption (Replay protection)
  const consumed = consumeNonce(db, nonce, action, expiresAt);
  if (!consumed) {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Authentication nonce has already been consumed (replay attack prevented)',
    };
  }

  return {
    authorized: true,
    payload,
  };
}

export function generateAuthHeaders(
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
  const payload: AuthPayload = {
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
