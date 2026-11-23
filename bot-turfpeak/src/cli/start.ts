/**
 * Flash Peak TMS - CLI Entrypoint for WhatsApp Bot
 * 
 * Boots the application orchestrator, connects to WhatsApp via Baileys,
 * renders QR code in the terminal for linking, and binds message event listeners.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { downloadMediaWithLimits } from '../whatsapp/media-download.js';
import { createClient } from '@libsql/client';
import { WhatsAppConnection } from '../whatsapp/connection.js';
import { WhatsAppSender } from '../whatsapp/sender.js';
import { normalizeWAMessage } from '../whatsapp/normalizer.js';
import { FlashPeakMediaClient } from '../media/client.js';
import { ProviderRouter } from '../ai/router.js';
import { GroqAdapter } from '../ai/providers/groq.js';
import { GeminiAdapter } from '../ai/providers/gemini.js';
import { OllamaAdapter } from '../ai/providers/ollama.js';
import { NvidiaAdapter } from '../ai/providers/nvidia.js';
import { DeepSeekAdapter } from '../ai/providers/deepseek.js';
import { CohereAdapter } from '../ai/providers/cohere.js';
import { MistralAdapter } from '../ai/providers/mistral.js';
import type { ProviderAdapter } from '../ai/adapter.js';
import { createApp } from '../index.js';
import { runMigrations } from '../db/migrate.js';

// --- Load .env file manually without external dotenv dependency ---
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

async function main() {
  console.log('====================================================');
  console.log('       Flash Peak Tournament Management System      ');
  console.log('====================================================');

  // 1. Initialize Database
  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const dbToken = process.env.TURSO_AUTH_TOKEN;
  console.log(`[DB] Connecting to database (${dbUrl.split('?')[0]})...`);
  const db = createClient({
    url: dbUrl,
    authToken: dbToken,
  });

  // Run pending migrations
  try {
    const migrationResult = await runMigrations(db);
    if (migrationResult.applied.length > 0) {
      console.log(`[DB] Applied ${migrationResult.applied.length} migration(s): ${migrationResult.applied.join(', ')}`);
    } else {
      console.log('[DB] Database schema is up to date.');
    }
  } catch (err) {
    console.error('[DB] Database migration failed. Aborting startup to prevent running with an invalid schema:', err instanceof Error ? err.message : err);
    try {
      db.close();
    } catch {}
    throw new Error(`Database migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Initialize Media Client (pointing to Flash Peak Media Service on VM or local)
  const mediaUrl = process.env.FLASHPEAK_MEDIA_API_URL || process.env.MEDIA_SERVICE_URL || 'http://127.0.0.1:4189';
  const mediaSecret = process.env.FLASHPEAK_MEDIA_SECRET || process.env.MEDIA_SERVICE_HMAC_SECRET;
  if (!mediaSecret) {
    throw new Error(
      'Media service authentication secret missing: Please configure FLASHPEAK_MEDIA_SECRET or MEDIA_SERVICE_HMAC_SECRET in your environment.'
    );
  }
  const mediaClient = new FlashPeakMediaClient({
    apiUrl: mediaUrl,
    secret: mediaSecret,
    db,
  });

  // 3. Initialize AI Provider Router
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const ollamaUrl = process.env.OLLAMA_CLOUD_BASE_URL;

  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const cohereKey = process.env.COHERE_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;

  const groqKeys = process.env.GROQ_API_KEYS
    ? process.env.GROQ_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const nvidiaKeys = process.env.NVIDIA_API_KEYS
    ? process.env.NVIDIA_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const deepseekKeys = process.env.DEEPSEEK_API_KEYS
    ? process.env.DEEPSEEK_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const cohereKeys = process.env.COHERE_API_KEYS
    ? process.env.COHERE_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const mistralKeys = process.env.MISTRAL_API_KEYS
    ? process.env.MISTRAL_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;

  const adapters: ProviderAdapter[] = [];
  if (groqKey && groqKey !== 'gsk_placeholder_groq_api_key') {
    adapters.push(
      new GroqAdapter({
        apiKey: groqKey,
        apiKeys: groqKeys,
      })
    );
  }
  if (deepseekKey && !deepseekKey.includes('placeholder')) {
    adapters.push(
      new DeepSeekAdapter({
        apiKey: deepseekKey,
        apiKeys: deepseekKeys,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      })
    );
  }
  if (geminiKey && geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.includes('placeholder')) {
    adapters.push(
      new GeminiAdapter({
        apiKey: geminiKey,
        model: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
      })
    );
  }
  if (nvidiaKey && !nvidiaKey.includes('placeholder')) {
    adapters.push(
      new NvidiaAdapter({
        apiKey: nvidiaKey,
        apiKeys: nvidiaKeys,
        model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
      })
    );
  }
  if (cohereKey && !cohereKey.includes('placeholder')) {
    adapters.push(
      new CohereAdapter({
        apiKey: cohereKey,
        apiKeys: cohereKeys,
        model: process.env.COHERE_MODEL || 'command-a-reasoning-08-2025',
      })
    );
  }
  if (mistralKey && !mistralKey.includes('placeholder')) {
    adapters.push(
      new MistralAdapter({
        apiKey: mistralKey,
        apiKeys: mistralKeys,
        model: process.env.MISTRAL_MODEL || 'codestral-latest',
        // B-3: pixtral-12b-2409 is retired (absent from Mistral's /v1/models, so
        // the API silently serves a different model than configured). Validated
        // replacement by direct test call 2026-11-22: ministral-14b-latest
        // processes real images (prompt_tokens 391 for a 512px JPEG) and is
        // served on the current free-tier key pool. See audit notes in the PR.
        visionModel: process.env.MISTRAL_VISION_MODEL || 'ministral-14b-latest',
      })
    );
  }
  if (ollamaUrl && ollamaUrl !== 'https://ollama.cloud.example.com') {
    adapters.push(new OllamaAdapter({ baseUrl: ollamaUrl, apiKey: process.env.OLLAMA_CLOUD_API_KEY }));
  }

  console.log(
    `[AI] Initialized Multi-Provider Router with ${adapters.length} provider(s): ` +
      adapters.map((a) => a.name).join(', ')
  );

  const providerRouter = new ProviderRouter({
    adapters,
    prioritizeByTask: true,
    onTelemetry: async (t) => {
      const tokenInfo =
        t.input_tokens !== null && t.input_tokens !== undefined
          ? `in=${t.input_tokens}, out=${t.output_tokens ?? 0}`
          : 'tokens: N/A';
      console.log(
        `[LLM] 🤖 ${t.provider} (${t.model}) | Task: ${t.task_type} | ${t.status} (${t.latency_ms}ms) | ${tokenInfo}${t.error_code ? ` | Error: ${t.error_code}` : ''}`
      );
      try {
        await db.execute({
          sql: `INSERT INTO provider_usage (
                  id, provider, model, task_type, request_status,
                  input_units, output_units, latency_ms, error_code, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            t.provider,
            t.model,
            t.task_type,
            t.status,
            t.input_tokens ?? null,
            t.output_tokens ?? null,
            t.latency_ms,
            t.error_code ?? null,
            new Date().toISOString(),
          ],
        });
      } catch (dbErr) {
        // Fire-and-forget telemetry: DB write failures must never crash the bot
        console.error('[AI Telemetry DB Error]', dbErr);
      }
    },
  });

  // 4. Initialize WhatsApp Connection
  const authDir = process.env.WA_AUTH_STATE_DIR || './auth_state';
  console.log(`[WA] Initializing Baileys WhatsApp client (auth dir: ${authDir})...`);

  // FIX2-RBAC-001: organizer identity must be explicitly configured.
  // A missing WA_ORGANIZER_PHONE / WA_ORGANIZER_JID must abort startup instead of
  // silently granting full ORGANIZER rights to a hardcoded example number.
  const organizerPhone = (process.env.WA_ORGANIZER_PHONE || '').replace(/\D/g, '');
  const organizerJid = (process.env.WA_ORGANIZER_JID || '').trim();
  if (!organizerPhone && !organizerJid) {
    try {
      db.close();
    } catch {}
    throw new Error(
      'Organizer identity missing: Please configure WA_ORGANIZER_PHONE or WA_ORGANIZER_JID ' +
        'in your environment. The tournament bot refuses to start without an explicit organizer ' +
        'identity to prevent unintended organizer privileges.'
    );
  }
  console.log(`[WA] Organizer identity configured (phone: ${organizerPhone ? 'set' : 'not set'}, jid: ${organizerJid ? 'set' : 'not set'}).`);

  const waConnection = new WhatsAppConnection({
    authStateDir: authDir,
    printQRInTerminal: false,
    browser: ['FlashPeak TMS', 'Chrome', '1.0.0'],
  });

  // Handle QR code generation for user scanning
  waConnection.on('qr', (qr: string) => {
    console.log('\n====================================================');
    console.log('  SCAN QR CODE INI MENGGUNAKAN WHATSAPP DI HP ANDA  ');
    console.log('  (Menu WhatsApp > Perangkat Tertaut > Tautkan)     ');
    console.log('====================================================\n');
    qrcode.generate(qr, { small: true });
    try {
      writeFileSync(path.join(authDir, 'last_qr.txt'), qr, 'utf8');
    } catch {}
    console.log('\n[WA] Menunggu scan QR code dari aplikasi WhatsApp...');
  });

  // 5. Create Central TMS Application
  const envGroup = process.env.WA_CENTRAL_GROUP_JID?.trim();
  const centralGroupJid = envGroup && !envGroup.startsWith('120363000000000000') ? envGroup : undefined;

  const app = createApp({
    db,
    mediaClient,
    providerRouter,
    organizerPhone: organizerPhone || undefined,
    organizerJid: organizerJid || undefined,
    centralGroupJid,
    // AI resilience (v3): automatic retry budget for AllProvidersFailedError.
    // Defaults mirror the router circuit-breaker cooldown (60s): each retry lands
    // right when the first tripped breaker exits OPEN, so every attempt gets a
    // real chance to find a healthy provider.
    aiMaxRetries: process.env.AI_MAX_RETRIES ? Number(process.env.AI_MAX_RETRIES) : 3,
    aiRetryDelayMs: process.env.AI_RETRY_DELAY_MS ? Number(process.env.AI_RETRY_DELAY_MS) : 60_000,
  });

  // Connect socket
  const sock = await waConnection.connect();
  const sender = new WhatsAppSender(() => waConnection.getSocket() || sock, { minIntervalMs: 1500 });
  app.setSender(sender);

  waConnection.on('connection.update', (update) => {
    if (update.connection === 'open') {
      const currentSock = waConnection.getSocket();
      const userJid = currentSock?.user?.id || sock.user?.id || 'Unknown';
      console.log('\n====================================================');
      console.log(`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!`);
      console.log(`[WA] Akun Bot JID: ${userJid}`);
      console.log(`[WA] Bot siap memproses turnamen.`);
      console.log('====================================================\n');
      app.start();
    }
  });

  // Inbound messages routing attached to waConnection (persists across all socket reconnects!)
  waConnection.on('messages.upsert', async (data: { type: string; messages: any[] }) => {
    try {
      if (data.type !== 'notify') return;
      const currentSock = waConnection.getSocket() || sock;

      for (const msg of data.messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        const normalized = normalizeWAMessage(msg);
        if (!normalized) continue;

        // Ignore broadcast and newsletter messages
        if (
          normalized.chat_id.endsWith('@broadcast') ||
          normalized.chat_id === 'status@broadcast' ||
          normalized.chat_id.endsWith('@newsletter')
        ) {
          continue;
        }

        console.log(
          `[WA] Inbound msg from ${normalized.sender_raw_address} in ${normalized.chat_id}: ${normalized.text_body || normalized.caption || '[media]'}`
        );

        let mediaBuffer: Buffer | null = null;
        const unwrapped = msg.message?.ephemeralMessage?.message ||
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.viewOnceMessageV2Extension?.message ||
          msg.message?.documentWithCaptionMessage?.message ||
          msg.message;

        const isMedia = normalized.message_type === 'IMAGE' ||
          Boolean(unwrapped?.imageMessage || unwrapped?.documentMessage);

        if (isMedia) {
          // B-1: bounded download — a stalled or oversized attachment must never
          // block the inbound message loop (timeout default 20s, cap default 10MB).
          const mediaResult = await downloadMediaWithLimits(msg, {
            sock: currentSock,
            logger: pino({ level: 'silent' }),
            timeoutMs: process.env.WA_MEDIA_DOWNLOAD_TIMEOUT_MS
              ? Number(process.env.WA_MEDIA_DOWNLOAD_TIMEOUT_MS)
              : undefined,
            maxBytes: process.env.WA_MEDIA_MAX_BYTES
              ? Number(process.env.WA_MEDIA_MAX_BYTES)
              : undefined,
          });
          if (mediaResult.buffer) {
            mediaBuffer = mediaResult.buffer;
            console.log(`[WA] Successfully downloaded media: ${mediaBuffer?.length} bytes`);
          } else {
            console.warn(
              `[WA] Media download skipped for message ${msg.key.id} ` +
                `(reason: ${mediaResult.skipReason}` +
                (mediaResult.declaredBytes ? `, declared: ${mediaResult.declaredBytes} bytes` : '') +
                ') — message continues as text-only.'
            );
          }
        }

        // Process message through TMS orchestrator
        const outcome = await app.handleInboundMessage(normalized, mediaBuffer);
        if (outcome.replyText) {
          const mentions = outcome.mentions || (outcome.commandResult?.metadata?.mentions as string[] | undefined);
          await sender.sendQuote(normalized.chat_id, outcome.replyText, msg, { mentions });
        }
      }
    } catch (err) {
      console.error('[WA] Error handling inbound message:', err);
    }
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n[System] Shutting down gracefully...');
    app.stop();
    await waConnection.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
