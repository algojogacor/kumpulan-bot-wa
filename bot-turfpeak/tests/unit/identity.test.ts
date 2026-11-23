/**
 * Flash Peak TMS - Identity & Onboarding Unit Tests
 * 
 * Tests JID/LID alias linking, duplicate prevention, linked devices,
 * unauthorized sender rejection, and guided sequential onboarding state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  IdentityResolver,
  IdentityConflictError,
} from '../../src/identity/resolver.js';
import { OnboardingService } from '../../src/identity/onboarding.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';
import { randomUUID } from 'node:crypto';

describe('IdentityResolver', () => {
  let db: Client;
  let resolver: IdentityResolver;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    resolver = new IdentityResolver(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves an unregistered address as UNREGISTERED', async () => {
    const result = await resolver.resolveIdentity('6281234567890@s.whatsapp.net');

    expect(result.status).toBe('UNREGISTERED');
    expect(result.rawAddress).toBe('6281234567890@s.whatsapp.net');
    expect(result.addressType).toBe('JID');
    expect(result.delegate).toBeUndefined();
  });

  it('creates delegate and links primary identity', async () => {
    const { delegate, identity } = await resolver.createDelegateWithIdentity(
      'Captain Tsubasa',
      '628111222333@s.whatsapp.net',
      'JID',
      { sourceChatId: '120363000000000000@g.us' }
    );

    expect(delegate.id).toBeDefined();
    expect(delegate.display_name).toBe('Captain Tsubasa');
    expect(delegate.status).toBe('ACTIVE');

    expect(identity.delegate_id).toBe(delegate.id);
    expect(identity.raw_address).toBe('628111222333@s.whatsapp.net');
    expect(identity.is_primary).toBe(1);

    // Resolving should now return VERIFIED
    const resolved = await resolver.resolveIdentity('628111222333@s.whatsapp.net');
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.delegate?.id).toBe(delegate.id);
    expect(resolved.delegate?.display_name).toBe('Captain Tsubasa');
  });

  it('links linked-device variants (:1) to the same canonical identity without creating duplicates', async () => {
    const { delegate } = await resolver.createDelegateWithIdentity(
      'Hyuga Kojiro',
      '628999888777@s.whatsapp.net',
      'JID'
    );

    // Incoming message from linked companion device has suffix :1
    const companionAddress = '628999888777:1@s.whatsapp.net';
    const resolved = await resolver.resolveIdentity(companionAddress);

    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.delegate?.id).toBe(delegate.id);
    expect(resolved.normalizedAddress).toBe('628999888777@s.whatsapp.net');
  });

  it('links an LID alias to an existing delegate with JID', async () => {
    const { delegate } = await resolver.createDelegateWithIdentity(
      'Wakabayashi Genzo',
      '628555444333@s.whatsapp.net',
      'JID'
    );

    const lidAddress = '98765432101234@lid';
    const lidIdentity = await resolver.linkIdentity(delegate.id, lidAddress, 'LID');

    expect(lidIdentity.delegate_id).toBe(delegate.id);
    expect(lidIdentity.address_type).toBe('LID');

    // Resolving via LID should now return the same delegate
    const resolvedViaLid = await resolver.resolveIdentity(lidAddress);
    expect(resolvedViaLid.status).toBe('VERIFIED');
    expect(resolvedViaLid.delegate?.id).toBe(delegate.id);

    // Resolving via JID still returns the delegate
    const resolvedViaJid = await resolver.resolveIdentity('628555444333@s.whatsapp.net');
    expect(resolvedViaJid.status).toBe('VERIFIED');
    expect(resolvedViaJid.delegate?.id).toBe(delegate.id);
  });

  it('prevents linking an address already claimed by another delegate (conflict prevention)', async () => {
    const userA = await resolver.createDelegateWithIdentity(
      'Delegate A',
      '628100000001@s.whatsapp.net',
      'JID'
    );
    expect(userA.delegate.id).toBeDefined();

    const userB = await resolver.createDelegateWithIdentity(
      'Delegate B',
      '628100000002@s.whatsapp.net',
      'JID'
    );

    // Attempt to link User A's address to User B
    await expect(
      resolver.linkIdentity(userB.delegate.id, '628100000001@s.whatsapp.net', 'JID')
    ).rejects.toThrow(IdentityConflictError);
  });

  it('returns SUSPENDED if delegate has been suspended', async () => {
    const { delegate } = await resolver.createDelegateWithIdentity(
      'Suspended Player',
      '628777888999@s.whatsapp.net',
      'JID'
    );

    await db.execute({
      sql: `UPDATE delegates SET status = 'SUSPENDED' WHERE id = ?`,
      args: [delegate.id],
    });

    const resolved = await resolver.resolveIdentity('628777888999@s.whatsapp.net');
    expect(resolved.status).toBe('SUSPENDED');
    expect(resolved.delegate?.status).toBe('SUSPENDED');
  });
});

describe('OnboardingService (Sequential Team-by-Team State Machine)', () => {
  let db: Client;
  let resolver: IdentityResolver;
  let onboarding: OnboardingService;
  const tournamentId = randomUUID();

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    resolver = new IdentityResolver(db);
    onboarding = new OnboardingService(resolver, db);

    // Create tournament
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Flash Peak Season 1', 'ONBOARDING', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    // Seed pre-registered teams with multiple divisions per FR-ON-007
    // AVOID Eclipse, AVOID Prime, AVOID Impact are distinct teams!
    const teamsToInsert = [
      { id: randomUUID(), name: 'AVOID Eclipse', division: 'Eclipse', org: 'AVOID Clan' },
      { id: randomUUID(), name: 'AVOID Prime', division: 'Prime', org: 'AVOID Clan' },
      { id: randomUUID(), name: 'AVOID Impact', division: 'Impact', org: 'AVOID Clan' },
    ];

    for (const t of teamsToInsert) {
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, organization_name, division_name, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        args: [t.id, tournamentId, t.org, t.division, t.name, now, now],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  function createMockMessage(
    senderJid: string,
    replyToKey: string | null,
    text: string
  ): NormalizedMessage {
    return {
      id: randomUUID(),
      provider_message_key: `msg_${randomUUID()}`,
      chat_id: '120363000000000000@g.us',
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      address_type: senderJid.endsWith('@lid') ? 'LID' : 'JID',
      is_from_me: false,
      participant: senderJid,
      push_name: 'Delegate Representative',
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: text,
      caption: null,
      reply_to_key: replyToKey,
      quoted_participant: 'bot@s.whatsapp.net',
      quoted_text: 'Prompt text',
      raw_message: {} as any,
    };
  }

  it('prompts the first pending team sequentially', async () => {
    const prompt = await onboarding.getNextOnboardingPrompt(tournamentId);

    expect(prompt.status).toBe('PROMPT_READY');
    expect(prompt.team?.team_name).toBe('AVOID Eclipse');
    expect(prompt.pendingCount).toBe(3);
    expect(prompt.totalTeams).toBe(3);
    expect(prompt.promptText).toContain('AVOID Eclipse');
    expect(prompt.promptText).toContain('REPLY / BALAS');
  });

  it('rejects replies that do not quote the active prompt key (FR-ON-004 reply binding)', async () => {
    const prompt = await onboarding.getNextOnboardingPrompt(tournamentId);
    const promptMsgKey = 'prompt_msg_001';
    onboarding.setActivePrompt(tournamentId, prompt.team!.id, promptMsgKey);

    // Case 1: Sender does not reply to any message
    const msgWithoutReply = createMockMessage('6281234567801@s.whatsapp.net', null, 'Saya delegate Eclipse');
    const res1 = await onboarding.handleOnboardingReply(tournamentId, msgWithoutReply);
    expect(res1.status).toBe('INVALID_REPLY_CONTEXT');

    // Case 2: Sender replies to a different, wrong message
    const msgWithWrongReply = createMockMessage('6281234567801@s.whatsapp.net', 'some_other_msg_key', 'Saya siap');
    const res2 = await onboarding.handleOnboardingReply(tournamentId, msgWithWrongReply);
    expect(res2.status).toBe('INVALID_REPLY_CONTEXT');
  });

  it('verifies delegate and binds to team on exact prompt reply', async () => {
    const prompt1 = await onboarding.getNextOnboardingPrompt(tournamentId);
    const promptMsgKey = 'prompt_msg_001';
    onboarding.setActivePrompt(tournamentId, prompt1.team!.id, promptMsgKey);

    const validReply = createMockMessage('6281234567801@s.whatsapp.net', promptMsgKey, 'Saya kapten AVOID Eclipse');
    const result = await onboarding.handleOnboardingReply(tournamentId, validReply);

    expect(result.status).toBe('SUCCESS');
    expect(result.verifiedTeam?.team_name).toBe('AVOID Eclipse');
    expect(result.delegate?.id).toBeDefined();

    // Verify team in DB is now VERIFIED
    const dbTeam = await db.execute({
      sql: `SELECT registration_status, delegate_id FROM teams WHERE id = ?`,
      args: [prompt1.team!.id],
    });
    expect(dbTeam.rows[0]?.[0]).toBe('VERIFIED');
    expect(dbTeam.rows[0]?.[1]).toBe(result.delegate?.id);

    // Next prompt should automatically be the second team
    expect(result.nextPrompt?.status).toBe('PROMPT_READY');
    expect(result.nextPrompt?.team?.team_name).toBe('AVOID Impact'); // Alphabetical order after Eclipse
  });

  it('prevents one delegate from registering for multiple teams (FR-ID-002)', async () => {
    // 1. Register delegate for AVOID Eclipse
    const prompt1 = await onboarding.getNextOnboardingPrompt(tournamentId);
    const key1 = 'prompt_key_1';
    onboarding.setActivePrompt(tournamentId, prompt1.team!.id, key1);

    const sender = '6281234567899@s.whatsapp.net';
    const reply1 = createMockMessage(sender, key1, 'Ready 1');
    const res1 = await onboarding.handleOnboardingReply(tournamentId, reply1);
    expect(res1.status).toBe('SUCCESS');

    // 2. Now attempt to register the SAME sender for AVOID Impact
    const prompt2 = await onboarding.getNextOnboardingPrompt(tournamentId);
    const key2 = 'prompt_key_2';
    onboarding.setActivePrompt(tournamentId, prompt2.team!.id, key2);

    const reply2 = createMockMessage(sender, key2, 'Ready 2');
    const res2 = await onboarding.handleOnboardingReply(tournamentId, reply2);

    expect(res2.status).toBe('ALREADY_BOUND_ANOTHER_TEAM');
    expect(res2.responseText).toContain('Satu delegate hanya boleh mewakili satu tim');
  });

  it('completes onboarding when all teams are verified and updates tournament status', async () => {
    const senders = [
      '6281200000001@s.whatsapp.net',
      '6281200000002@s.whatsapp.net',
      '6281200000003@s.whatsapp.net',
    ];

    for (let i = 0; i < 3; i++) {
      const prompt = await onboarding.getNextOnboardingPrompt(tournamentId);
      expect(prompt.status).toBe('PROMPT_READY');

      const key = `prompt_key_${i}`;
      onboarding.setActivePrompt(tournamentId, prompt.team!.id, key);

      const reply = createMockMessage(senders[i]!, key, `Confirm team ${i}`);
      const res = await onboarding.handleOnboardingReply(tournamentId, reply);
      expect(res.status).toBe('SUCCESS');

      if (i === 2) {
        expect(res.isComplete).toBe(true);
      }
    }

    // Now calling getNextOnboardingPrompt should report COMPLETED
    const finalPrompt = await onboarding.getNextOnboardingPrompt(tournamentId);
    expect(finalPrompt.status).toBe('COMPLETED');
    expect(finalPrompt.verifiedCount).toBe(3);
    expect(finalPrompt.pendingCount).toBe(0);

    // Tournament status in DB should now be DRAW_READY
    const tCheck = await db.execute({
      sql: `SELECT status FROM tournaments WHERE id = ?`,
      args: [tournamentId],
    });
    expect(tCheck.rows[0]?.[0]).toBe('DRAW_READY');
  });

  it('is idempotent: repeated !onboarding resumes from current unverified team without resetting (FR-ON-006)', async () => {
    // Verify first team
    const prompt1 = await onboarding.getNextOnboardingPrompt(tournamentId);
    const key1 = 'prompt_key_1';
    onboarding.setActivePrompt(tournamentId, prompt1.team!.id, key1);

    await onboarding.handleOnboardingReply(
      tournamentId,
      createMockMessage('628111111111@s.whatsapp.net', key1, 'OK')
    );

    // Repeated call to getNextOnboardingPrompt
    const resumePrompt = await onboarding.getNextOnboardingPrompt(tournamentId);
    expect(resumePrompt.status).toBe('PROMPT_READY');
    expect(resumePrompt.verifiedCount).toBe(1);
    expect(resumePrompt.pendingCount).toBe(2);
    expect(resumePrompt.team?.team_name).not.toBe('AVOID Eclipse'); // Eclipse is already done
  });
});
