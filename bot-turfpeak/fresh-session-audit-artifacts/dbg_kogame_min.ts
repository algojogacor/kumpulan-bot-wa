// Debug why kogame photo fails
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/index.js';
import { ProviderRouter } from '../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../src/ai/adapter.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

const adapter: ProviderAdapter = {
  name: 'MOCK', model: 'm',
  capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
  healthCheck: async () => true,
  execute: async (req: AIRequest): Promise<AIResponse<unknown>> => {
    if (req.task === 'CLASSIFY') {
      const j = { screen_type: 'MAIN_MATCH_SUMMARY', confidence: 0.99, reason: 'mock', visual_features: [], uncertainties: [] };
      return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'CLASSIFY', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
    }
    if (req.task === 'EXTRACT_MATCH') {
      const j = { screen_type: 'MAIN_MATCH_SUMMARY', team_a_score: 2, team_b_score: 0, result_indicator: 'WIN', team_a_players: [], team_b_players: [], confidence: 0.99, unreadable_fields: [], uncertainties: [] };
      return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_MATCH', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
    }
    throw new Error('unhandled ' + req.task);
  },
} as unknown as ProviderAdapter;

const db = createClient({ url: 'file:fresh-session-audit-artifacts/dbg_ko.sqlite' });
await runMigrations(db);
const now = new Date().toISOString();
await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t1','X','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('a1','t1','Alpha','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('b1','t1','Beta','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES ('f1','t1','KNOCKOUT',NULL,'SEMI_FINAL','a1','b1','a1',NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO series (id,fixture_id,format,target_wins,status,winner_team_id,team_a_game_wins,team_b_game_wins,created_at,updated_at) VALUES ('s1','f1','BO3',2,'PENDING',NULL,0,0,?,?)`, args: [now, now] });

const app = createApp({ db, providerRouter: new ProviderRouter({ adapters: [adapter] }), organizerJid: '628999000001@s.whatsapp.net', centralGroupJid: 'g@g.us' });

const msg: NormalizedMessage = {
  id: randomUUID(), provider_message_key: randomUUID(), chat_id: 'g@g.us',
  sender_raw_address: '628999000001@s.whatsapp.net', sender_normalized_address: '628999000001@s.whatsapp.net',
  address_type: 'JID', is_from_me: false, participant: '628999000001@s.whatsapp.net', push_name: 'T',
  message_timestamp: now, received_at: now, message_type: 'IMAGE', text_body: null,
  caption: '!kogame', reply_to_key: null, quoted_participant: null, quoted_text: null,
  media_metadata: { mimetype: 'image/jpeg', fileName: 'x.jpg' } as any, raw_message: {} as any,
};
const res = await app.handleInboundMessage(msg, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1]));
console.log('RESULT:', JSON.stringify(res, null, 2).slice(0, 800));
db.close();
