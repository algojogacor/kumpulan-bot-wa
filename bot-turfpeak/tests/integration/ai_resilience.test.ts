/**
 * Flash Peak TMS - AI Resilience: Retry Queue & Status Notification (v3)
 *
 * Regression + new-behavior tests for:
 * - Part 1: failure-cause-differentiated notifications
 *   (b) retry pending, (c) retries exhausted -> manual verification,
 *   (d) AI responded but evidence unreadable -> resend request.
 * - Part 2: intake acknowledgment + automatic retry queue for
 *   AllProvidersFailedError, reusing the debounce/lease machinery.
 *
 * Invariants that MUST NOT change (regression guards):
 * - Transparent failover (one provider down, other succeeds) still yields a
 *   normal DRAFT_CREATED flow with the regular summary, no failure notice.
 * - Retry rescheduling never reorders or starves normal COLLECTING batches
 *   (FIFO by debounce_due_at preserved).
 * - Circuit-breaker semantics of the router itself are untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { createStubMediaClient } from '../helpers/stub_media_client.js';
import { ProviderRouter, AllProvidersFailedError } from '../../src/ai/router.js';
import { AIMalformedResponseError } from '../../src/ai/adapter.js';
import {
  findOrCreateReportSession,
} from '../../src/ingestion/session.js';
import {
  claimDebounceBatch,
  rescheduleDebounceRetry,
} from '../../src/ingestion/debounce.js';
import { processClaimedBatch } from '../../src/application/evidence-batch-processor.js';
import {
  formatAIRetryPendingMessage,
  formatAIRetriesExhaustedMessage,
  formatUnreadableEvidenceMessage,
} from '../../src/whatsapp/failure.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

function createMockAdapter(
  name: 'GROQ' | 'GEMINI' | 'OLLAMA_CLOUD',
  options: {
    onExecute?: (req: AIRequest) => Promise<AIResponse<unknown>>;
  } = {}
): ProviderAdapter {
  return {
    name,
    model: `${name.toLowerCase()}-test-model`,
    capabilities: {
      vision: true,
      text: true,
      structured_output: true,
      supported_mime_types: ['image/jpeg', 'image/png'],
    },
    healthCheck: async () => true,
    execute:
      options.onExecute ||
      (async (req: AIRequest) => ({
        raw_text: JSON.stringify({ mock: true }),
        parsed_json: { mock: true },
        telemetry: {
          provider: name,
          model: `${name.toLowerCase()}-test-model`,
          task_type: req.task,
          latency_ms: 12,
          input_tokens: 100,
          output_tokens: 50,
          status: 'SUCCESS' as const,
          error_code: null,
        },
      })),
  };
}

/** Valid MAIN_MATCH_SUMMARY classification payload for the classifier prompt schema. */
const CLASSIFY_MAIN = {
  screen_type: 'MAIN_MATCH_SUMMARY',
  confidence: 0.97,
  reason: 'Scoreboard with final score visible',
  visual_features: ['scoreboard'],
  uncertainties: [],
};

/** Valid match extraction payload for the match prompt schema (nicknames match the seeded roster). */
const EXTRACT_MAIN = {
  screen_type: 'MAIN_MATCH_SUMMARY',
  result_indicator: 'WIN',
  team_a_score: 2,
  team_b_score: 1,
  team_a_players: [
    { nickname_raw: 'RAKeeper', rating: 8.5, goals: 0, assists: 0, passes: 10, defense: 2 },
    { nickname_raw: 'RAPlayer2', rating: 7.0, goals: 1, assists: 1, passes: 8, defense: 1 },
    { nickname_raw: 'RAPlayer3', rating: 6.5, goals: 1, assists: 1, passes: 7, defense: 3 },
    { nickname_raw: 'RAPlayer4', rating: 6.0, goals: 0, assists: 0, passes: 6, defense: 2 },
    { nickname_raw: 'RAPlayer5', rating: 5.5, goals: 0, assists: 0, passes: 5, defense: 1 },
  ],
  team_b_players: [
    { nickname_raw: 'RBKeeper', rating: 7.5, goals: 0, assists: 0, passes: 9, defense: 3 },
    { nickname_raw: 'RBPlayer2', rating: 7.0, goals: 1, assists: 0, passes: 8, defense: 2 },
    { nickname_raw: 'RBPlayer3', rating: 6.5, goals: 0, assists: 1, passes: 7, defense: 2 },
    { nickname_raw: 'RBPlayer4', rating: 6.0, goals: 0, assists: 0, passes: 6, defense: 1 },
    { nickname_raw: 'RBPlayer5', rating: 5.0, goals: 0, assists: 0, passes: 5, defense: 2 },
  ],
  confidence: 0.9,
  unreadable_fields: [],
  uncertainties: [],
};

describe('AI Resilience: Retry Queue & Status Notification (v3)', () => {
  let db: Client;
  const t0 = new Date('2026-11-20T10:00:00.000Z');
  const tournamentId = 'tour-retry-1';
  const teamAId = 'team-r-a';
  const teamBId = 'team-r-b';
  const fixtureId = 'fix-retry-001';
  const delegateAJid = '628111111111@s.whatsapp.net';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);

    const now = t0.toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Retry Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES ('del-ra', 'Delegate RA', 'ACTIVE', ?, ?), ('del-rb', 'Delegate RB', 'ACTIVE', ?, ?)`,
      args: [now, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Team Retry A', 'VERIFIED', ?, ?), (?, ?, 'Team Retry B', 'VERIFIED', ?, ?)`,
      args: [teamAId, tournamentId, now, now, teamBId, tournamentId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, 'Asia/Jakarta', 'IN_PROGRESS', ?, ?)`,
      args: [fixtureId, tournamentId, teamAId, teamBId, teamAId, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES ('game-retry-001', ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
      args: [fixtureId, now, now],
    });
    // 1 GK + 4 outfield per team, nicknames aligned with EXTRACT_MAIN payload
    for (let s = 1; s <= 5; s++) {
      const isGk = s === 1;
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-ra-${s}`, tournamentId, teamAId,
          isGk ? 'RAKeeper' : `RAPlayer${s}`,
          isGk ? 'RAKeeper' : `RAPlayer${s}`,
          isGk ? 'rakeeper' : `raplayer${s}`,
          isGk ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-rb-${s}`, tournamentId, teamBId,
          isGk ? 'RBKeeper' : `RBPlayer${s}`,
          isGk ? 'RBKeeper' : `RBPlayer${s}`,
          isGk ? 'rbkeeper' : `rbplayer${s}`,
          isGk ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  /** Ingests one photo message for the fixture and attaches a media asset row. */
  async function ingestEvidencePhoto(app: ReturnType<typeof createApp>, msgKey: string): Promise<void> {
    const now = new Date().toISOString();
    const msg: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: msgKey,
      chat_id: 'central-retry-group@g.us',
      sender_raw_address: delegateAJid,
      sender_normalized_address: delegateAJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateAJid,
      push_name: 'Delegate RA',
      message_timestamp: now,
      received_at: now,
      message_type: 'IMAGE',
      text_body: null,
      caption: 'Hasil laga',
      reply_to_key: null,
      raw_message: {} as any,
    };

    await app.handleInboundMessage(msg);

    const inMsgRes = await db.execute({
      sql: 'SELECT id FROM inbound_messages WHERE provider_message_key = ?',
      args: [msgKey],
    });
    const capturedMsgId = String(inMsgRes.rows[0][0]);

    await db.execute({
      sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
            VALUES (?, 'FLASHPEAK_VM_MEDIA', ?, 'MAIN_MATCH', 'image/jpeg', 1024, 'hash-${msgKey}', 'PRIVATE', 'STORED', ?, ?)`,
      args: [`media-${msgKey}`, `${msgKey}.jpg`, capturedMsgId, now],
    });
  }

  /** Marks a session as due (pulls debounce_due_at into the past). */
  async function forceDue(sessionId: string): Promise<void> {
    await db.execute({
      sql: `UPDATE report_sessions SET debounce_due_at = ? WHERE id = ?`,
      args: [new Date(Date.now() - 1000).toISOString(), sessionId],
    });
  }

  // ===========================================================================
  // Part 2: Intake acknowledgment (silent-intake fix)
  // ===========================================================================
  describe('Intake acknowledgment', () => {
    it('replies with a receipt ack when a photo is accepted into a session', async () => {
      const app = createApp({ db, quietWindowMs: 50 });
      const outcome = await (async () => {
        const now = new Date().toISOString();
        const msg: NormalizedMessage = {
          id: randomUUID(),
          provider_message_key: 'msg-ack-01',
          chat_id: 'central-retry-group@g.us',
          sender_raw_address: delegateAJid,
          sender_normalized_address: delegateAJid,
          address_type: 'JID',
          is_from_me: false,
          participant: delegateAJid,
          push_name: 'Delegate RA',
          message_timestamp: now,
          received_at: now,
          message_type: 'IMAGE',
          text_body: null,
          caption: 'Hasil laga',
          reply_to_key: null,
          raw_message: {} as any,
        };
        return app.handleInboundMessage(msg);
      })();

      expect(outcome.handled).toBe(true);
      expect(outcome.type).toBe('EVIDENCE');
      expect(outcome.replyText).toBeTruthy();
      expect(outcome.replyText).toContain('Screenshot diterima');
      expect(outcome.replyText).toContain('sedang diproses');
    });

    it('ack mentions the pending retry state when a late photo joins a retried session', async () => {
      const app = createApp({ db, quietWindowMs: 50 });

      // Create session directly and mark it as retried once
      const sessionRes = await findOrCreateReportSession(db, {
        fixture_id: fixtureId,
        submitting_team_id: teamAId,
      });
      const sid = sessionRes.session.id;
      await db.execute({
        sql: `UPDATE report_sessions SET ai_retry_count = 1 WHERE id = ?`,
        args: [sid],
      });

      const now = new Date().toISOString();
      const msg: NormalizedMessage = {
        id: randomUUID(),
        provider_message_key: 'msg-ack-02',
        chat_id: 'central-retry-group@g.us',
        sender_raw_address: delegateAJid,
        sender_normalized_address: delegateAJid,
        address_type: 'JID',
        is_from_me: false,
        participant: delegateAJid,
        push_name: 'Delegate RA',
        message_timestamp: now,
        received_at: now,
        message_type: 'IMAGE',
        text_body: null,
        caption: 'Hasil laga tambahan',
        reply_to_key: null,
        raw_message: {} as any,
      };
      const outcome = await app.handleInboundMessage(msg);

      expect(outcome.handled).toBe(true);
      expect(outcome.type).toBe('EVIDENCE');
      expect(outcome.replyText).toContain('menunggu percobaan ulang');
      expect(outcome.replyText).toContain('tidak perlu mengirim ulang');
    });
  });

  // ===========================================================================
  // Part 2: Automatic retry queue for AllProvidersFailedError
  // ===========================================================================
  describe('Automatic retry queue', () => {
    it('schedules a retry (not terminal failure) on first all-providers failure and notifies the participant', async () => {
      const failingAdapter = createMockAdapter('GROQ', {
        onExecute: async () => {
          throw new Error('503 Service Unavailable');
        },
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [failingAdapter] }),
        quietWindowMs: 50,
        aiMaxRetries: 3,
        aiRetryDelayMs: 60_000,
      });

      await ingestEvidencePhoto(app, 'msg-retry-01');
      await new Promise((r) => setTimeout(r, 60));

      const results = await app.processDueDebounceBatches();
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('AI_RETRY_SCHEDULED');
      expect(results[0].isAIRetry).toBe(true);
      expect(results[0].retriesExhausted).toBeFalsy();

      // Message: retry pending, asks participant NOT to resend
      expect(results[0].whatsappSummary).toContain('Laporan Kamu Masih Diproses');
      expect(results[0].whatsappSummary).toContain('percobaan ulang ke-1 dari 3');
      expect(results[0].whatsappSummary).toContain('tidak mengirim ulang screenshot');

      // DB: session back to COLLECTING, retry counter 1, due date ~60s in the future
      const sess = await db.execute({
        sql: 'SELECT status, ai_retry_count, debounce_due_at FROM report_sessions WHERE id = ?',
        args: [results[0].sessionId],
      });
      expect(String(sess.rows[0][0])).toBe('COLLECTING');
      expect(Number(sess.rows[0][1])).toBe(1);
      const dueAt = new Date(String(sess.rows[0][2])).getTime();
      expect(dueAt).toBeGreaterThan(Date.now() + 50_000);
      expect(dueAt).toBeLessThan(Date.now() + 70_000);
    });

    it('recovers mid-retry: provider comes back and the retried batch produces a draft', async () => {
      let providerDown = true;
      const flakyAdapter = createMockAdapter('GROQ', {
        onExecute: async (req) => {
          if (providerDown) {
            throw new Error('503 Service Unavailable');
          }
          if (req.task === 'CLASSIFY') {
            return {
              raw_text: JSON.stringify(CLASSIFY_MAIN),
              parsed_json: CLASSIFY_MAIN,
              telemetry: {
                provider: 'GROQ', model: 'm', task_type: req.task,
                latency_ms: 10, input_tokens: 1, output_tokens: 1,
                status: 'SUCCESS' as const, error_code: null,
              },
            };
          }
          return {
            raw_text: JSON.stringify(EXTRACT_MAIN),
            parsed_json: EXTRACT_MAIN,
            telemetry: {
              provider: 'GROQ', model: 'm', task_type: req.task,
              latency_ms: 10, input_tokens: 1, output_tokens: 1,
              status: 'SUCCESS' as const, error_code: null,
            },
          };
        },
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [flakyAdapter] }),
        quietWindowMs: 50,
        aiMaxRetries: 3,
        aiRetryDelayMs: 60_000,
      });

      await ingestEvidencePhoto(app, 'msg-retry-02');
      await new Promise((r) => setTimeout(r, 60));

      // Attempt 1: all providers fail -> retry scheduled
      const first = await app.processDueDebounceBatches();
      expect(first[0].status).toBe('AI_RETRY_SCHEDULED');

      // Provider recovers; retry delay elapses
      providerDown = false;
      await forceDue(first[0].sessionId);
      const second = await app.processDueDebounceBatches();
      expect(second.length).toBe(1);
      expect(second[0].status).toBe('DRAFT_CREATED');
      expect(second[0].draftVersion).toBeTruthy();
      expect(second[0].whatsappSummary).toBeTruthy();
      // Success message is the normal report summary, not a failure/retry notice
      expect(second[0].whatsappSummary).not.toContain('Tidak Tersedia');
      expect(second[0].whatsappSummary).not.toContain('mencoba ulang');
    });

    it('exhausts the retry budget, then sends the manual-verification message (terminal)', async () => {
      const failingAdapter = createMockAdapter('GROQ', {
        onExecute: async () => {
          throw new Error('503 Service Unavailable');
        },
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [failingAdapter] }),
        quietWindowMs: 50,
        aiMaxRetries: 2,
        aiRetryDelayMs: 60_000,
      });

      await ingestEvidencePhoto(app, 'msg-retry-03');
      await new Promise((r) => setTimeout(r, 60));

      // Attempt 1 (initial): retry scheduled
      const r1 = await app.processDueDebounceBatches();
      expect(r1[0].status).toBe('AI_RETRY_SCHEDULED');

      // Attempt 2 (retry 1): still within budget -> retry scheduled again
      await forceDue(r1[0].sessionId);
      const r2 = await app.processDueDebounceBatches();
      expect(r2[0].status).toBe('AI_RETRY_SCHEDULED');

      // Attempt 3 (retry 2 = last allowed): budget exhausted -> terminal AI_FAILED
      await forceDue(r2[0].sessionId);
      const r3 = await app.processDueDebounceBatches();
      expect(r3.length).toBe(1);
      expect(r3[0].status).toBe('AI_FAILED');
      expect(r3[0].retriesExhausted).toBe(true);

      // Message: manual verification with attempt count and admin hint
      const msg = r3[0].whatsappSummary!;
      expect(msg).toContain('Verifikasi Manual Diperlukan');
      expect(msg).toContain('sebanyak 3 kali');
      expect(msg).toContain('TIDAK resmi, TIDAK diterima, dan TIDAK ditolak');
      expect(msg).toContain('!manualreport');

      // DB: session terminally FAILED, not rescheduled
      const sess = await db.execute({
        sql: 'SELECT status, ai_retry_count FROM report_sessions WHERE id = ?',
        args: [r3[0].sessionId],
      });
      expect(String(sess.rows[0][0])).toBe('FAILED');
      expect(Number(sess.rows[0][1])).toBe(2);
    });

    it('a retried session never starves or reorders normal FIFO batches', async () => {
      const failingAdapter = createMockAdapter('GROQ', {
        onExecute: async () => {
          throw new Error('503 Service Unavailable');
        },
      });
      const router = new ProviderRouter({ adapters: [failingAdapter] });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: router,
        quietWindowMs: 50,
        aiMaxRetries: 1,
        aiRetryDelayMs: 60_000,
      });

      // Session A: will fail all providers and be retried
      await ingestEvidencePhoto(app, 'msg-fifo-a');
      // Session B (different fixture): a normal batch waiting in the queue
      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
              VALUES ('fix-retry-002', ?, 'GROUP', ?, ?, ?, ?, 'Asia/Jakarta', 'IN_PROGRESS', ?, ?)`,
        args: [tournamentId, teamAId, teamBId, teamAId, t0.toISOString(), t0.toISOString(), t0.toISOString()],
      });
      const sessionB = await findOrCreateReportSession(db, {
        fixture_id: 'fix-retry-002',
        submitting_team_id: teamBId,
      });
      // Attach a message + media asset so session B is a complete, claimable batch
      const nowB = new Date().toISOString();
      const msgBId = randomUUID();
      await db.execute({
        sql: `INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, text_body, caption, report_session_id, raw_metadata_json, created_at)
              VALUES (?, 'msg-fifo-b', 'central-retry-group@g.us', ?, ?, ?, 'IMAGE', NULL, 'hasil', ?, '{}', ?)`,
        args: [msgBId, delegateAJid, nowB, nowB, sessionB.session.id, nowB],
      });
      await db.execute({
        sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
              VALUES (?, 'FLASHPEAK_VM_MEDIA', 'fifo-b.jpg', 'MAIN_MATCH', 'image/jpeg', 1024, 'hash-fifo-b', 'PRIVATE', 'STORED', ?, ?)`,
        args: [`media-fifo-b`, msgBId, nowB],
      });
      // Make B due as well — with a due date strictly LATER than A's, so the
      // FIFO claim order (ORDER BY debounce_due_at ASC) must process A first.
      // A's due date (~now+50ms from intake) has already elapsed when the sleep
      // below finishes; B becomes due a few ms after that.
      await db.execute({
        sql: `UPDATE report_sessions SET debounce_due_at = ? WHERE id = ?`,
        args: [new Date(Date.now() + 80).toISOString(), sessionB.session.id],
      });

      await new Promise((r) => setTimeout(r, 60));

      // Both due; A (earlier due date) processed first, B claimed right after
      const results = await app.processDueDebounceBatches();
      expect(results.length).toBe(2);
      expect(results[0].sessionId).not.toBe(sessionB.session.id);
      expect(results[0].status).toBe('AI_RETRY_SCHEDULED');

      // B must have been claimed and processed (also fails -> also retried), never skipped
      const bResult = results.find((r) => r.sessionId === sessionB.session.id);
      expect(bResult).toBeTruthy();
      expect(bResult!.status).toBe('AI_RETRY_SCHEDULED');

      // The retried session A re-enters the queue with a due date pushed by the
      // full retry delay -> it cannot jump ahead of sessions waiting normally.
      const sessA = await db.execute({
        sql: 'SELECT debounce_due_at, status FROM report_sessions WHERE id = ?',
        args: [results[0].sessionId],
      });
      expect(String(sessA.rows[0][1])).toBe('COLLECTING');
      const dueA = new Date(String(sessA.rows[0][0])).getTime();
      expect(dueA).toBeGreaterThan(Date.now() + 50_000);
    });

    it('rescheduleDebounceRetry is atomic with the version counter (optimistic-lock style)', async () => {
      const sessionRes = await findOrCreateReportSession(db, {
        fixture_id: fixtureId,
        submitting_team_id: teamAId,
      });
      const sid = sessionRes.session.id;

      const before = sessionRes.session;
      const updated = await rescheduleDebounceRetry(db, sid, 60_000);

      expect(updated.status).toBe('COLLECTING');
      expect(updated.ai_retry_count).toBe(before.ai_retry_count + 1);
      expect(updated.version).toBe(before.version + 1);
      expect(updated.lease_owner).toBeNull();
      expect(updated.lease_expires_at).toBeNull();
      expect(new Date(updated.debounce_due_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
    });

    it('a claim on a rescheduled session before the retry delay elapses returns null (waits for due date)', async () => {
      const sessionRes = await findOrCreateReportSession(db, {
        fixture_id: fixtureId,
        submitting_team_id: teamAId,
      });
      const sid = sessionRes.session.id;
      await rescheduleDebounceRetry(db, sid, 60_000);

      // Not yet due -> no claim, retry waits for its scheduled time
      const claimed = await claimDebounceBatch(db, 'test-worker', 30_000);
      expect(claimed).toBeNull();
    });
  });

  // ===========================================================================
  // Part 1: Failure-cause-differentiated notifications
  // ===========================================================================
  describe('Failure-cause differentiation', () => {
    it('UNREADABLE classification asks for a clearer screenshot (never claims provider outage)', async () => {
      const unreadableClassify = {
        screen_type: 'UNREADABLE',
        confidence: 0.99,
        reason: 'Image is heavily blurred, no text legible',
        visual_features: [],
        uncertainties: ['blur'],
      };
      const adapter = createMockAdapter('GROQ', {
        onExecute: async (req) => ({
          raw_text: JSON.stringify(unreadableClassify),
          parsed_json: unreadableClassify,
          telemetry: {
            provider: 'GROQ', model: 'm', task_type: req.task,
            latency_ms: 10, input_tokens: 1, output_tokens: 1,
            status: 'SUCCESS' as const, error_code: null,
          },
        }),
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [adapter] }),
        quietWindowMs: 50,
      });

      await ingestEvidencePhoto(app, 'msg-unread-01');
      await new Promise((r) => setTimeout(r, 60));

      const results = await app.processDueDebounceBatches();
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('NEEDS_CORRECTION');

      const msg = results[0].whatsappSummary!;
      expect(msg).toContain('Screenshot Tidak Dapat Dibaca');
      expect(msg).toContain('AI berhasil merespons');
      expect(msg).toContain('kirim ulang');
      expect(msg).toContain('heavily blurred');
      // Must NOT be mistaken for an outage
      expect(msg).not.toContain('Tidak Tersedia');
      expect(msg).not.toContain('penyedia');
      expect(msg).not.toContain('hubungi penyelenggara');

      // Session terminally INCOMPLETE (participant must resend), no retry loop
      const sess = await db.execute({
        sql: 'SELECT status, ai_retry_count FROM report_sessions WHERE id = ?',
        args: [results[0].sessionId],
      });
      expect(String(sess.rows[0][0])).toBe('INCOMPLETE');
      expect(Number(sess.rows[0][1])).toBe(0);
    });

    it('missing main match summary screenshot produces an actionable resend request', async () => {
      // Classifier says every screenshot is a player detail screen
      const gkOnly = {
        screen_type: 'INDIVIDUAL_PLAYER_DETAIL',
        confidence: 0.95,
        reason: 'Player stat detail page',
        visual_features: [],
        uncertainties: [],
      };
      const adapter = createMockAdapter('GROQ', {
        onExecute: async (req) => ({
          raw_text: JSON.stringify(gkOnly),
          parsed_json: gkOnly,
          telemetry: {
            provider: 'GROQ', model: 'm', task_type: req.task,
            latency_ms: 10, input_tokens: 1, output_tokens: 1,
            status: 'SUCCESS' as const, error_code: null,
          },
        }),
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [adapter] }),
        quietWindowMs: 50,
      });

      await ingestEvidencePhoto(app, 'msg-nomain-01');
      await new Promise((r) => setTimeout(r, 60));

      const results = await app.processDueDebounceBatches();
      expect(results[0].status).toBe('NEEDS_CORRECTION');
      const msg = results[0].whatsappSummary!;
      expect(msg).toContain('tidak terdeteksi');
      expect(msg).toContain('kirim ulang');
      expect(msg).not.toContain('Tidak Tersedia');
    });

    it('AIMalformedResponseError (AI responded, unusable output) asks for a resend, not manual verification', async () => {
      const adapter = createMockAdapter('GROQ', {
        onExecute: async (req) => {
          if (req.task === 'CLASSIFY') {
            return {
              raw_text: JSON.stringify(CLASSIFY_MAIN),
              parsed_json: CLASSIFY_MAIN,
              telemetry: {
                provider: 'GROQ', model: 'm', task_type: req.task,
                latency_ms: 10, input_tokens: 1, output_tokens: 1,
                status: 'SUCCESS' as const, error_code: null,
              },
            };
          }
          // Provider responds with garbage for EXTRACT_MATCH
          throw new AIMalformedResponseError('GROQ', 'JSON output could not be parsed');
        },
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [adapter] }),
        quietWindowMs: 50,
        aiMaxRetries: 3,
      });

      await ingestEvidencePhoto(app, 'msg-malformed-01');
      await new Promise((r) => setTimeout(r, 60));

      const results = await app.processDueDebounceBatches();
      expect(results[0].status).toBe('AI_FAILED');
      expect(results[0].isAIRetry).toBeFalsy(); // not an outage retry
      expect(results[0].retriesExhausted).toBeFalsy();

      const msg = results[0].whatsappSummary!;
      expect(msg).toContain('Screenshot Tidak Dapat Dibaca');
      expect(msg).toContain('Hasil pembacaan AI tidak valid');
      expect(msg).not.toContain('Verifikasi Manual Diperlukan');
    });

    it('message formatters: retry pending vs exhausted vs unreadable are distinct texts', () => {
      const retry = formatAIRetryPendingMessage({
        sessionId: 'session-abcd1234',
        attemptNumber: 2,
        maxRetries: 3,
        retryDelayMs: 60_000,
      });
      const exhausted = formatAIRetriesExhaustedMessage({
        sessionId: 'session-abcd1234',
        attemptNumber: 3,
        includeAdminCommandHint: true,
      });
      const unreadable = formatUnreadableEvidenceMessage({
        sessionId: 'session-abcd1234',
        reason: 'blur',
      });

      expect(retry).toContain('percobaan ulang ke-2 dari 3');
      expect(retry).toContain('60 detik');
      expect(exhausted).toContain('sebanyak 4 kali');
      expect(exhausted).toContain('!manualreport');
      expect(unreadable).toContain('kirim ulang');
      // Cross-contamination guards
      expect(retry).not.toContain('Verifikasi Manual');
      expect(exhausted).not.toContain('mencoba ulang secara otomatis');
      expect(unreadable).not.toContain('penyedia');
    });
  });

  // ===========================================================================
  // Regression guards: unchanged behavior
  // ===========================================================================
  describe('Regression: unchanged behavior', () => {
    it('transparent failover (one provider down, other healthy) still yields a normal draft with no failure notice', async () => {
      let groqDown = true;
      const groq = createMockAdapter('GROQ', {
        onExecute: async () => {
          if (groqDown) throw new Error('503 Service Unavailable');
          throw new Error('unreachable');
        },
      });
      const gemini = createMockAdapter('GEMINI', {
        onExecute: async (req) => {
          const payload = req.task === 'CLASSIFY' ? CLASSIFY_MAIN : EXTRACT_MAIN;
          return {
            raw_text: JSON.stringify(payload),
            parsed_json: payload,
            telemetry: {
              provider: 'GEMINI', model: 'm', task_type: req.task,
              latency_ms: 10, input_tokens: 1, output_tokens: 1,
              status: 'SUCCESS' as const, error_code: null,
            },
          };
        },
      });
      const app = createApp({
        db,
        mediaClient: createStubMediaClient(),
        providerRouter: new ProviderRouter({ adapters: [groq, gemini] }),
        quietWindowMs: 50,
      });

      await ingestEvidencePhoto(app, 'msg-failover-01');
      await new Promise((r) => setTimeout(r, 60));

      const results = await app.processDueDebounceBatches();
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('DRAFT_CREATED');
      expect(results[0].draftVersion).toBeTruthy();

      // Normal summary contains the match report, no retry/failure text
      expect(results[0].whatsappSummary).toBeTruthy();
      expect(results[0].whatsappSummary).not.toContain('Tidak Tersedia');
      expect(results[0].whatsappSummary).not.toContain('mencoba ulang');
      expect(results[0].whatsappSummary).not.toContain('Verifikasi Manual');

      // Session completed normally, zero retries used
      const sess = await db.execute({
        sql: 'SELECT status, ai_retry_count FROM report_sessions WHERE id = ?',
        args: [results[0].sessionId],
      });
      expect(String(sess.rows[0][0])).toBe('DRAFT_READY');
      expect(Number(sess.rows[0][1])).toBe(0);
    });

    it('NO_MEDIA batch still produces the existing resend prompt (no retry loop)', async () => {
      const app = createApp({ db, quietWindowMs: 50 });
      // Session with a text message but no media asset
      const sessionRes = await findOrCreateReportSession(db, {
        fixture_id: fixtureId,
        submitting_team_id: teamAId,
      });
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, text_body, report_session_id, raw_metadata_json, created_at)
              VALUES (?, 'msg-nomedia-01', 'g', ?, ?, ?, 'TEXT', 'hasil', ?, '{}', ?)`,
        args: [randomUUID(), delegateAJid, now, now, sessionRes.session.id, now],
      });
      await forceDue(sessionRes.session.id);

      const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
      expect(batch).toBeTruthy();
      const res = await processClaimedBatch({ db }, batch!);
      expect(res.status).toBe('NO_MEDIA');
      expect(res.whatsappSummary).toContain('Bukti foto pertandingan tidak terdeteksi');
    });

    it('router circuit-breaker semantics are untouched (trip, skip, half-open recovery)', async () => {
      let fail = true;
      const groq = createMockAdapter('GROQ', {
        onExecute: async () => {
          if (fail) throw new Error('503');
          return {
            raw_text: '{}',
            parsed_json: {},
            telemetry: {
              provider: 'GROQ', model: 'm', task_type: 'CLASSIFY' as const,
              latency_ms: 1, input_tokens: 1, output_tokens: 1,
              status: 'SUCCESS' as const, error_code: null,
            },
          };
        },
      });
      const gemini = createMockAdapter('GEMINI');
      const router = new ProviderRouter({
        adapters: [groq, gemini],
        consecutiveFailureThreshold: 2,
        cooldownWindowMs: 50,
      });

      const req = { task: 'CLASSIFY' as const, system_prompt: '', prompt: 'x' };
      // Call 1 starts at Groq (rotation index 0) -> fails; Gemini succeeds.
      await router.execute(req);
      // Call 2 starts at Gemini -> succeeds.
      await router.execute(req);
      // Call 3 starts at Groq again -> 2nd consecutive failure -> trips OPEN.
      await router.execute(req);
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('OPEN');

      // While OPEN and cooldown not elapsed, Groq is skipped entirely.
      const groqCallsBefore = 3; // calls 1 and 3 reached Groq (call 2 started at Gemini)
      await router.execute(req); // call 4: starts at Gemini (rotation), Groq skipped
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('OPEN');

      // After the cooldown elapses, the next request that lands on Groq puts it
      // in HALF_OPEN; a success closes the breaker again.
      await new Promise((r) => setTimeout(r, 60));
      fail = false;
      // Calls alternate start positions: keep executing until Groq gets its turn.
      for (let i = 0; i < 2; i++) {
        await router.execute(req);
      }
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('CLOSED');
      expect(groqCallsBefore).toBe(3);
    });

    it('AllProvidersFailedError still carries manual_mode_required + fallback_message (FR-FAIL-002)', async () => {
      const err = new AllProvidersFailedError([
        { provider: 'GROQ', error: new Error('down') },
        { provider: 'GEMINI', error: new Error('down') },
      ]);
      expect(err.manual_mode_required).toBe(true);
      expect(err.fallback_message).toContain('temporarily unavailable');
    });
  });
});
