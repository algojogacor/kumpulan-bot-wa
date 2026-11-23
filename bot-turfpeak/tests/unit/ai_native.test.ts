/**
 * AI-Native Feature Tests (D-037..D-040)
 *
 * Covers the safety-critical properties required by the task brief:
 * - Omak Peak rate limit: rolling window 2/60s, third call rejected with retry hint.
 * - Omak Peak read-only intro on no-arg invocation.
 * - Agent action catalog: preview rejects invalid fixture / wrong winning_team.
 * - Agent planner idempotency: double-confirm EXPLICITLY rejected (not silently ignored).
 * - Agent planner: expired plan rejected; cancelled plan rejected; cross-organizer reject.
 * - Agent planner: transactional rollback when an action fails mid-plan.
 * - QnA service: list empty + with entries; table-missing graceful.
 * - Trivia service: loads curated DB; randomFact works without AI (raw fact path).
 * - Migration 004: ai_action_plans + qna_entries tables exist; provider_usage CHECK expanded.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import { RollingRateLimiter, OmakPeakService, OMAK_PEAK_INTRO, buildOmakPeakContext, ConversationMemory, smartTruncate } from '../../src/application/omak-peak.js';
import { buildOmakPeakPrompt } from '../../src/ai/prompts/omak-peak.js';
import {
  AgentActionCatalog,
  buildDefaultAgentActionCatalog,
  reopenReportParams,
  forfeitWinnerParams,
  setTournamentStatusParams,
} from '../../src/application/agent-actions.js';
import { AgentPlannerService } from '../../src/application/agent-planner.js';
import { QnaService } from '../../src/application/qna.js';
import { TriviaService } from '../../src/application/trivia.js';
import {
  QuizSessionManager,
  isQuizAnswerMatch,
  type QuizQuestion,
} from '../../src/application/quiz-session.js';
import type { Client } from '@libsql/client';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return db;
}

async function seedTournamentFixture(db: Client): Promise<{
  tournamentId: string;
  teamAId: string;
  teamBId: string;
  fixtureId: string;
}> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
          VALUES ('tourn-1', 'Gojiha Cup Test', 'ACTIVE', 'Asia/Jakarta', '1.0', '{}', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-a', 'Del A', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-b', 'Del B', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, delegate_id, registration_status, created_at, updated_at)
          VALUES ('team-a', 'tourn-1', 'Singa FC', 'SIN', 'del-a', 'VERIFIED', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, delegate_id, registration_status, created_at, updated_at)
          VALUES ('team-b', 'tourn-1', 'Elang FC', 'ELG', 'del-b', 'VERIFIED', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json,
                                    algorithm, algorithm_version, next_reveal_index, created_at)
          VALUES ('draw-1', 'tourn-1', 'COMPLETED', '{}', '[]', 'fisher-yates', '1.0', 0, ?)`,
    args: [now],
  });
  await db.execute({
    sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES ('grp-1', 'draw-1', 'A', 1)`,
  });
  await db.execute({
    sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES ('grp-1', 'team-a', 1), ('grp-1', 'team-b', 2)`,
  });
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id,
                                left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
          VALUES ('fix-1', 'tourn-1', 'GROUP', 'grp-1', 'MD1', 'team-a', 'team-b', 'team-a', ?, 'Asia/Jakarta', 'SCHEDULED', ?, ?)`,
    args: [now, now, now],
  });
  return { tournamentId: 'tourn-1', teamAId: 'team-a', teamBId: 'team-b', fixtureId: 'fix-1' };
}

// =============================================================================
// RollingRateLimiter
// =============================================================================

describe('RollingRateLimiter (Omak Peak rate limit, D-037)', () => {
  it('allows 2 uses within 60s, rejects 3rd with retry-after', () => {
    const rl = new RollingRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(rl.check('user-A', t0).allowed).toBe(true);
    expect(rl.check('user-A', t0 + 10_000).allowed).toBe(true); // 2nd within window
    const third = rl.check('user-A', t0 + 20_000);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      // Retry-after should be ~40s (60 - 20 elapsed since oldest at t0).
      expect(third.retryAfterMs).toBeGreaterThanOrEqual(30_000);
      expect(third.retryAfterMs).toBeLessThanOrEqual(45_000);
    }
  });

  it('rolling window: after oldest expires, 3rd use allowed', () => {
    const rl = new RollingRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(rl.check('user-B', t0).allowed).toBe(true);
    expect(rl.check('user-B', t0 + 5_000).allowed).toBe(true);
    // 61s later — oldest (t0) is outside the 60s window; a new use should be allowed.
    expect(rl.check('user-B', t0 + 61_000).allowed).toBe(true);
  });

  it('rate limit is per-sender (different users have separate budgets)', () => {
    const rl = new RollingRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(rl.check('alice', t0).allowed).toBe(true);
    expect(rl.check('alice', t0 + 1_000).allowed).toBe(true);
    // Bob has his own budget.
    expect(rl.check('bob', t0 + 2_000).allowed).toBe(true);
    expect(rl.check('bob', t0 + 3_000).allowed).toBe(true);
    // Alice still rate-limited.
    expect(rl.check('alice', t0 + 4_000).allowed).toBe(false);
  });
});

// =============================================================================
// OmakPeakService
// =============================================================================

describe('OmakPeakService (D-037)', () => {
  let db: Client;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('no-arg invocation returns intro (no AI call, no rate-limit consumption)', async () => {
    const svc = new OmakPeakService({ db }); // no providerRouter
    const res = await svc.handleAiCommand('user-A', '', 'grp-test@g.us');
    expect(res.rateLimited).toBe(false);
    expect(res.replyText).toBe(OMAK_PEAK_INTRO);
  });

  it('without providerRouter, returns graceful fallback (not a crash)', async () => {
    const svc = new OmakPeakService({ db });
    const res = await svc.handleAiCommand('user-A', 'siapa topskor?', 'grp-test@g.us');
    expect(res.rateLimited).toBe(false);
    expect(res.replyText).toContain('AI provider');
  });

  it('rate-limits the 3rd call within 60s even with providerRouter present', async () => {
    // Mock router that never gets called for the 3rd call.
    const fakeRouter: any = {
      execute: async () => ({ raw_text: 'mock jawaban', telemetry: {} }),
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    const r1 = await svc.handleAiCommand('user-A', 'pertanyaan 1', 'grp-test@g.us');
    const r2 = await svc.handleAiCommand('user-A', 'pertanyaan 2', 'grp-test@g.us');
    const r3 = await svc.handleAiCommand('user-A', 'pertanyaan 3', 'grp-test@g.us');
    expect(r1.rateLimited).toBe(false);
    expect(r2.rateLimited).toBe(false);
    expect(r3.rateLimited).toBe(true);
    expect(r3.replyText).toContain('cooldown');
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('never leaks a JSON {thinking, speak} wrapper into the chat reply', async () => {
    // Regression (prod 2026-11-22): a model wrapped its chat reply in an ad-hoc
    // {"thinking","speak","style"} envelope and the raw JSON was posted to the
    // group. Only the spoken part may ever be shown.
    const fakeRouter: any = {
      execute: async () => ({
        raw_text: '{"thinking": "internal reasoning must stay private", "speak": "Halo! Ini jawaban Omak Peak untuk kamu.", "style": "persona notes"}',
        telemetry: {},
      }),
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    const res = await svc.handleAiCommand('user-B', 'halo omak', 'grp-test@g.us');
    expect(res.rateLimited).toBe(false);
    expect(res.replyText).toContain('Halo! Ini jawaban Omak Peak untuk kamu.');
    expect(res.replyText).not.toContain('thinking');
    expect(res.replyText).not.toContain('{');
    expect(res.replyText).not.toContain('persona notes');
  });

  it('strips markdown fences and keeps plain chat text unchanged', async () => {
    const fakeRouter: any = {
      execute: async () => ({ raw_text: '```json\n{"speak": "jawaban dalam fence"}\n```', telemetry: {} }),
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    const res = await svc.handleAiCommand('user-C', 'tes fence', 'grp-test@g.us');
    expect(res.replyText).toBe('jawaban dalam fence');

    const fakeRouter2: any = {
      execute: async () => ({ raw_text: 'jawaban plain biasa aja', telemetry: {} }),
    };
    const svc2 = new OmakPeakService({ db, providerRouter: fakeRouter2 });
    const res2 = await svc2.handleAiCommand('user-D', 'tes plain', 'grp-test@g.us');
    expect(res2.replyText).toBe('jawaban plain biasa aja');
  });

  it('does not truncate long responses and delivers full text without ellipses', async () => {
    const longText = 'Analisa panjang untuk peluang tim juara: '.repeat(60); // > 2400 chars
    const fakeRouter: any = {
      execute: async () => ({ raw_text: longText, telemetry: {} }),
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    const res = await svc.handleAiCommand('user-long', 'berapa chance lolos?', 'grp-test@g.us');
    expect(res.replyText).toBe(longText.trim());
    expect(res.replyText.endsWith('…')).toBe(false);
  });

  it('smartTruncate: leaves text <= 5000 chars untouched, cleanly cuts > 5000 at sentence break', () => {
    const normalText = 'Halo ini teks normal.'.repeat(20);
    expect(smartTruncate(normalText, 5000)).toBe(normalText);

    const paragraph = 'Ini kalimat analisa panjang untuk turnamen. ';
    const hugeText = paragraph.repeat(150); // ~6600 chars
    const truncated = smartTruncate(hugeText, 5000);
    expect(truncated.length).toBeLessThan(5100);
    expect(truncated).toContain('_(Pesan terpotong pada batas maksimal 5.000 karakter)_');
    // Ensure it cuts cleanly at period/sentence boundary, not inside a word
    expect(truncated).toContain('.\n\n_(');
  });

  it('ConversationMemory: records, returns oldest-first within TTL, prunes expired', () => {
    let clock = 1_000_000;
    const mem = new ConversationMemory(6, 1000, () => clock);
    expect(mem.recent('grp@g.us')).toEqual([]);

    mem.record('grp@g.us', 'arya', 'siapa juara?', 'nggak ada yang main');
    mem.record('grp@g.us', 'jestre', 'coba tebak', 'tebak apa');
    const r = mem.recent('grp@g.us');
    expect(r).toHaveLength(2);
    expect(r[0].question).toBe('siapa juara?');
    expect(r[1].senderLabel).toBe('jestre');

    // TTL prune: advance past window.
    clock += 1500;
    mem.record('grp@g.us', 'x', 'baru', 'baru');
    const r2 = mem.recent('grp@g.us');
    expect(r2).toHaveLength(1);
    expect(r2[0].question).toBe('baru');
  });

  it('ConversationMemory: bounds to last N turns (ring buffer)', () => {
    const mem = new ConversationMemory(3, 60_000);
    for (let i = 0; i < 7; i++) mem.record('g@us', `u${i}`, `q${i}`, `a${i}`);
    const r = mem.recent('g@us');
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.question)).toEqual(['q4', 'q5', 'q6']);
  });

  it('ConversationMemory: scoped per chat (different groups do not share)', () => {
    const mem = new ConversationMemory();
    mem.record('grpA@g.us', 'arya', 'qa', 'aa');
    mem.record('grpB@g.us', 'arya', 'qb', 'bb');
    expect(mem.recent('grpA@g.us')).toHaveLength(1);
    expect(mem.recent('grpA@g.us')[0].question).toBe('qa');
    expect(mem.recent('grpB@g.us')[0].question).toBe('qb');
  });

  it('!ai injects prior turn into the prompt on a follow-up in the same group (rolling memory)', async () => {
    const seen: Array<{ system: string; prompt: string }> = [];
    const fakeRouter: any = {
      execute: async (req: any) => {
        seen.push({ system: req.system_prompt, prompt: req.prompt });
        return { raw_text: 'ok jawaban', telemetry: {} };
      },
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    // Turn 1: arya asks "siapa juara grup B"
    await svc.handleAiCommand('6281@lid', 'siapa juara grup B', '120363@g.us', 'arya');
    // Turn 2: jestre follows up with vague "coba tebak terserah"
    await svc.handleAiCommand('6282@lid', 'coba tebak terserah', '120363@g.us', 'jestre');

    expect(seen).toHaveLength(2);
    // First call: system prompt must NOT carry the question as memory (it's
    // only in `prompt` as the current user message).
    expect(seen[0].system).not.toContain('siapa juara grup B');
    // Second call must carry the prior turn so the model can connect "tebak terserah".
    expect(seen[1].system).toContain('siapa juara grup B');
    expect(seen[1].system).toContain('arya');
    // Sanity: the JSON array marker for populated memory only appears in turn 2.
    expect(seen[1].system).toContain('"recent_ai_turns": [');
    expect(seen[0].system).not.toContain('"recent_ai_turns": [');
  });

  it('!ai does NOT share memory across different group chats', async () => {
    const seen: string[] = [];
    const fakeRouter: any = {
      execute: async (req: any) => {
        seen.push(req.system_prompt);
        return { raw_text: 'ok', telemetry: {} };
      },
    };
    const svc = new OmakPeakService({ db, providerRouter: fakeRouter });
    await svc.handleAiCommand('u1', 'rahasia grup A', 'grpA@g.us', 'arya');
    await svc.handleAiCommand('u2', 'apa kabar', 'grpB@g.us', 'jestre');
    // Group B's prompt must not leak group A's secret question (no populated
    // memory array, and the secret question text must be absent).
    expect(seen[1]).not.toContain('rahasia grup A');
    expect(seen[1]).not.toContain('"recent_ai_turns": [');
  });
});

// =============================================================================
// AgentActionCatalog
// =============================================================================

describe('AgentActionCatalog preview validation (D-038)', () => {
  let db: Client;
  let catalog: AgentActionCatalog;

  beforeEach(async () => {
    db = await freshDb();
    await seedTournamentFixture(db);
    catalog = buildDefaultAgentActionCatalog(db);
  });

  it('reopen_report: rejects unknown fixture_id', async () => {
    const def = catalog.get('reopen_report')!;
    const r = await def.preview(db, reopenReportParams.parse({
      fixture_id: '00000000-0000-0000-0000-000000000000',
      reason: 'test',
    }));
    expect(r.validation_errors.length).toBeGreaterThan(0);
    expect(r.validation_errors[0]).toContain('tidak ditemukan');
  });

  it('reopen_report: rejects fixture that is not COMPLETED/WALKOVER (no LOCKED version to reopen)', async () => {
    const def = catalog.get('reopen_report')!;
    const r = await def.preview(db, reopenReportParams.parse({
      fixture_id: 'fix-1',
      reason: 'test',
    }));
    expect(r.validation_errors.length).toBeGreaterThan(0);
    // fix-1 is SCHEDULED — preview rejects on status before reaching the LOCKED-version check.
    expect(r.validation_errors[0]).toMatch(/COMPLETED|WALKOVER|LOCKED/);
  });

  it('forfeit_winner: rejects winning_team_id not in fixture', async () => {
    const def = catalog.get('forfeit_winner')!;
    const r = await def.preview(db, forfeitWinnerParams.parse({
      fixture_id: 'fix-1',
      winning_team_id: '00000000-0000-0000-0000-000000000000',
      reason: 'test',
    }));
    expect(r.validation_errors.length).toBeGreaterThan(0);
    expect(r.validation_errors[0]).toContain('bukan peserta');
  });

  it('forfeit_winner: accepts valid winning_team_id, produces summary', async () => {
    const def = catalog.get('forfeit_winner')!;
    const r = await def.preview(db, forfeitWinnerParams.parse({
      fixture_id: 'fix-1',
      winning_team_id: 'team-a',
      reason: 'lawan no-show',
    }));
    expect(r.validation_errors).toEqual([]);
    expect(r.summary).toContain('Singa FC');
    expect(r.summary).toContain('Elang FC');
  });

  it('catalog.toPromptJson lists all action_ids with parameter shapes', () => {
    const json = catalog.toPromptJson();
    const parsed = JSON.parse(json);
    const ids = parsed.map((a: any) => a.action_id);
    expect(ids).toContain('reopen_report');
    expect(ids).toContain('override_lock');
    expect(ids).toContain('forfeit_winner');
    expect(ids).toContain('reschedule_fixture');
    expect(ids).toContain('cancel_fixture');
    expect(ids).toContain('set_tournament_status');
    expect(ids).toContain('record_ko_game_score');
    expect(ids).toContain('announce');
  });
});

// =============================================================================
// AgentPlannerService — idempotency is the non-negotiable safety property
// =============================================================================

describe('AgentPlannerService idempotency & state machine (D-038)', () => {
  let db: Client;
  let catalog: AgentActionCatalog;
  let planner: AgentPlannerService;

  beforeEach(async () => {
    db = await freshDb();
    await seedTournamentFixture(db);
    catalog = buildDefaultAgentActionCatalog(db);
    planner = new AgentPlannerService({ db, actionCatalog: catalog });
  });

  /** Helper: directly stage a plan with a set_tournament_status action. */
  async function stagePlan(organizerAddress: string, tournamentId: string, newStatus: string): Promise<string> {
    const planId = 'plan-' + Math.random().toString(36).slice(2, 8);
    const planCode = 'AGENT-' + planId.slice(5, 9).toUpperCase();
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const planJson = {
      actions: [{
        action_id: 'set_tournament_status',
        params: setTournamentStatusParams.parse({
          tournament_id: tournamentId,
          new_status: newStatus,
          reason: 'test plan',
        }),
        rationale: 'test',
        preview_summary: 'ubah status test',
      }],
    };
    await db.execute({
      sql: `INSERT INTO ai_action_plans
              (id, plan_code, tournament_id, organizer_address, organizer_delegate_id,
               instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, 'PENDING', ?, ?, ?)`,
      args: [planId, planCode, tournamentId, organizerAddress, 'test instruction', JSON.stringify(planJson), expires, now.toISOString(), now.toISOString()],
    });
    return planCode;
  }

  it('confirmAndExecute executes a PENDING plan and marks it EXECUTED', async () => {
    const code = await stagePlan('org-1@s.whatsapp.net', 'tourn-1', 'DRAW_READY');
    const res = await planner.confirmAndExecute(code, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(true);
    expect(res.responseText).toContain('PLAN DIEKSEKUSI');
    // Verify DB state.
    const row = await db.execute({ sql: 'SELECT status FROM ai_action_plans WHERE plan_code = ?', args: [code] });
    expect(String((row.rows[0] as any).status)).toBe('EXECUTED');
    const t = await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: ['tourn-1'] });
    expect(String((t.rows[0] as any).status)).toBe('DRAW_READY');
  });

  it('DOUBLE-CONFIRM is explicitly rejected (idempotency) — not silently ignored', async () => {
    const code = await stagePlan('org-1@s.whatsapp.net', 'tourn-1', 'ARCHIVED');
    const first = await planner.confirmAndExecute(code, 'org-1@s.whatsapp.net');
    expect(first.success).toBe(true);
    const second = await planner.confirmAndExecute(code, 'org-1@s.whatsapp.net');
    expect(second.success).toBe(false);
    expect(second.responseText).toContain('SUDAH DIEKSEKUSI');
    expect(second.responseText).toContain('idempotency');
  });

  it('expired plan is rejected with explicit message', async () => {
    // Stage a plan with expiry in the past.
    const planId = 'plan-expired';
    const planCode = 'AGENT-EXP1';
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, 'org-1@s.whatsapp.net', 'test', '{"actions":[]}', 'PENDING', ?, ?, ?)`,
      args: [planId, planCode, pastExpiry, now, now],
    });
    const res = await planner.confirmAndExecute(planCode, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('KEDALUWARSA');
    // Verify status flipped to EXPIRED.
    const row = await db.execute({ sql: 'SELECT status FROM ai_action_plans WHERE plan_code = ?', args: [planCode] });
    expect(String((row.rows[0] as any).status)).toBe('EXPIRED');
  });

  it('cancelled plan is rejected', async () => {
    const code = await stagePlan('org-1@s.whatsapp.net', 'tourn-1', 'ARCHIVED');
    const cancel = await planner.cancelPlan(code, 'org-1@s.whatsapp.net');
    expect(cancel.success).toBe(true);
    const confirm = await planner.confirmAndExecute(code, 'org-1@s.whatsapp.net');
    expect(confirm.success).toBe(false);
    expect(confirm.responseText).toContain('dibatalkan');
  });

  it('cross-organizer confirm is rejected (only the stager may confirm)', async () => {
    const code = await stagePlan('org-1@s.whatsapp.net', 'tourn-1', 'ARCHIVED');
    const res = await planner.confirmAndExecute(code, 'org-2@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('organizer lain');
  });

  it('cancel of a non-PENDING plan is rejected', async () => {
    const code = await stagePlan('org-1@s.whatsapp.net', 'tourn-1', 'ARCHIVED');
    await planner.confirmAndExecute(code, 'org-1@s.whatsapp.net'); // EXECUTED
    const cancel = await planner.cancelPlan(code, 'org-1@s.whatsapp.net');
    expect(cancel.success).toBe(false);
    expect(cancel.responseText).toContain('tidak bisa dibatalkan');
  });

  it('transactional rollback: if an action throws mid-plan, no partial changes persist', async () => {
    // Stage a 2-action plan where the SECOND action will fail (invalid tournament_id).
    // The first action (set_tournament_status ACTIVE→DRAW_READY) should roll back.
    const planId = 'plan-rollback';
    const planCode = 'AGENT-RB01';
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const planJson = {
      actions: [
        {
          action_id: 'set_tournament_status',
          params: { tournament_id: 'tourn-1', new_status: 'DRAW_READY', reason: 'first action' },
          rationale: 'should roll back',
          preview_summary: 'first',
        },
        {
          action_id: 'set_tournament_status',
          params: { tournament_id: '00000000-0000-0000-0000-000000000000', new_status: 'ARCHIVED', reason: 'second action — will fail' },
          rationale: 'invalid tournament',
          preview_summary: 'second (invalid)',
        },
      ],
    };
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, tournament_id, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, 'tourn-1', 'org-1@s.whatsapp.net', 'rollback test', ?, 'PENDING', ?, ?, ?)`,
      args: [planId, planCode, JSON.stringify(planJson), expires, now.toISOString(), now.toISOString()],
    });

    // First, set tournament to ACTIVE (already is). The plan's first action changes it to DRAW_READY.
    // The second action's preview will fail (invalid tournament_id) inside the tx → rollback.
    const res = await planner.confirmAndExecute(planCode, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('GAGAL');
    expect(res.responseText).toContain('rollback');

    // Verify tournament status is STILL ACTIVE (first action rolled back).
    const t = await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: ['tourn-1'] });
    expect(String((t.rows[0] as any).status)).toBe('ACTIVE');

    // Verify plan marked FAILED.
    const planRow = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: [planCode] });
    expect(String((planRow.rows[0] as any).status)).toBe('FAILED');
    expect(String((planRow.rows[0] as any).failure_reason).length).toBeGreaterThan(0);

    // Verify audit event recorded for the failure.
    const audit = await db.execute({ sql: "SELECT event_type FROM audit_events WHERE entity_id = ?", args: [planId] });
    expect(audit.rows.length).toBe(1);
    expect(String((audit.rows[0] as any).event_type)).toBe('AI_AGENT_PLAN_FAILED');
  });

  it('recoverInterruptedPlans marks stale EXECUTING as FAILED', async () => {
    // Insert a plan in EXECUTING with an old updated_at.
    const planId = 'plan-stale';
    const planCode = 'AGENT-STLE';
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, 'org-1@s.whatsapp.net', 'stale', '{"actions":[]}', 'EXECUTING', ?, ?, ?)`,
      args: [planId, planCode, staleTime, staleTime, staleTime],
    });
    const n = await planner.recoverInterruptedPlans();
    expect(n).toBe(1);
    const row = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: [planCode] });
    expect(String((row.rows[0] as any).status)).toBe('FAILED');
    expect(String((row.rows[0] as any).failure_reason)).toContain('Interrupted');
  });
});

// =============================================================================
// AgentPlannerService — audit follow-up regressions for the two PR #9 blockers
//
// BUG-1 (stale basis): staleness of an EXECUTING plan was measured from
//   created_at (staging time) instead of updated_at (time of the last status
//   transition, i.e. when it entered EXECUTING) — inconsistent with the
//   startup sweep. A plan confirmed minutes after staging was misclassified
//   as "crashed mid-execution" by the double-confirm path.
// BUG-1b (unguarded EXECUTED update): the final update to EXECUTED was not
//   conditioned on status='EXECUTING', so it could overwrite a plan that a
//   concurrent stale-marker had already marked FAILED.
// BUG-2 (cancel TOCTOU): !agentcancel replied "Plan dibatalkan" without
//   checking the guarded UPDATE's rowsAffected, giving a false confirmation
//   when the plan was confirmed at the same moment from another device.
// =============================================================================

describe('AgentPlannerService audit-fix regressions (PR #9 blockers)', () => {
  let db: Client;
  let catalog: AgentActionCatalog;
  let planner: AgentPlannerService;

  beforeEach(async () => {
    db = await freshDb();
    await seedTournamentFixture(db);
    catalog = buildDefaultAgentActionCatalog(db);
    planner = new AgentPlannerService({ db, actionCatalog: catalog });
  });

  /** Insert a plan row directly with fully controlled timestamps. */
  async function insertPlanRow(opts: {
    code: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, 'org-1@s.whatsapp.net', 'audit fix regression', '{"actions":[]}', ?, ?, ?, ?)`,
      args: [
        'plan-' + opts.code.toLowerCase().replace(/[^a-z0-9]/g, ''),
        opts.code,
        opts.status,
        opts.expiresAt.toISOString(),
        opts.createdAt.toISOString(),
        opts.updatedAt.toISOString(),
      ],
    });
  }

  /** Stage a real PENDING plan with one set_tournament_status action. */
  async function stagePendingPlan(newStatus: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const planCode = 'AGENT-' + suffix;
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const planJson = {
      actions: [{
        action_id: 'set_tournament_status',
        params: setTournamentStatusParams.parse({
          tournament_id: 'tourn-1',
          new_status: newStatus,
          reason: 'audit fix regression',
        }),
        rationale: 'test',
        preview_summary: 'ubah status test',
      }],
    };
    await db.execute({
      sql: `INSERT INTO ai_action_plans
              (id, plan_code, tournament_id, organizer_address, organizer_delegate_id,
               instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, 'tourn-1', 'org-1@s.whatsapp.net', NULL, ?, ?, 'PENDING', ?, ?, ?)`,
      args: ['plan-' + suffix.toLowerCase(), planCode, 'audit fix regression', JSON.stringify(planJson), expires, now.toISOString(), now.toISOString()],
    });
    return planCode;
  }

  /**
   * Wrap the real client: when a statement whose SQL contains `marker` is
   * executed through the planner, `sideEffect` runs BEFORE (mode='before') or
   * AFTER (mode='after') the real statement — simulating a concurrent writer
   * racing the planner (another device, or the stale-recovery sweep).
   */
  function racingClient(marker: string, mode: 'before' | 'after', sideEffect: () => Promise<void>): Client {
    const wrapped = {
      execute: async (req: unknown): Promise<unknown> => {
        const sql = typeof req === 'string' ? req : String((req as { sql?: string }).sql ?? '');
        if (sql.includes(marker)) {
          if (mode === 'before') await sideEffect();
          const res = await db.execute(req as Parameters<Client['execute']>[0]);
          if (mode === 'after') await sideEffect();
          return res;
        }
        return db.execute(req as Parameters<Client['execute']>[0]);
      },
      transaction: (m: 'write' | 'read') => db.transaction(m),
    };
    return wrapped as unknown as Client;
  }

  // --- Bug 1: staleness basis must be updated_at (consistent with the sweep) ---

  it('BUG-1: EXECUTING plan confirmed 8 min after staging is NOT misclassified as stale', async () => {
    // created_at 8 min ago (> EXECUTING_STALE_MS of 5 min — the OLD created_at
    // basis would call this stale), updated_at 2 s ago (the EXECUTING
    // transition just happened). Correct behaviour: NOT stale.
    const now = new Date();
    await insertPlanRow({
      code: 'AGENT-FXA',
      status: 'EXECUTING',
      createdAt: new Date(now.getTime() - 8 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 2 * 1000),
      expiresAt: new Date(now.getTime() + 2 * 60 * 1000),
    });
    const res = await planner.confirmAndExecute('AGENT-FXA', 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('sedang EXECUTING');
    expect(res.responseText).not.toContain('Interrupted');
    expect(res.responseText).not.toContain('ditinggalkan di status EXECUTING');
    // The plan must NOT have been marked FAILED.
    const row = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: ['AGENT-FXA'] });
    expect(String((row.rows[0] as any).status)).toBe('EXECUTING');
    expect((row.rows[0] as any).failure_reason).toBeNull();
  });

  it('BUG-1 (counterpart): EXECUTING plan whose last transition is > 5 min old IS still recovered as FAILED', async () => {
    // created_at AND updated_at both 10 min ago — genuinely crashed
    // mid-execution. The stale-recovery path must keep working on the new basis.
    const now = new Date();
    await insertPlanRow({
      code: 'AGENT-FXB',
      status: 'EXECUTING',
      createdAt: new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const res = await planner.confirmAndExecute('AGENT-FXB', 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('ditinggalkan di status EXECUTING');
    const row = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: ['AGENT-FXB'] });
    expect(String((row.rows[0] as any).status)).toBe('FAILED');
    expect(String((row.rows[0] as any).failure_reason)).toContain('Interrupted');
  });

  // --- Bug 1b: the final EXECUTED update must be guarded on status='EXECUTING' ---

  it('BUG-1b: guarded EXECUTED update cannot overwrite a plan concurrently marked FAILED mid-execution', async () => {
    // Stage a real PENDING plan, then simulate a stale-recovery sweep marking
    // the plan FAILED right after the atomic claim lands (i.e. while the
    // transactional execution is still running).
    const code = await stagePendingPlan('DRAW_READY');
    const sweepReason = 'Interrupted: EXECUTING stale (simulated concurrent sweep)';
    let sweepDone = false;
    const racingDb = racingClient("SET status='EXECUTING'", 'after', async () => {
      if (sweepDone) return;
      sweepDone = true;
      await db.execute({
        sql: "UPDATE ai_action_plans SET status='FAILED', failure_reason=?, updated_at=? WHERE plan_code=? AND status='EXECUTING'",
        args: [sweepReason, new Date().toISOString(), code],
      });
    });
    const racingPlanner = new AgentPlannerService({ db: racingDb, actionCatalog: catalog });

    const res = await racingPlanner.confirmAndExecute(code, 'org-1@s.whatsapp.net');

    // The actions themselves DID execute and commit (honest success)...
    expect(res.success).toBe(true);
    expect(res.responseText).toContain('PLAN DIEKSEKUSI');
    // ...with an honest caveat about the concurrent status change:
    expect(res.responseText).toContain('TIDAK diubah ke EXECUTED');
    // The tournament data change really committed:
    const t = await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: ['tourn-1'] });
    expect(String((t.rows[0] as any).status)).toBe('DRAW_READY');

    // The core assertion: the concurrent FAILED status is NOT overwritten.
    const row = await db.execute({ sql: 'SELECT status, failure_reason, execution_result_json FROM ai_action_plans WHERE plan_code = ?', args: [code] });
    expect(String((row.rows[0] as any).status)).toBe('FAILED');
    expect(String((row.rows[0] as any).failure_reason)).toContain('Interrupted');
    expect((row.rows[0] as any).execution_result_json).toBeNull();

    // The audit trail still records the (real) successful execution honestly.
    const audit = await db.execute({ sql: 'SELECT event_type FROM audit_events WHERE entity_type = ?', args: ['AI_ACTION_PLAN'] });
    expect(audit.rows.length).toBe(1);
    expect(String((audit.rows[0] as any).event_type)).toBe('AI_AGENT_PLAN_EXECUTED');
  });

  // --- Bug 2: !agentcancel must check rowsAffected (TOCTOU) ---

  it('BUG-2: cancel raced by a concurrent confirm gets an honest "already executing" reply, NOT a false "cancelled"', async () => {
    // The plan is PENDING when cancelPlan reads it, but between that read and
    // the guarded UPDATE another device confirms it (PENDING -> EXECUTING).
    // The UPDATE then affects 0 rows; the old code still replied
    // "🗑️ Plan dibatalkan." — the organizer was lied to.
    const code = await stagePendingPlan('DRAW_READY');
    let raced = false;
    const racingDb = racingClient("SET status='CANCELLED'", 'before', async () => {
      if (raced) return;
      raced = true;
      await db.execute({
        sql: "UPDATE ai_action_plans SET status='EXECUTING', updated_at=? WHERE plan_code=? AND status='PENDING'",
        args: [new Date().toISOString(), code],
      });
    });
    const racingPlanner = new AgentPlannerService({ db: racingDb, actionCatalog: catalog });

    const res = await racingPlanner.cancelPlan(code, 'org-1@s.whatsapp.net');

    expect(res.success).toBe(false);
    expect(res.responseText).toContain('sudah mulai dieksekusi');
    expect(res.responseText).toContain('TIDAK jadi dibatalkan');
    expect(res.responseText).not.toContain('🗑️');
    // The plan is NOT cancelled in the DB:
    const row = await db.execute({ sql: 'SELECT status FROM ai_action_plans WHERE plan_code = ?', args: [code] });
    expect(String((row.rows[0] as any).status)).toBe('EXECUTING');
  });

  it('BUG-2 (variant): cancel raced to EXECUTED reports "already executed", plan stays EXECUTED', async () => {
    const code = await stagePendingPlan('DRAW_READY');
    let raced = false;
    const racingDb = racingClient("SET status='CANCELLED'", 'before', async () => {
      if (raced) return;
      raced = true;
      await db.execute({
        sql: "UPDATE ai_action_plans SET status='EXECUTED', executed_at=?, updated_at=? WHERE plan_code=? AND status='PENDING'",
        args: [new Date().toISOString(), new Date().toISOString(), code],
      });
    });
    const racingPlanner = new AgentPlannerService({ db: racingDb, actionCatalog: catalog });

    const res = await racingPlanner.cancelPlan(code, 'org-1@s.whatsapp.net');

    expect(res.success).toBe(false);
    expect(res.responseText).toContain('sudah selesai dieksekusi');
    expect(res.responseText).not.toContain('🗑️');
    const row = await db.execute({ sql: 'SELECT status FROM ai_action_plans WHERE plan_code = ?', args: [code] });
    expect(String((row.rows[0] as any).status)).toBe('EXECUTED');
  });

  it('BUG-2 (control): normal cancel of a genuinely PENDING plan still succeeds', async () => {
    const code = await stagePendingPlan('DRAW_READY');
    const res = await planner.cancelPlan(code, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(true);
    expect(res.responseText).toContain('dibatalkan');
    const row = await db.execute({ sql: 'SELECT status FROM ai_action_plans WHERE plan_code = ?', args: [code] });
    expect(String((row.rows[0] as any).status)).toBe('CANCELLED');
  });

  // --- Polish #4: markFailed must be status-guarded (cannot overwrite a terminal status) ---

  it('POLISH-4 (control): corrupt plan_json still marks an EXECUTING plan FAILED (normal path intact)', async () => {
    const planCode = 'AGENT-P4A';
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES ('plan-p4a', ?, 'org-1@s.whatsapp.net', 'corrupt test', 'this is not json', 'PENDING', ?, ?, ?)`,
      args: [planCode, expires, now.toISOString(), now.toISOString()],
    });
    const res = await planner.confirmAndExecute(planCode, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('korup');
    const row = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: [planCode] });
    expect(String((row.rows[0] as any).status)).toBe('FAILED');
    expect(String((row.rows[0] as any).failure_reason)).toContain('corrupt');
  });

  it('POLISH-4: markFailed guard never overwrites a concurrent terminal status (stays EXECUTED, not FAILED)', async () => {
    // Stage a PENDING plan with corrupt plan_json so confirmAndExecute takes the
    // markFailed path right after the atomic claim. A racing writer then moves
    // the plan to a terminal EXECUTED between the claim and markFailed — the
    // guarded markFailed (WHERE status='EXECUTING') must not overwrite it.
    const planCode = 'AGENT-P4B';
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO ai_action_plans (id, plan_code, organizer_address, instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES ('plan-p4b', ?, 'org-1@s.whatsapp.net', 'corrupt race test', 'this is not json', 'PENDING', ?, ?, ?)`,
      args: [planCode, expires, now.toISOString(), now.toISOString()],
    });
    let raced = false;
    const racingDb = racingClient("SET status='EXECUTING'", 'after', async () => {
      if (raced) return;
      raced = true;
      await db.execute({
        sql: "UPDATE ai_action_plans SET status='EXECUTED', executed_at=?, updated_at=? WHERE plan_code=? AND status='EXECUTING'",
        args: [new Date().toISOString(), new Date().toISOString(), planCode],
      });
    });
    const racingPlanner = new AgentPlannerService({ db: racingDb, actionCatalog: catalog });

    const res = await racingPlanner.confirmAndExecute(planCode, 'org-1@s.whatsapp.net');
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('korup');
    // The concurrent terminal status is NOT overwritten by markFailed:
    const row = await db.execute({ sql: 'SELECT status, failure_reason FROM ai_action_plans WHERE plan_code = ?', args: [planCode] });
    expect(String((row.rows[0] as any).status)).toBe('EXECUTED');
    expect((row.rows[0] as any).failure_reason).toBeNull();
  });
});

// =============================================================================
// QnaService
// =============================================================================

describe('QnaService (D-039)', () => {
  let db: Client;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('listEntries returns empty-state message when no entries', async () => {
    const svc = new QnaService({ db });
    const text = await svc.listEntries();
    expect(text).toContain('Belum ada');
    expect(text).toContain('!saveqna');
  });

  it('listEntries renders entries when present', async () => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO qna_entries (id, question, answer, category, created_by_organizer, is_active, created_at, updated_at)
            VALUES ('q-1', 'Kapan main?', 'Besok jam 8 malam.', 'jadwal', 1, 1, ?, ?)`,
      args: [now, now],
    });
    const svc = new QnaService({ db });
    const text = await svc.listEntries();
    expect(text).toContain('Kapan main?');
    expect(text).toContain('Besok jam 8 malam.');
    expect(text).toContain('jadwal');
  });

  it('extractAndSave returns graceful message when no messages captured yet', async () => {
    // Provide a fake router so the message-fetch path runs (and finds nothing).
    const fakeRouter: any = { execute: async () => ({ raw_text: '{"pairs":[]}', telemetry: {} }) };
    const svc = new QnaService({ db, providerRouter: fakeRouter });
    const res = await svc.extractAndSave({
      chatId: 'group-x@g.us',
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    });
    expect(res.success).toBe(false);
    expect(res.responseText.toLowerCase()).toContain('belum ada pesan');
  });

  it('extractAndSave without providerRouter returns AI-provider-missing message', async () => {
    const svc = new QnaService({ db });
    const res = await svc.extractAndSave({
      chatId: 'group-x@g.us',
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    });
    expect(res.success).toBe(false);
    expect(res.responseText).toContain('AI provider');
  });

  it('extractAndSave rate-guards rapid repeated calls', async () => {
    const fakeRouter: any = { execute: async () => ({ raw_text: '{"pairs":[]}', telemetry: {} }) };
    const svc = new QnaService({ db, providerRouter: fakeRouter });
    const args = {
      chatId: 'group-x@g.us',
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    };
    await svc.extractAndSave(args); // sets cooldown
    const r2 = await svc.extractAndSave(args);
    expect(r2.success).toBe(false);
    expect(r2.responseText).toContain('detik');
  });
});

// =============================================================================
// QnaService — audit polish regressions: real source_message_ids traceability
// + honest "Ditambahkan: N" counting (UNIQUE-skipped duplicates not inflated).
// =============================================================================

describe('QnaService audit-fix regressions (traceability + honest counting)', () => {
  let db: Client;
  const CHAT = 'group-x@g.us';

  beforeEach(async () => {
    db = await freshDb();
  });

  /** Insert one TEXT message into inbound_messages for the group window. */
  async function seedGroupMessage(id: string, sender: string, text: string, offsetMs: number): Promise<void> {
    const ts = new Date(Date.now() - 120_000 + offsetMs).toISOString();
    await db.execute({
      sql: `INSERT INTO inbound_messages
              (id, provider_message_key, chat_id, sender_raw_address, delegate_id,
               message_timestamp, received_at, message_type, text_body, caption,
               reply_to_key, report_session_id, raw_metadata_json, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, 'TEXT', ?, NULL, NULL, NULL, '{}', ?)`,
      args: [id, 'pmk-' + id, CHAT, sender, ts, ts, text, ts],
    });
  }

  it('POLISH-2: inserted Q&A stores real source_message_ids; hallucinated ids are dropped', async () => {
    await seedGroupMessage('msg-q1', '6281111111111@s.whatsapp.net', 'Kapan main ya?', 0);
    await seedGroupMessage('msg-a1', '6289999999999@s.whatsapp.net', 'Besok jam 8 malam.', 5_000);
    // AI returns one genuine pair citing the real ids PLUS a made-up id.
    const fakeRouter: any = {
      execute: async () => ({
        raw_text: JSON.stringify({
          pairs: [{
            question: 'Kapan main?',
            answer: 'Besok jam 8 malam.',
            category: 'jadwal',
            source_message_ids: ['msg-q1', 'msg-a1', 'totally-made-up-id'],
            duplicate_of_existing: false,
          }],
        }),
        telemetry: {},
      }),
    };
    const svc = new QnaService({ db, providerRouter: fakeRouter });
    const res = await svc.extractAndSave({
      chatId: CHAT,
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    });
    expect(res.success).toBe(true);
    expect(res.responseText).toContain('Ditambahkan ke FAQ: 1');
    const row = await db.execute({ sql: 'SELECT source_message_ids_json FROM qna_entries ORDER BY created_at DESC LIMIT 1' });
    const ids = JSON.parse(String((row.rows[0] as any).source_message_ids_json));
    expect(ids).toEqual(['msg-q1', 'msg-a1']); // made-up id filtered out
  });

  it('POLISH-2 (control): AI pairs without source_message_ids insert with empty array (back-compat)', async () => {
    await seedGroupMessage('msg-q2', '6281111111111@s.whatsapp.net', 'Aturan WO gimana?', 0);
    await seedGroupMessage('msg-a2', '6289999999999@s.whatsapp.net', 'Lawan no-show berarti kalah.', 5_000);
    const fakeRouter: any = {
      execute: async () => ({
        raw_text: JSON.stringify({
          pairs: [{ question: 'Aturan WO?', answer: 'Lawan no-show berarti kalah.', category: 'wo' }],
        }),
        telemetry: {},
      }),
    };
    const svc = new QnaService({ db, providerRouter: fakeRouter });
    const res = await svc.extractAndSave({
      chatId: CHAT,
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    });
    expect(res.success).toBe(true);
    const row = await db.execute({ sql: 'SELECT source_message_ids_json FROM qna_entries ORDER BY created_at DESC LIMIT 1' });
    expect(JSON.parse(String((row.rows[0] as any).source_message_ids_json))).toEqual([]);
  });

  it('POLISH-3: exact duplicate silently skipped by UNIQUE is NOT counted as inserted', async () => {
    // Pre-insert a Q&A pair the AI will fail to flag as duplicate.
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO qna_entries (id, question, answer, category, created_by_organizer, is_active, created_at, updated_at)
            VALUES ('q-pre', 'Kapan main?', 'Besok jam 8 malam.', 'jadwal', 1, 1, ?, ?)`,
      args: [now, now],
    });
    await seedGroupMessage('msg-q3', '6281111111111@s.whatsapp.net', 'Kapan main?', 0);
    await seedGroupMessage('msg-a3', '6289999999999@s.whatsapp.net', 'Besok jam 8 malam.', 5_000);
    await seedGroupMessage('msg-q4', '6282222222222@s.whatsapp.net', 'Bisa ganti karakter?', 10_000);
    await seedGroupMessage('msg-a4', '6289999999999@s.whatsapp.net', 'Nggak bisa, nickname terkunci.', 15_000);
    // Two pairs returned: the first is an EXACT duplicate of q-pre (not flagged
    // by the AI), the second is genuinely new.
    const fakeRouter: any = {
      execute: async () => ({
        raw_text: JSON.stringify({
          pairs: [
            {
              question: 'Kapan main?',
              answer: 'Besok jam 8 malam.',
              category: 'jadwal',
              source_message_ids: ['msg-q3', 'msg-a3'],
              duplicate_of_existing: false, // AI misses this one
            },
            {
              question: 'Bisa ganti karakter?',
              answer: 'Nggak bisa, nickname terkunci.',
              category: 'aturan',
              source_message_ids: ['msg-q4', 'msg-a4'],
              duplicate_of_existing: false,
            },
          ],
        }),
        telemetry: {},
      }),
    };
    const svc = new QnaService({ db, providerRouter: fakeRouter });
    const res = await svc.extractAndSave({
      chatId: CHAT,
      count: 10,
      organizerAddress: 'org-1@s.whatsapp.net',
      organizerDelegateId: null,
    });
    expect(res.success).toBe(true);
    // Only the genuinely new pair counts as inserted — not 2.
    expect(res.responseText).toContain('Ditambahkan ke FAQ: 1');
    expect(res.responseText).not.toContain('Ditambahkan ke FAQ: 2');
    // The silently skipped exact duplicate is reported, not hidden.
    expect(res.responseText).toContain('Duplikat persis');
    expect(res.responseText).toContain(': 1');
    // DB truth: exactly 2 rows (the pre-inserted one + the new one).
    const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM qna_entries' });
    expect(Number((count.rows[0] as any).n)).toBe(2);
  });
});

// =============================================================================
// OmakPeak context — LID contact flag (audit polish #7): a delegate whose only
// known WhatsApp identity is an internal @lid address must be flagged so the
// prompt never presents it as an actionable contact.
// =============================================================================

describe('OmakPeak context LID flag (audit polish #7)', () => {
  let db: Client;

  beforeEach(async () => {
    db = await freshDb();
    await seedTournamentFixture(db);
    const now = new Date().toISOString();
    // team-a's delegate has ONLY an internal LID identity (production reality).
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
            VALUES ('wi-a', 'del-a', '987654321098765@lid', 'LID', 1, ?)`,
      args: [now],
    });
    // team-b's delegate has a real phone-number JID.
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
            VALUES ('wi-b', 'del-b', '6281234567890@s.whatsapp.net', 'JID', 1, ?)`,
      args: [now],
    });
  });

  it('flags @lid identities as non-actionable, keeps real JIDs shareable', async () => {
    const ctx = await buildOmakPeakContext(db);
    const byTeam = new Map(ctx.teams_and_delegates.map((t) => [t.team_name, t]));
    const singa = byTeam.get('Singa FC')!;
    const elang = byTeam.get('Elang FC')!;
    expect(singa.delegate_whatsapp).toBe('987654321098765@lid');
    expect(singa.delegate_whatsapp_is_lid).toBe(true);
    expect(elang.delegate_whatsapp).toBe('6281234567890@s.whatsapp.net');
    expect(elang.delegate_whatsapp_is_lid).toBe(false);
  });

  it('the Omak Peak system prompt carries the @lid contact guidance', async () => {
    const ctx = await buildOmakPeakContext(db);
    const { system_prompt } = buildOmakPeakPrompt(ctx, 'kontak delegasi Singa FC dong');
    // The prompt must (a) mark LID-flagged delegates as NOT dialable contacts,
    // and (b) still allow sharing real phone-number contacts (D-037 norm).
    expect(system_prompt).toContain('delegate_whatsapp_is_lid');
    expect(system_prompt).toContain('@lid');
    expect(system_prompt).toContain('BOLEH dibagikan');
  });

  it('populates top_scorers, top_assists, top_defenders, and fixture scores when available', async () => {
    const now = new Date().toISOString();
    // Add player and game stats
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES ('p-striker-1', 'tourn-1', 'team-a', 'StrikerKing', 'StrikerKing', 'strikerking', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES ('fix-test-1', 'tourn-1', 'GROUP', 'ROUND_1', 'team-a', 'team-b', 'team-a', 'COMPLETED', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, is_walkover, evidence_status, created_at, updated_at)
            VALUES ('game-test-1', 'fix-test-1', 1, 'COMPLETED', 5, 2, 0, 'VERIFIED', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, version, created_at, updated_at)
            VALUES ('sess-test-1', 'fix-test-1', 'team-a', 'DRAFT_READY', ?, ?, 1, ?, ?)`,
      args: [now, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at)
            VALUES ('ver-test-1', 'sess-test-1', 'fix-test-1', 1, 'LOCKED', '{}', '{}', 'AI', 'SYSTEM', ?)`,
      args: [now],
    });
    await db.execute({
      sql: `INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, is_award_eligible, stats_json, source_report_version_id, created_at)
            VALUES ('pgs-test-1', 'game-test-1', 'p-striker-1', 'team-a', 10, 5, 2, 10, 15, 1, '{}', 'ver-test-1', ?)`,
      args: [now],
    });

    const ctx = await buildOmakPeakContext(db);
    expect(ctx.top_scorers).toBeDefined();
    expect(ctx.top_scorers?.length).toBeGreaterThan(0);
    expect(ctx.top_scorers?.[0].nickname).toBe('StrikerKing');
    expect(ctx.top_scorers?.[0].goals).toBe(5);

    expect(ctx.top_assists).toBeDefined();
    expect(ctx.top_assists?.[0].nickname).toBe('StrikerKing');
    expect(ctx.top_assists?.[0].assists).toBe(2);

    expect(ctx.top_defenders).toBeDefined();
    expect(ctx.top_defenders?.[0].nickname).toBe('StrikerKing');
    expect(ctx.top_defenders?.[0].defense).toBe(15);

    const f1 = ctx.today_fixtures.find((f) => f.fixture_id === 'fix-test-1');
    expect(f1).toBeDefined();
    expect(f1?.score).toBe('5 - 2');
    expect(f1?.status).toBe('COMPLETED');
  });

  it('populates team_rosters with active players grouped by team and includes it in prompt', async () => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES ('p-gk-1', 'tourn-1', 'team-a', 'SingaKeeper', 'SingaKeeper', 'singakeeper', 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', ?, ?),
                   ('p-sub-1', 'tourn-1', 'team-a', 'SingaSub', 'SingaSub', 'singasub', 'OUTFIELD', 6, 'SUBSTITUTE', 'ACTIVE', ?, ?)`,
      args: [now, now, now, now],
    });

    const ctx = await buildOmakPeakContext(db);
    expect(ctx.team_rosters).toBeDefined();
    expect(ctx.team_rosters?.length).toBeGreaterThan(0);

    const teamA = ctx.team_rosters?.find((t) => t.team_name === 'Singa FC');
    expect(teamA).toBeDefined();
    expect(teamA?.group_code).toBe('A');
    expect(teamA?.players.length).toBeGreaterThanOrEqual(2);

    const gk = teamA?.players.find((p) => p.nickname === 'SingaKeeper');
    expect(gk).toBeDefined();
    expect(gk?.position).toBe('GOALKEEPER');
    expect(gk?.roster_type).toBe('STARTER');

    const sub = teamA?.players.find((p) => p.nickname === 'SingaSub');
    expect(sub).toBeDefined();
    expect(sub?.position).toBe('OUTFIELD');
    expect(sub?.roster_type).toBe('SUBSTITUTE');

    const { system_prompt } = buildOmakPeakPrompt(ctx, 'roster Singa FC siapa aja');
    expect(system_prompt).toContain('team_rosters');
    expect(system_prompt).toContain('SingaKeeper');
    expect(system_prompt).toContain('SingaSub');
  });

  it('populates tournament schedule details (current_round, wib_now, host_team_name) and includes matchday instructions in prompt', async () => {
    const now = new Date().toISOString();
    // Mark MD1 completed so ROUND_2 becomes the active unfinished round
    await db.execute({
      sql: `UPDATE fixtures SET status = 'COMPLETED' WHERE id = 'fix-1'`,
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES ('fix-sched-1', 'tourn-1', 'GROUP', 'ROUND_2', 'team-a', 'team-b', 'team-a', 'SCHEDULED', ?, ?)`,
      args: [now, now],
    });

    const ctx = await buildOmakPeakContext(db);
    expect(ctx.tournament?.current_round_code).toBe('ROUND_2');
    expect(ctx.tournament?.current_round_label).toBe('Ronde 2');
    expect(ctx.tournament?.wib_now).toContain('WIB');
    expect(ctx.tournament?.cutoff_time).toBe('19:59 WIB');
    expect(ctx.tournament?.time_remaining_to_cutoff).toBeDefined();

    const fSched = ctx.today_fixtures.find((f) => f.fixture_id === 'fix-sched-1');
    expect(fSched).toBeDefined();
    expect(fSched?.round_code).toBe('ROUND_2');
    expect(fSched?.round_label).toBe('Ronde 2');
    expect(fSched?.host_team_name).toBe('Singa FC');
    expect(fSched?.is_current_round).toBe(true);

    const { system_prompt } = buildOmakPeakPrompt(ctx, 'nnti malam singa fc lawan siapa');
    expect(system_prompt).toContain('KETEPATAN WAKTU & JADWAL (MATCHDAY & FIXTURES)');
    expect(system_prompt).toContain('19:59 WIB');
    expect(system_prompt).toContain('JANGAN PERNAH bilang "jadwal belum dirilis" jika pertandingannya sudah tercatat di "today_fixtures"');
    expect(system_prompt).not.toContain('semua fixture scheduled_at null');
  });
});

// =============================================================================
// TriviaService
// =============================================================================

describe('TriviaService (D-040)', () => {
  it('loads the curated trivia DB and randomFact returns content', async () => {
    const svc = new TriviaService({}); // no providerRouter → raw fact path
    const text = await svc.randomFact();
    expect(text).toContain('TRIVIA FLASH PEAK');
    expect(text.length).toBeGreaterThan(50);
  });

  it('randomQuiz returns a question + answer pair', async () => {
    const svc = new TriviaService({});
    const res = await svc.randomQuiz();
    expect(res.success).toBe(true);
    expect(res.question).toBeTruthy();
    expect(res.answer).toBeTruthy();
  });

  it('includes Oscar easter egg and unpacked gameplay mechanics in trivia and quiz', async () => {
    const svc = new TriviaService({});
    const facts = (svc as any).data.facts as Array<{ id: string; category: string; fact: string }>;
    const quiz = (svc as any).data.quiz as Array<{ id: string; category: string; question: string; answer: string }>;

    expect(facts.length).toBeGreaterThanOrEqual(35);
    expect(quiz.length).toBeGreaterThanOrEqual(20);

    const oscarFact = facts.find((f) => f.id === 'fp-easteregg-oscar');
    expect(oscarFact).toBeDefined();
    expect(oscarFact?.fact).toContain('OSCAR');
    expect(oscarFact?.fact).toContain('Savage Dash');

    const oscarQuiz = quiz.find((q) => q.id === 'fp-quiz-oscar-hidden');
    expect(oscarQuiz).toBeDefined();
    expect(oscarQuiz?.answer).toContain('Oscar');
    expect(oscarQuiz?.answer).toContain('Savage Dash');

    const bargeFact = facts.find((f) => f.id === 'fp-combat-shoulder-barge');
    expect(bargeFact).toBeDefined();
    expect(bargeFact?.fact).toContain('Catastrophic Knockdown');
  });
});

// =============================================================================
// Migration 004 schema verification
// =============================================================================

describe('Migration 004 schema (D-037..D-040)', () => {
  let db: Client;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('ai_action_plans table exists with EXECUTING in CHECK', async () => {
    const res = await db.execute("SELECT sql FROM sqlite_master WHERE name = 'ai_action_plans'");
    const sql = String((res.rows[0] as any).sql);
    expect(sql).toContain('ai_action_plans');
    expect(sql).toContain('EXECUTING');
    expect(sql).toContain('plan_code');
  });

  it('qna_entries table exists with UNIQUE(question, answer)', async () => {
    const res = await db.execute("SELECT sql FROM sqlite_master WHERE name = 'qna_entries'");
    const sql = String((res.rows[0] as any).sql);
    expect(sql).toContain('qna_entries');
    expect(sql).toContain('UNIQUE(question, answer)');
  });

  it('provider_usage CHECK expanded to include CHAT_OMAK_PEAK', async () => {
    const res = await db.execute("SELECT sql FROM sqlite_master WHERE name = 'provider_usage'");
    const sql = String((res.rows[0] as any).sql);
    expect(sql).toContain('CHAT_OMAK_PEAK');
    expect(sql).toContain('PLAN_AGENT');
    expect(sql).toContain('EXTRACT_QNA');
  });

  it('populates flash_peak_game_knowledge into context and system prompt', async () => {
    const ctx = await buildOmakPeakContext(db);
    expect(ctx.game_knowledge).toBeDefined();
    expect(ctx.game_knowledge?.characters.length).toBe(13);

    const andrew = ctx.game_knowledge?.characters.find((c) => c.name === 'Andrew');
    expect(andrew).toBeDefined();
    expect(andrew?.role).toBe('CB');
    expect(andrew?.power).toBe(87);
    expect(andrew?.ultimate_skill.name).toContain('Super Tackle');
    expect(andrew?.ultimate_skill.range_or_duration).toContain('18.0');

    const ford = ctx.game_knowledge?.characters.find((c) => c.name === 'Ford');
    expect(ford).toBeDefined();
    expect(ford?.role).toBe('CB');
    expect(ford?.ultimate_skill.name).toContain('Super Block');

    const { system_prompt } = buildOmakPeakPrompt(ctx, 'kalau dikepung andrew ama ford gmn');
    expect(system_prompt).toContain('Andrew');
    expect(system_prompt).toContain('Ford');
    expect(system_prompt).toContain('Shoulder Barge');
    expect(system_prompt).toContain('dikepung_andrew_dan_ford');
    expect(system_prompt).toContain('Catastrophic Knockdown');
  });
});

// =============================================================================
// Interactive Quiz & Community Leaderboard tests
// =============================================================================

describe('Interactive Quiz & Community Leaderboard', () => {
  let db: Client;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('isQuizAnswerMatch correctly identifies matching keywords and phrases', () => {
    const keywords = ['oscar', 'savage dash', '1011', 'striker', '0.3', '0,3 detik', '1', '5'];

    // Single-word and number matches
    expect(isQuizAnswerMatch('oscar', keywords)).toBe(true);
    expect(isQuizAnswerMatch('Oscar!', keywords)).toBe(true);
    expect(isQuizAnswerMatch('jawabannya oscar min', keywords)).toBe(true);
    expect(isQuizAnswerMatch('striker', keywords)).toBe(true);
    expect(isQuizAnswerMatch('karakter 1011', keywords)).toBe(true);
    expect(isQuizAnswerMatch('1', keywords)).toBe(true);
    expect(isQuizAnswerMatch('5', keywords)).toBe(true);

    // Decimal numbers with dot and comma
    expect(isQuizAnswerMatch('0.3', keywords)).toBe(true);
    expect(isQuizAnswerMatch('0,3', keywords)).toBe(true);
    expect(isQuizAnswerMatch('0.3 detik', keywords)).toBe(true);
    expect(isQuizAnswerMatch('0,3 detik', keywords)).toBe(true);

    // Multi-word phrase matches
    expect(isQuizAnswerMatch('savage dash', keywords)).toBe(true);
    expect(isQuizAnswerMatch('itu savage dash bukan?', keywords)).toBe(true);

    // Non-matches
    expect(isQuizAnswerMatch('kelly', keywords)).toBe(false);
    expect(isQuizAnswerMatch('andrew', keywords)).toBe(false);
    expect(isQuizAnswerMatch('dash', keywords)).toBe(false); // only "savage dash" is in keywords
  });

  it('QuizSessionManager manages 15-second lifecycle and answer evaluation', async () => {
    const manager = new QuizSessionManager({ db, durationMs: 15_000 });
    const chatId = '12345@g.us';

    const testQuestion: QuizQuestion = {
      id: 'test-1',
      category: 'Combat Mechanics',
      question: 'Berapa meter jangkauan ultimate Super Tackle Andrew?',
      answer: '18 meter',
      keywords: ['18', '18 meter', '18m'],
    };

    let timeoutFired = false;
    const startRes = manager.startQuiz(chatId, testQuestion, async () => {
      timeoutFired = true;
    });

    expect(startRes.success).toBe(true);
    expect(manager.hasActiveQuiz(chatId)).toBe(true);
    expect(manager.getRemainingSeconds(chatId)).toBeGreaterThanOrEqual(14);

    // Concurrent quiz attempt is rejected
    const dupRes = manager.startQuiz(chatId, testQuestion, async () => {});
    expect(dupRes.success).toBe(false);

    // Incorrect answer evaluation
    const wrongEval = await manager.evaluateAnswer(chatId, '12 meter');
    expect(wrongEval.isAnswerToQuiz).toBe(true);
    expect(wrongEval.isCorrect).toBe(false);

    // Casual chatter / laughter is ignored (not treated as wrong answer attempt)
    const banterEval = await manager.evaluateAnswer(chatId, 'wkwkwk');
    expect(banterEval.isAnswerToQuiz).toBe(false);

    // Correct answer evaluation
    const correctEval = await manager.evaluateAnswer(chatId, '18 meter');
    expect(correctEval.isAnswerToQuiz).toBe(true);
    expect(correctEval.isCorrect).toBe(true);
    expect(correctEval.judgedBy).toBe('KEYWORD');

    // Cancel quiz on correct answer
    manager.cancelQuiz(chatId);
    expect(manager.hasActiveQuiz(chatId)).toBe(false);
    expect(timeoutFired).toBe(false);
  });

  it('records quiz wins and retrieves community leaderboard', async () => {
    const manager = new QuizSessionManager({ db, durationMs: 15_000 });
    const chatId = 'group-1@g.us';

    const score1 = await manager.recordWin(chatId, 'user1@s.whatsapp.net', 'Habibi');
    expect(score1).toBe(1);

    const score2 = await manager.recordWin(chatId, 'user1@s.whatsapp.net', 'Habibi');
    expect(score2).toBe(2);

    const scoreOther = await manager.recordWin(chatId, 'user2@s.whatsapp.net', 'Arya');
    expect(scoreOther).toBe(1);

    const leaderboard = await manager.getLeaderboard(chatId);
    expect(leaderboard.length).toBe(2);
    expect(leaderboard[0].participant_name).toBe('Habibi');
    expect(leaderboard[0].score).toBe(2);
    expect(leaderboard[1].participant_name).toBe('Arya');
    expect(leaderboard[1].score).toBe(1);

    const formatted = manager.formatLeaderboard(leaderboard);
    expect(formatted).toContain('LEADERBOARD KUIS FLASH PEAK');
    expect(formatted).toContain('Habibi');
    expect(formatted).toContain('2 Poin Kuis');
  });

  it('populates quiz_leaderboard into Omak Peak context', async () => {
    const manager = new QuizSessionManager({ db });
    await manager.recordWin('group-1@g.us', 'user1@s.whatsapp.net', 'Habibi Top Quiz');

    const ctx = await buildOmakPeakContext(db);
    expect(ctx.quiz_leaderboard).toBeDefined();
    expect(ctx.quiz_leaderboard?.length).toBeGreaterThanOrEqual(1);
    expect(ctx.quiz_leaderboard?.[0].participant_name).toBe('Habibi Top Quiz');
    expect(ctx.quiz_leaderboard?.[0].score).toBe(1);

    const { system_prompt } = buildOmakPeakPrompt(ctx, 'siapa raja kuis di grup ini');
    expect(system_prompt).toContain('quiz_leaderboard');
    expect(system_prompt).toContain('Habibi Top Quiz');
  });

  it('QuizSessionManager falls back to LLM semantic evaluation when keywords do not match', async () => {
    let mockLlmResponse = 'BENAR';
    const mockRouter = {
      execute: async () => ({
        raw_text: mockLlmResponse,
        model: 'mock-model',
        provider: 'MOCK',
        latency_ms: 100,
      }),
    } as any;

    const manager = new QuizSessionManager({ db, providerRouter: mockRouter, durationMs: 15_000 });
    const chatId = 'group-llm@g.us';

    const testQuestion: QuizQuestion = {
      id: 'test-llm',
      category: 'General',
      question: 'Satu pemain mengontrol berapa karakter dalam satu pertandingan?',
      answer: 'Satu karakter saja.',
      keywords: ['1', 'satu'],
    };

    manager.startQuiz(chatId, testQuestion, async () => {});

    // 1. Keyword match takes priority
    const kwEval = await manager.evaluateAnswer(chatId, '1');
    expect(kwEval.isCorrect).toBe(true);
    expect(kwEval.judgedBy).toBe('KEYWORD');

    // 2. Keyword does not match, LLM judges semantic answer as BENAR
    mockLlmResponse = 'BENAR';
    const llmEval = await manager.evaluateAnswer(chatId, 'hanya single individual player min');
    expect(llmEval.isCorrect).toBe(true);
    expect(llmEval.judgedBy).toBe('LLM');

    // 3. Keyword does not match, LLM judges casual banter as BUKAN_JAWABAN
    mockLlmResponse = 'BUKAN_JAWABAN';
    const banterEval = await manager.evaluateAnswer(chatId, 'wah seru banget');
    expect(banterEval.isAnswerToQuiz).toBe(false);
    expect(banterEval.isCorrect).toBe(false);

    // 4. Keyword does not match, LLM judges incorrect attempt as SALAH
    mockLlmResponse = 'SALAH';
    const wrongEval = await manager.evaluateAnswer(chatId, 'sebelas orang kayak fifa');
    expect(wrongEval.isAnswerToQuiz).toBe(true);
    expect(wrongEval.isCorrect).toBe(false);
    expect(wrongEval.judgedBy).toBe('LLM');

    manager.cancelQuiz(chatId);
  });
});
