import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  captureInboundMessage,
  getInboundMessagesBySession,
} from '../../src/ingestion/capture.js';
import {
  findOrCreateReportSession,
  attachMessageToSession,
  extendSession,
  expireStaleSessions,
  getReportSessionById,
} from '../../src/ingestion/session.js';
import {
  resetSessionDebounce,
  claimDebounceBatch,
  releaseDebounceLease,
  completeDebounceBatch,
  recoverOrphanedLeases,
  isDebounceReady,
} from '../../src/ingestion/debounce.js';

describe('Debounce, Ingestion Pipeline & Session Management', () => {
  let db: Client;
  const t0 = new Date('2026-11-18T10:00:00.000Z');

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);

    // Setup basic tournament, teams, and fixture fixtures for FK constraints
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
            VALUES ('tourney-1', 'Flash Peak Championship', 'ACTIVE', '1.0', '{}', '${t0.toISOString()}', '${t0.toISOString()}')`,
      args: [],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES ('team-a', 'tourney-1', 'Team Alpha', 'VERIFIED', '${t0.toISOString()}', '${t0.toISOString()}'),
                   ('team-b', 'tourney-1', 'Team Beta', 'VERIFIED', '${t0.toISOString()}', '${t0.toISOString()}')`,
      args: [],
    });

    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES ('del-a', 'Delegate Alpha', 'ACTIVE', '${t0.toISOString()}', '${t0.toISOString()}'),
                   ('del-b', 'Delegate Beta', 'ACTIVE', '${t0.toISOString()}', '${t0.toISOString()}')`,
      args: [],
    });

    await db.execute({
      sql: `INSERT INTO fixtures (
        id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
        scheduled_at, timezone, status, created_at, updated_at
      ) VALUES
      ('fix-1', 'tourney-1', 'GROUP', 'team-a', 'team-b', 'team-a', '${t0.toISOString()}', 'Asia/Jakarta', 'IN_PROGRESS', '${t0.toISOString()}', '${t0.toISOString()}'),
      ('fix-2', 'tourney-1', 'GROUP', 'team-b', 'team-a', 'team-b', '${t0.toISOString()}', 'Asia/Jakarta', 'IN_PROGRESS', '${t0.toISOString()}', '${t0.toISOString()}')`,
      args: [],
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('Deduplication via provider_message_key (FR-ING-006)', () => {
    it('captures message and detects duplicate on repeated provider_message_key', async () => {
      const first = await captureInboundMessage(db, {
        provider_message_key: 'wamid.1234567890',
        chat_id: 'central-tournament-group@g.us',
        sender_raw_address: '628111111111@s.whatsapp.net',
        delegate_id: 'del-a',
        message_timestamp: t0.toISOString(),
        message_type: 'TEXT',
        text_body: 'Halo bot match result',
      });

      expect(first.isDuplicate).toBe(false);
      expect(first.message.id).toBeDefined();
      expect(first.message.provider_message_key).toBe('wamid.1234567890');

      // Duplicate attempt with exact same key
      const duplicate = await captureInboundMessage(db, {
        provider_message_key: 'wamid.1234567890',
        chat_id: 'central-tournament-group@g.us',
        sender_raw_address: '628111111111@s.whatsapp.net',
        delegate_id: 'del-a',
        message_timestamp: t0.toISOString(),
        message_type: 'TEXT',
        text_body: 'Halo bot match result duplicate attempt',
      });

      expect(duplicate.isDuplicate).toBe(true);
      expect(duplicate.message.id).toBe(first.message.id);
      expect(duplicate.message.text_body).toBe('Halo bot match result'); // Preserves original
    });
  });

  describe('Per-Session 5-Second Sliding Quiet Window Debounce (FR-ING-002 / FR-ING-003)', () => {
    it('resets due time on each incoming message within 5s window and claims only after quiet window expires', async () => {
      // Message 1 at t0 -> session created
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });

      expect(session.debounce_due_at).toBe(new Date(t0.getTime() + 5000).toISOString());
      expect(session.version).toBe(1);

      const msg1 = await captureInboundMessage(db, {
        provider_message_key: 'msg-slide-1',
        chat_id: 'group@g.us',
        sender_raw_address: 'del-a@s.whatsapp.net',
        message_timestamp: t0.toISOString(),
        message_type: 'IMAGE',
        caption: 'Game 1 summary',
        report_session_id: session.id,
      });
      await attachMessageToSession(db, msg1.message.id, session.id);

      // Message 2 arrives at t0 + 2000ms -> slides window to (t0 + 2000) + 5000 = t0 + 7000ms
      const t1 = new Date(t0.getTime() + 2000);
      const updatedSess1 = await resetSessionDebounce(db, session.id, 5000, t1);
      expect(updatedSess1.debounce_due_at).toBe(new Date(t0.getTime() + 7000).toISOString());
      expect(updatedSess1.version).toBe(2);

      const msg2 = await captureInboundMessage(db, {
        provider_message_key: 'msg-slide-2',
        chat_id: 'group@g.us',
        sender_raw_address: 'del-a@s.whatsapp.net',
        message_timestamp: t1.toISOString(),
        message_type: 'IMAGE',
        caption: 'Game 1 detail',
        report_session_id: session.id,
      });
      await attachMessageToSession(db, msg2.message.id, session.id);

      // Message 3 arrives at t0 + 4000ms -> slides window to (t0 + 4000) + 5000 = t0 + 9000ms
      const t2 = new Date(t0.getTime() + 4000);
      const updatedSess2 = await resetSessionDebounce(db, session.id, 5000, t2);
      expect(updatedSess2.debounce_due_at).toBe(new Date(t0.getTime() + 9000).toISOString());
      expect(updatedSess2.version).toBe(3);

      const msg3 = await captureInboundMessage(db, {
        provider_message_key: 'msg-slide-3',
        chat_id: 'group@g.us',
        sender_raw_address: 'del-a@s.whatsapp.net',
        message_timestamp: t2.toISOString(),
        message_type: 'TEXT',
        text_body: 'GK detail',
        report_session_id: session.id,
      });
      await attachMessageToSession(db, msg3.message.id, session.id);

      // Check at t0 + 6000ms (original 5s passed, but sliding window is still pending at t0 + 9000ms)
      const tCheckPremature = new Date(t0.getTime() + 6000);
      const prematureClaim = await claimDebounceBatch(db, 'worker-1', 30000, tCheckPremature);
      expect(prematureClaim).toBeNull(); // Must not claim prematurely!

      // Check at t0 + 9001ms: 5s quiet window has elapsed since last message
      const tCheckReady = new Date(t0.getTime() + 9001);
      const readyClaim = await claimDebounceBatch(db, 'worker-1', 30000, tCheckReady);
      expect(readyClaim).not.toBeNull();
      expect(readyClaim!.session.id).toBe(session.id);
      expect(readyClaim!.session.status).toBe('PROCESSING');
      expect(readyClaim!.session.lease_owner).toBe('worker-1');
      expect(readyClaim!.messages.length).toBe(3);
      expect(readyClaim!.messages.map((m) => m.provider_message_key)).toEqual([
        'msg-slide-1',
        'msg-slide-2',
        'msg-slide-3',
      ]);
    });
  });

  describe('Concurrent Session Isolation', () => {
    it('verifies that messages for Team A reset ONLY Team A session, never Team B', async () => {
      // Session A for Fixture 1, Team A
      const { session: sessionA } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });

      // Session B for Fixture 2, Team B
      const { session: sessionB } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-2',
        submitting_team_id: 'team-b',
        now: t0,
      });

      expect(sessionA.debounce_due_at).toBe(new Date(t0.getTime() + 5000).toISOString());
      expect(sessionB.debounce_due_at).toBe(new Date(t0.getTime() + 5000).toISOString());

      // At t0 + 3000ms, Team A sends another message -> resets Session A to t0 + 8000ms
      const tTeamASecond = new Date(t0.getTime() + 3000);
      const updatedA = await resetSessionDebounce(db, sessionA.id, 5000, tTeamASecond);
      expect(updatedA.debounce_due_at).toBe(new Date(t0.getTime() + 8000).toISOString());

      // Session B MUST NOT be reset (must still be due at t0 + 5000ms)
      const currentB = await getReportSessionById(db, sessionB.id);
      expect(currentB!.debounce_due_at).toBe(new Date(t0.getTime() + 5000).toISOString());
      expect(currentB!.version).toBe(1);

      // At t0 + 5001ms: Team B session should be claimed, but Team A should NOT
      const tCheckB = new Date(t0.getTime() + 5001);
      const claimedB = await claimDebounceBatch(db, 'worker-1', 30000, tCheckB);
      expect(claimedB).not.toBeNull();
      expect(claimedB!.session.id).toBe(sessionB.id);

      // At t0 + 5001ms, another claim attempt returns null because Team A is not due yet
      const claimedNone = await claimDebounceBatch(db, 'worker-1', 30000, tCheckB);
      expect(claimedNone).toBeNull();

      // At t0 + 8001ms: Team A session is now due and claimed
      const tCheckA = new Date(t0.getTime() + 8001);
      const claimedA = await claimDebounceBatch(db, 'worker-1', 30000, tCheckA);
      expect(claimedA).not.toBeNull();
      expect(claimedA!.session.id).toBe(sessionA.id);
    });
  });

  describe('Late Evidence Handling (FR-ING-007)', () => {
    it('attaches late evidence to existing open session without creating duplicate report', async () => {
      // 1. Initial report submission
      const { session, isNew: isFirstNew } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });
      expect(isFirstNew).toBe(true);

      const msg1 = await captureInboundMessage(db, {
        provider_message_key: 'msg-initial',
        chat_id: 'group@g.us',
        sender_raw_address: 'del-a@s.whatsapp.net',
        message_timestamp: t0.toISOString(),
        message_type: 'IMAGE',
        caption: 'Match result',
      });
      await attachMessageToSession(db, msg1.message.id, session.id);

      // 2. Late evidence arrives 2 minutes later while session is still active
      const tLate = new Date(t0.getTime() + 2 * 60 * 1000);
      const { session: lateSession, isNew: isLateNew } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: tLate,
      });

      expect(isLateNew).toBe(false);
      expect(lateSession.id).toBe(session.id); // Reuses exact same session

      const msgLate = await captureInboundMessage(db, {
        provider_message_key: 'msg-late-gk',
        chat_id: 'group@g.us',
        sender_raw_address: 'del-a@s.whatsapp.net',
        message_timestamp: tLate.toISOString(),
        message_type: 'IMAGE',
        caption: 'Late GK screenshot',
      });
      await attachMessageToSession(db, msgLate.message.id, session.id);

      // Verify all messages are attached to the same single session
      const messages = await getInboundMessagesBySession(db, session.id);
      expect(messages.length).toBe(2);
      expect(messages.map((m) => m.provider_message_key)).toEqual(['msg-initial', 'msg-late-gk']);
    });
  });

  describe('Session Expiry & Strict 3x Extension Cap (FR-ING-008 / D-033)', () => {
    it('allows up to 3 extensions, rejects the 4th, and flags for organizer review', async () => {
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        baseExpiryWindowMs: 10 * 60 * 1000, // 10 min
        now: t0,
      });

      expect(session.extension_count).toBe(0);

      // 1st Extension
      const ext1 = await extendSession(db, session.id, 5 * 60 * 1000, t0);
      expect(ext1.extended).toBe(true);
      expect(ext1.extensionCount).toBe(1);
      expect(ext1.requiresOrganizerReview).toBe(false);

      // 2nd Extension
      const ext2 = await extendSession(db, session.id, 5 * 60 * 1000, t0);
      expect(ext2.extended).toBe(true);
      expect(ext2.extensionCount).toBe(2);
      expect(ext2.requiresOrganizerReview).toBe(false);

      // 3rd Extension
      const ext3 = await extendSession(db, session.id, 5 * 60 * 1000, t0);
      expect(ext3.extended).toBe(true);
      expect(ext3.extensionCount).toBe(3);
      expect(ext3.requiresOrganizerReview).toBe(false);

      // 4th Extension (Exceeds strict 3x cap!)
      const ext4 = await extendSession(db, session.id, 5 * 60 * 1000, t0);
      expect(ext4.extended).toBe(false);
      expect(ext4.extensionCount).toBe(3);
      expect(ext4.reason).toBe('MAX_EXTENSIONS_EXCEEDED');
      expect(ext4.requiresOrganizerReview).toBe(true);
    });

    it('marks stale expired sessions as EXPIRED when sweeping', async () => {
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        baseExpiryWindowMs: 10 * 60 * 1000, // 10 min
        now: t0,
      });

      // Sweep before expiry -> 0 expired
      const expiredBefore = await expireStaleSessions(db, new Date(t0.getTime() + 5 * 60 * 1000));
      expect(expiredBefore).toBe(0);

      // Sweep after expiry (at t0 + 11 min) -> 1 expired
      const expiredAfter = await expireStaleSessions(db, new Date(t0.getTime() + 11 * 60 * 1000));
      expect(expiredAfter).toBe(1);

      const refreshed = await getReportSessionById(db, session.id);
      expect(refreshed!.status).toBe('EXPIRED');
    });
  });

  describe('Atomic Batch Claim & Optimistic Versioning (FR-ING-005)', () => {
    it('prevents dual worker claims on the same batch via atomic claim lease', async () => {
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });

      const tReady = new Date(t0.getTime() + 6000);

      // Worker 1 claims
      const claim1 = await claimDebounceBatch(db, 'worker-1', 30000, tReady);
      expect(claim1).not.toBeNull();
      expect(claim1!.session.lease_owner).toBe('worker-1');

      // Worker 2 attempts concurrent claim on the same batch
      const claim2 = await claimDebounceBatch(db, 'worker-2', 30000, tReady);
      expect(claim2).toBeNull(); // Rejected: already leased
    });

    it('releases and completes batch leases properly', async () => {
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });

      const tReady = new Date(t0.getTime() + 6000);
      const claim = await claimDebounceBatch(db, 'worker-1', 30000, tReady);
      expect(claim).not.toBeNull();

      // Complete batch -> status = DRAFT_READY, lease cleared
      await completeDebounceBatch(db, session.id, 'DRAFT_READY');

      const finished = await getReportSessionById(db, session.id);
      expect(finished!.status).toBe('DRAFT_READY');
      expect(finished!.lease_owner).toBeNull();
      expect(finished!.lease_expires_at).toBeNull();
    });
  });

  describe('Restart Safety & Orphaned Lease Recovery', () => {
    it('recovers all PROCESSING sessions at boot, including leases still nominally alive (FIX2-LEASE-001)', async () => {
      const { session } = await findOrCreateReportSession(db, {
        fixture_id: 'fix-1',
        submitting_team_id: 'team-a',
        now: t0,
      });

      // Worker 1 claims with 30s lease
      const tReady = new Date(t0.getTime() + 6000);
      const claim = await claimDebounceBatch(db, 'crashed-worker', 30000, tReady);
      expect(claim).not.toBeNull();

      // At t0 + 20s (lease nominally still valid): boot-time recovery frees the
      // session immediately — the old worker is gone by definition at restart,
      // so waiting for lease expiry would only stall the pipeline ~30s.
      const tBoot = new Date(t0.getTime() + 20000);
      const recoveredEarly = await recoverOrphanedLeases(db, tBoot);
      expect(recoveredEarly).toBe(1);

      // Session is reset to COLLECTING and can be claimed by the new worker
      const reClaimed = await claimDebounceBatch(db, 'new-worker', 30000, tBoot);
      expect(reClaimed).not.toBeNull();
      expect(reClaimed!.session.lease_owner).toBe('new-worker');
      expect(reClaimed!.session.status).toBe('PROCESSING');
    });
  });
});
