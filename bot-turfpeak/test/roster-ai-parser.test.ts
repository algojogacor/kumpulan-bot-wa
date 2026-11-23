/**
 * Flash Peak TMS - Roster AI Parser & Fallback Unit Tests
 * 
 * Verifies:
 * 1. AI Roster Extractor (RosterExtractor & prompts)
 *    - Complex clan tags with pipe `AVO | Zenyth`, unicode `丨`, dagger `〆`, decorative glyphs
 *    - Formats without explicit INTI keywords (numbered 1-4, bullet points, informal chat text)
 *    - Prompt builder and Zod schema validation
 * 2. Deterministic Fallback Parser (parseRosterInput)
 *    - Never splits player names on pipes '|' or hyphens '-'
 *    - Preserves unicode glyphs (丨, 〆, ★, ・)
 *    - Line-based extraction and delimiter handling
 *    - Graceful fallback when INTI keyword is absent
 * 3. AI Outage & Fallback Integration
 *    - Gracefully recovers and uses deterministic parser if AI fails or throws
 *    - Operates when rosterExtractor is not configured in deps
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RosterExtractor } from '../src/ai/extractors/roster.js';
import {
  ROSTER_EXTRACTION_PROMPT,
  rosterExtractionOutputSchema,
} from '../src/ai/prompts/roster.js';
import {
  parseRosterInput,
  registerTournamentCommands,
  TournamentCommandDeps,
} from '../src/application/tournament-commands.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import type { NormalizedMessage } from '../src/whatsapp/normalizer.js';
import type { ProviderRouter } from '../src/ai/router.js';
import type { Client } from '@libsql/client';

function createMsg(text: string, sender = '628123456789@s.whatsapp.net'): NormalizedMessage {
  return {
    id: 'msg-001',
    provider_message_key: 'key-001',
    chat_id: '120363001@g.us',
    sender_raw_address: sender,
    sender_normalized_address: sender,
    address_type: 'JID',
    is_from_me: false,
    participant: sender,
    push_name: 'Tester',
    message_timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    message_type: 'TEXT',
    text_body: text,
    caption: null,
    reply_to_key: null,
    quoted_participant: null,
    quoted_text: null,
    raw_message: {} as any,
  };
}

describe('Roster AI Extractor & Parser Tests', () => {
  describe('1. AI Prompt & Schema Validation', () => {
    it('validates a complete output with clan tags containing pipe and unicode', () => {
      const mockAiOutput = {
        team_name: 'AVO Esports',
        gk_name: 'AVO | Zenyth',
        starter_list: [
          'AVO | Kyoma',
          'RRQ丨Lemon',
          '〆Dagger★Pro',
          'BTR・Ryzen',
        ],
        sub_list: ['Sub | Alpha', 'Cadangan丨Beta'],
        confidence: 0.98,
        uncertainties: [],
      };

      const parsed = rosterExtractionOutputSchema.parse(mockAiOutput);
      expect(parsed.team_name).toBe('AVO Esports');
      expect(parsed.gk_name).toBe('AVO | Zenyth');
      expect(parsed.starter_list).toHaveLength(4);
      expect(parsed.starter_list[0]).toBe('AVO | Kyoma');
      expect(parsed.starter_list[1]).toBe('RRQ丨Lemon');
      expect(parsed.starter_list[2]).toBe('〆Dagger★Pro');
      expect(parsed.starter_list[3]).toBe('BTR・Ryzen');
      expect(parsed.sub_list).toHaveLength(2);
    });

    it('buildUserPrompt encapsulates raw text within <message> delimiters', () => {
      const rawText = 'Daftar Roster AVO Esports\nGK: AVO | Zenyth';
      const prompt = ROSTER_EXTRACTION_PROMPT.buildUserPrompt(rawText);
      expect(prompt).toContain('<message>');
      expect(prompt).toContain(rawText);
      expect(prompt).toContain('</message>');
    });

    it('system prompt explicitly forbids splitting names on pipe characters', () => {
      expect(ROSTER_EXTRACTION_PROMPT.system_prompt).toContain("NEVER SPLIT A PLAYER NAME ON PIPE '|'");
      expect(ROSTER_EXTRACTION_PROMPT.system_prompt).toContain('AVO | Zenyth');
      expect(ROSTER_EXTRACTION_PROMPT.system_prompt).toContain('〆');
      expect(ROSTER_EXTRACTION_PROMPT.system_prompt).toContain('丨');
    });
  });

  describe('2. RosterExtractor with ProviderRouter Mock', () => {
    it('returns empty payload when input is empty string', async () => {
      const mockRouter = {
        execute: vi.fn(),
      } as unknown as ProviderRouter;

      const extractor = new RosterExtractor(mockRouter);
      const res = await extractor.extract('   ');

      expect(res.team_name).toBeNull();
      expect(res.gk_name).toBeNull();
      expect(res.starter_list).toEqual([]);
      expect(res.sub_list).toEqual([]);
      expect(res.confidence).toBe(0);
      expect(mockRouter.execute).not.toHaveBeenCalled();
    });

    it('correctly passes PARSE_ROSTER task and returns parsed output with clan tags', async () => {
      const expectedOutput = {
        team_name: 'Garuda Prime',
        gk_name: 'AVO | Zenyth',
        starter_list: [
          'GP | Razor',
          'GP | Shadow',
          'Alter丨Ego',
          '〆Hunter〆',
        ],
        sub_list: ['GP | Subs1', 'GP | Subs2'],
        confidence: 0.95,
        uncertainties: [],
      };

      const mockRouter = {
        execute: vi.fn().mockResolvedValue({
          provider: 'GROQ',
          model: 'llama-3.3-70b-versatile',
          latency_ms: 120,
          raw_text: JSON.stringify(expectedOutput),
          parsed_json: expectedOutput,
          attempts: 1,
        }),
      } as unknown as ProviderRouter;

      const extractor = new RosterExtractor(mockRouter);
      const res = await extractor.extract(`
        Daftar Roster Tim Garuda Prime
        GK: AVO | Zenyth
        Inti: GP | Razor, GP | Shadow, Alter丨Ego, 〆Hunter〆
        Cadangan: GP | Subs1, GP | Subs2
      `);

      expect(mockRouter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'PARSE_ROSTER',
          system_prompt: ROSTER_EXTRACTION_PROMPT.system_prompt,
        })
      );
      expect(res.team_name).toBe('Garuda Prime');
      expect(res.gk_name).toBe('AVO | Zenyth');
      expect(res.starter_list).toEqual([
        'GP | Razor',
        'GP | Shadow',
        'Alter丨Ego',
        '〆Hunter〆',
      ]);
      expect(res.sub_list).toEqual(['GP | Subs1', 'GP | Subs2']);
    });

    it('extracts rosters without explicit INTI keywords (numbered format)', async () => {
      const aiResponse = {
        team_name: 'Elang Sakti',
        gk_name: 'ES | Keeper (GK)',
        starter_list: ['ES | Striker', 'ES | Mid', 'ES | Winger', 'ES | Defender'],
        sub_list: ['ES | Sub1'],
        confidence: 0.9,
        uncertainties: [],
      };

      const mockRouter = {
        execute: vi.fn().mockResolvedValue({
          provider: 'GEMINI',
          model: 'gemini-2.5-flash',
          latency_ms: 250,
          raw_text: JSON.stringify(aiResponse),
          parsed_json: aiResponse,
          attempts: 1,
        }),
      } as unknown as ProviderRouter;

      const extractor = new RosterExtractor(mockRouter);
      const res = await extractor.extract(`
        Elang Sakti
        1. ES | Keeper (GK)
        2. ES | Striker
        3. ES | Mid
        4. ES | Winger
        5. ES | Defender
        Cadangan:
        - ES | Sub1
      `);

      expect(res.team_name).toBe('Elang Sakti');
      expect(res.starter_list).toHaveLength(4);
      expect(res.sub_list).toEqual(['ES | Sub1']);
    });
  });

  describe('3. Deterministic Fallback Parser (parseRosterInput)', () => {
    it('preserves pipe clan tags e.g. "AVO | Zenyth" and does not split names on pipe', () => {
      const raw = `
        Garuda FC
        GK: AVO | Zenyth
        Inti: RRQ | Lemon, ONIC | Sanz, EVOS | Clover, BTR | Ryzen
        Cadangan: Alter | Ego, Dewa | United
      `;

      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(true);
      expect(parsed.teamName).toBe('Garuda FC');
      expect(parsed.gkName).toBe('AVO | Zenyth');
      expect(parsed.starterList).toEqual([
        'RRQ | Lemon',
        'ONIC | Sanz',
        'EVOS | Clover',
        'BTR | Ryzen',
      ]);
      expect(parsed.subList).toEqual(['Alter | Ego', 'Dewa | United']);
    });

    it('preserves unicode characters like "丨" and dagger "〆"', () => {
      const raw = `
        Kiper: AVO丨Zenyth
        Inti: 〆Dagger〆, ★Star★, 么Master么, Player丨Four
        Cadangan: 彡Wind彡
      `;

      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(true);
      expect(parsed.gkName).toBe('AVO丨Zenyth');
      expect(parsed.starterList).toEqual([
        '〆Dagger〆',
        '★Star★',
        '么Master么',
        'Player丨Four',
      ]);
      expect(parsed.subList).toEqual(['彡Wind彡']);
    });

    it('handles format without explicit INTI keywords (GK followed by numbered lines)', () => {
      const raw = `
        Tim Nusantara
        GK: AVO | Zenyth
        1. Pemain Satu
        2. Pemain Dua
        3. Pemain Tiga
        4. Pemain Empat
        Cadangan:
        • Cadangan Satu
        • Cadangan Dua
      `;

      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(true);
      expect(parsed.gkName).toBe('AVO | Zenyth');
      expect(parsed.starterList).toEqual([
        'Pemain Satu',
        'Pemain Dua',
        'Pemain Tiga',
        'Pemain Empat',
      ]);
      expect(parsed.subList).toEqual(['Cadangan Satu', 'Cadangan Dua']);
    });

    it('handles informal Indonesian WhatsApp chat text', () => {
      const raw = `
        kipernya Ikyy | Safe
        pemain intinya Budi, Joko, Doni, Reza
        cadangannya Kevin, Rian
      `;

      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(true);
      expect(parsed.gkName).toBe('Ikyy | Safe');
      expect(parsed.starterList).toEqual(['Budi', 'Joko', 'Doni', 'Reza']);
      expect(parsed.subList).toEqual(['Kevin', 'Rian']);
    });

    it('cleans trailing (GK) or (Kiper) tag from gkName cleanly', () => {
      const raw = `
        GK: BTR | Ryzen (GK)
        Inti: P1, P2, P3, P4
      `;

      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(true);
      expect(parsed.gkName).toBe('BTR | Ryzen');
    });

    it('returns isRegistration: false when no registration keywords are present (view mode)', () => {
      const raw = 'Garuda FC';
      const parsed = parseRosterInput(raw);
      expect(parsed.isRegistration).toBe(false);
      expect(parsed.starterList).toEqual([]);
      expect(parsed.subList).toEqual([]);
    });
  });

  describe('4. AI Fallback Behavior in Tournament Commands', () => {
    let router: CommandRouter;
    let mockDb: Client;
    let mockDeps: TournamentCommandDeps;

    beforeEach(() => {
      const mockIdentityResolver = {
        resolveIdentity: vi.fn().mockResolvedValue({
          status: 'VERIFIED',
          delegate: { id: 'del-001', name: 'Captain Garuda', role: 'DELEGATE' },
          team: { id: 'team-999', name: 'Garuda FC' },
        }),
      };

      router = new CommandRouter({
        centralGroupJid: '120363001@g.us',
        organizerJid: '6289999999@s.whatsapp.net',
        identityResolver: mockIdentityResolver as any,
      });

      mockDb = {
        execute: vi.fn().mockImplementation(async (query: any) => {
          const sql = typeof query === 'string' ? query : query.sql;
          if (sql.includes('FROM tournaments')) {
            return {
              rows: [
                {
                  id: 'tourn-123',
                  name: 'Flash Peak Championship Season 1',
                },
              ],
            };
          }
          if (sql.includes('SELECT id, team_name, delegate_id FROM teams')) {
            return {
              rows: [
                {
                  id: 'team-999',
                  team_name: 'Garuda FC',
                  delegate_id: 'del-001',
                },
              ],
            };
          }
          if (sql.includes('SELECT id, role FROM delegates')) {
            return {
              rows: [
                {
                  id: 'del-001',
                  role: 'TEAM_DELEGATE',
                },
              ],
            };
          }
          if (sql.includes('SELECT id, nickname_raw FROM players')) {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO players')) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
      } as unknown as Client;

      mockDeps = {
        db: mockDb,
        identityResolver: mockIdentityResolver as any,
        onboardingService: {} as any,
        manualReportSession: {} as any,
        getStandingsTable: vi.fn(),
        submitApproval: vi.fn(),
        findVersionByMessageKey: vi.fn(),
      };
    });

    it('falls back to deterministic parser if AI extractor throws an error', async () => {
      const failingExtractor = {
        extract: vi.fn().mockRejectedValue(new Error('AI Provider Quota Exceeded')),
      } as unknown as RosterExtractor;

      registerTournamentCommands(router, {
        ...mockDeps,
        rosterExtractor: failingExtractor,
      });

      const res = await router.handleMessage(
        createMsg('!roster Garuda FC GK: AVO | Zenyth | Inti: Player1, Player2, Player3, Player4 | Cadangan: Sub1')
      );

      // Verification: Failing AI must not crash the command; it falls back to deterministic parser
      expect(failingExtractor.extract).toHaveBeenCalled();
      expect(res).toBeDefined();
      expect(res?.success).toBe(true);
      expect(res?.responseText).toContain('BERHASIL DIDAFTARKAN');
      expect(res?.responseText).toContain('AVO | Zenyth');
    });

    it('functions seamlessly when rosterExtractor is not configured in deps', async () => {
      registerTournamentCommands(router, {
        ...mockDeps,
        rosterExtractor: undefined,
      });

      const res = await router.handleMessage(
        createMsg('!roster Garuda FC GK: AVO | Zenyth | Inti: P1, P2, P3, P4')
      );

      expect(res).toBeDefined();
      expect(res?.success).toBe(true);
      expect(res?.responseText).toContain('BERHASIL DIDAFTARKAN');
      expect(res?.responseText).toContain('AVO | Zenyth');
    });

    it('uses AI extracted output when AI succeeds', async () => {
      const successfulExtractor = {
        extract: vi.fn().mockResolvedValue({
          team_name: 'Garuda FC',
          gk_name: 'AVO | Zenyth',
          starter_list: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
          sub_list: ['Sub 1'],
          confidence: 0.99,
          uncertainties: [],
        }),
      } as unknown as RosterExtractor;

      registerTournamentCommands(router, {
        ...mockDeps,
        rosterExtractor: successfulExtractor,
      });

      const res = await router.handleMessage(
        createMsg('!roster oi min daftarin tim Garuda FC kipernya AVO | Zenyth intinya Player 1, Player 2, Player 3, Player 4 cadangan Sub 1')
      );

      expect(successfulExtractor.extract).toHaveBeenCalled();
      expect(res).toBeDefined();
      expect(res?.success).toBe(true);
      expect(res?.responseText).toContain('BERHASIL DIDAFTARKAN');
      expect(res?.responseText).toContain('GARUDA FC');
      expect(res?.responseText).toContain('AVO | Zenyth');
    });

    it('rejects registration when substitutes exceed 3 players in Format 5+3 (kelebihan pemain)', async () => {
      registerTournamentCommands(router, mockDeps);

      const res = await router.handleMessage(
        createMsg('!roster Garuda FC GK: Kiper1 | Inti: P1, P2, P3, P4 | Cadangan: Sub1, Sub2, Sub3, Sub4')
      );

      expect(res).toBeDefined();
      expect(res?.success).toBe(false);
      expect(res?.responseText).toContain('kelebihan pemain');
      expect(res?.responseText).toContain('Maksimal pemain cadangan adalah 3 orang');
    });

    it('accepts registration with exactly 3 substitutes (Format 5+3: 8/8 players)', async () => {
      registerTournamentCommands(router, mockDeps);

      const res = await router.handleMessage(
        createMsg('!roster Garuda FC GK: Kiper1 | Inti: P1, P2, P3, P4 | Cadangan: Sub1, Sub2, Sub3')
      );

      expect(res).toBeDefined();
      expect(res?.success).toBe(true);
      expect(res?.responseText).toContain('BERHASIL DIDAFTARKAN');
      expect(res?.responseText).toContain('Pemain Cadangan (Slot 6–8)');
      expect(res?.responseText).toContain('Total Terdaftar: *8 / 8* pemain (Format 5+3)');
    });
  });
});
