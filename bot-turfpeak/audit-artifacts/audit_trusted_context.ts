import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { processClaimedBatch } from '../src/application/evidence-batch-processor.js';
import { MatchSummaryExtractor } from '../src/ai/extractors/match.js';
import { ProviderRouter } from '../src/ai/router.js';
import { ImageClassifier } from '../src/ai/classifier.js';
import { GoalkeeperDetailExtractor } from '../src/ai/extractors/goalkeeper.js';
import { randomUUID } from 'node:crypto';

async function main() {
  console.log('=== AUDIT TEST: FIX-CTX-001 (Trusted Context Propagation to matchExtractor) ===\n');

  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);

  const now = new Date().toISOString();
  const tourneyId = 'tourney-ctx-1';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
          VALUES (?, 'Context Test Cup', 'ACTIVE', '1.0', '{}', ?, ?)`,
    args: [tourneyId, now, now],
  });

  const teamAId = 'team-ctx-a';
  const teamBId = 'team-ctx-b';
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, 'Elang Mas FC', 'VERIFIED', ?, ?)`,
    args: [teamAId, tourneyId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, 'Harimau Putih FC', 'VERIFIED', ?, ?)`,
    args: [teamBId, tourneyId, now, now],
  });

  // Seed 5 players for Team A and 5 for Team B
  const teamAPlayers = ['EM | Captain', 'EM | Striker', 'EM | Midfielder', 'EM | Defender', 'EM | Keeper'];
  for (let i = 0; i < teamAPlayers.length; i++) {
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [`p-a-${i}`, tourneyId, teamAId, teamAPlayers[i], teamAPlayers[i], teamAPlayers[i].toLowerCase(), i === 4 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now],
    });
  }

  const teamBPlayers = ['HP | Leader', 'HP | Forward', 'HP | Center', 'HP | Back', 'HP | Goalie'];
  for (let i = 0; i < teamBPlayers.length; i++) {
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [`p-b-${i}`, tourneyId, teamBId, teamBPlayers[i], teamBPlayers[i], teamBPlayers[i].toLowerCase(), i === 4 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now],
    });
  }

  const fixtureId = 'fix-ctx-1';
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
          VALUES (?, ?, 'GROUP', 'R1', ?, ?, ?, 'SCHEDULED', ?, ?)`,
    args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
  });

  await db.execute({
    sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
          VALUES ('game-ctx-1', ?, 1, 'SCHEDULED', 'PENDING', ?, ?)`,
    args: [fixtureId, now, now],
  });

  const sessionId = 'session-ctx-1';
  await db.execute({
    sql: `INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, version, last_message_at, debounce_due_at, created_at, updated_at)
          VALUES (?, ?, ?, 'PROCESSING', 1, ?, ?, ?, ?)`,
    args: [sessionId, fixtureId, teamAId, now, now, now, now],
  });

  const assetId = 'asset-main-ctx';

  let capturedPrompt: string | undefined;
  let capturedTrustedContext: any;

  // Mock ProviderRouter
  const mockRouter = {
    execute: async (req: any) => {
      if (req.task === 'CLASSIFY') {
        const data = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          confidence: 0.99,
          reason: 'Valid match overview',
          visual_features: ['SCOREBOARD', 'PLAYER_TABLE'],
        };
        return { provider: 'GROQ', parsed_json: data, raw_output: JSON.stringify(data) };
      }
      if (req.task === 'EXTRACT_MATCH') {
        capturedPrompt = req.prompt;
        const data = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          confidence: 0.98,
          team_a_score: 2,
          team_b_score: 0,
          team_a_players: teamAPlayers.map((nick, idx) => ({
            nickname_raw: nick,
            goals: idx === 0 ? 2 : 0,
            assists: 0,
            passes: 10,
            defense: 2,
            rating: 7.5,
          })),
          team_b_players: teamBPlayers.map((nick) => ({
            nickname_raw: nick,
            goals: 0,
            assists: 0,
            passes: 8,
            defense: 3,
            rating: 6.5,
          })),
        };
        return { provider: 'GROQ', parsed_json: data, raw_output: JSON.stringify(data) };
      }
      return { provider: 'GROQ', parsed_json: {}, raw_output: '{}' };
    },
  } as unknown as ProviderRouter;

  const realMatchExtractor = new MatchSummaryExtractor(mockRouter);
  // Spy on realMatchExtractor.extract
  const origExtract = realMatchExtractor.extract.bind(realMatchExtractor);
  realMatchExtractor.extract = async (image: any, options: any) => {
    capturedTrustedContext = options?.trusted_context;
    return origExtract(image, options);
  };

  const classifier = new ImageClassifier(mockRouter);
  const gkExtractor = new GoalkeeperDetailExtractor(mockRouter);

  const mockMediaClient = {
    downloadMedia: async () => ({
      buffer: Buffer.from('fake-main-image-bytes'),
      media: { id: assetId, sha256_hash: 'abc', file_size: 100, role: 'MAIN_MATCH' },
    }),
  } as any;

  const batch = {
    session: {
      id: sessionId,
      fixture_id: fixtureId,
      submitting_team_id: teamAId,
      status: 'PROCESSING' as any,
      last_message_at: now,
      debounce_due_at: now,
      version: 1,
      extension_count: 0,
      created_at: now,
      updated_at: now,
    },
    mediaAssets: [
      {
        id: assetId,
        storage_provider: 'FLASHPEAK_VM_MEDIA' as any,
        storage_key: 'private/match_evidence/main.jpg',
        media_role: 'MAIN_MATCH' as any,
        mime_type: 'image/jpeg',
        byte_size: 100,
        sha256: 'abc',
        visibility: 'PRIVATE' as any,
        status: 'STORED' as any,
        source_message_id: 'msg-ctx-1',
        created_at: now,
      },
    ],
    messages: [
      {
        id: 'msg-ctx-1',
        provider_message_key: 'key-1',
        chat_id: '120363000000000001@g.us',
        sender_raw_address: '6281111111@s.whatsapp.net',
        message_timestamp: now,
        received_at: now,
        message_type: 'IMAGE' as any,
        caption: 'Match evidence',
        raw_metadata_json: '{}',
        created_at: now,
      },
    ],
  };

  const result = await processClaimedBatch(
    {
      db,
      mediaClient: mockMediaClient,
      providerRouter: mockRouter,
      classifier,
      matchExtractor: realMatchExtractor,
      gkExtractor,
      centralGroupJid: '120363000000000001@g.us',
    },
    batch
  );

  console.log('Result Status:', result.status);
  console.log('Captured Trusted Context:', JSON.stringify(capturedTrustedContext, null, 2));

  if (!capturedTrustedContext) {
    throw new Error('FAIL: trusted_context was NOT passed to matchExtractor.extract!');
  }

  if (capturedTrustedContext.team_a_name !== 'Elang Mas FC') {
    throw new Error(`FAIL: Expected team_a_name "Elang Mas FC", got "${capturedTrustedContext.team_a_name}"`);
  }
  if (capturedTrustedContext.team_b_name !== 'Harimau Putih FC') {
    throw new Error(`FAIL: Expected team_b_name "Harimau Putih FC", got "${capturedTrustedContext.team_b_name}"`);
  }
  if (!Array.isArray(capturedTrustedContext.expected_roster) || capturedTrustedContext.expected_roster.length !== 10) {
    throw new Error(`FAIL: Expected 10 roster players in expected_roster, got ${capturedTrustedContext.expected_roster?.length}`);
  }

  console.log('\nChecking prompt inclusion:');
  if (!capturedPrompt?.includes('Elang Mas FC') || !capturedPrompt?.includes('Harimau Putih FC')) {
    throw new Error('FAIL: AI Prompt does not contain team names from trusted context!');
  }
  if (!capturedPrompt?.includes('EM | Captain') || !capturedPrompt?.includes('HP | Leader')) {
    throw new Error('FAIL: AI Prompt does not contain player nicknames from trusted context!');
  }
  console.log('Prompt successfully grounded with trusted team names & player nicknames. (PASS)');

  console.log('\n=== AUDIT CONCLUSION: FIX-CTX-001 ===');
  console.log('ALL TRUSTED CONTEXT PROPAGATION TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
