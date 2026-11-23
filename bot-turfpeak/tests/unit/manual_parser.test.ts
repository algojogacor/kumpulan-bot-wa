import { describe, it, expect } from 'vitest';
import {
  parseScorerList,
  parseQuickReport,
  matchScorerToRoster,
  buildLineupWithScorers,
} from '../../src/reports/manual-parser.js';
import type { Player } from '../../src/shared/types/index.js';

describe('Manual Report Parser & Scorer Matcher (Unit Tests)', () => {
  describe('parseScorerList', () => {
    it('parses comma-separated scorers with 1 goal each', () => {
      const res = parseScorerList('Bunny, Razorr');
      expect(res).toEqual([
        { name: 'Bunny', goals: 1 },
        { name: 'Razorr', goals: 1 },
      ]);
    });

    it('parses scorers with parentheses count', () => {
      const res = parseScorerList('Bunny (2), Razorr (1)');
      expect(res).toEqual([
        { name: 'Bunny', goals: 2 },
        { name: 'Razorr', goals: 1 },
      ]);
    });

    it('parses scorers with x multiplier count', () => {
      const res = parseScorerList('Bunny x3, Razorr 2x');
      expect(res).toEqual([
        { name: 'Bunny', goals: 3 },
        { name: 'Razorr', goals: 2 },
      ]);
    });

    it('consolidates duplicates', () => {
      const res = parseScorerList('Bunny, Bunny, Razorr');
      expect(res).toEqual([
        { name: 'Bunny', goals: 2 },
        { name: 'Razorr', goals: 1 },
      ]);
    });

    it('returns empty array on empty input', () => {
      expect(parseScorerList('')).toEqual([]);
      expect(parseScorerList('   ')).toEqual([]);
    });
  });

  describe('parseQuickReport', () => {
    it('parses multiline command with gol A: and gol B:', () => {
      const input = `fix-001 2-1
gol A: Bunny, Razorr
gol B: Ikyy`;
      const res = parseQuickReport(input);
      expect(res.success).toBe(true);
      expect(res.data?.fixtureId).toBe('fix-001');
      expect(res.data?.scoreA).toBe(2);
      expect(res.data?.scoreB).toBe(1);
      expect(res.data?.hasExplicitScorers).toBe(true);
      expect(res.data?.rawScorersA).toEqual([
        { name: 'Bunny', goals: 1 },
        { name: 'Razorr', goals: 1 },
      ]);
      expect(res.data?.rawScorersB).toEqual([
        { name: 'Ikyy', goals: 1 },
      ]);
    });

    it('parses single-line command with A: and B:', () => {
      const input = 'fix-002 3-0 A: Bunny (2), Razorr B:';
      const res = parseQuickReport(input);
      expect(res.success).toBe(true);
      expect(res.data?.fixtureId).toBe('fix-002');
      expect(res.data?.scoreA).toBe(3);
      expect(res.data?.scoreB).toBe(0);
      expect(res.data?.hasExplicitScorers).toBe(true);
      expect(res.data?.rawScorersA).toEqual([
        { name: 'Bunny', goals: 2 },
        { name: 'Razorr', goals: 1 },
      ]);
      expect(res.data?.rawScorersB).toEqual([]);
    });

    it('parses space-separated score format', () => {
      const input = 'fix-003 2 1 A: Bunny, Razorr B: Ikyy Catatan: seru';
      const res = parseQuickReport(input);
      expect(res.success).toBe(true);
      expect(res.data?.fixtureId).toBe('fix-003');
      expect(res.data?.scoreA).toBe(2);
      expect(res.data?.scoreB).toBe(1);
      expect(res.data?.notes).toBe('seru');
    });

    it('parses fallback format without any scorers list', () => {
      const input = 'fix-004 2-1 Diinput manual panitia';
      const res = parseQuickReport(input);
      expect(res.success).toBe(true);
      expect(res.data?.fixtureId).toBe('fix-004');
      expect(res.data?.scoreA).toBe(2);
      expect(res.data?.scoreB).toBe(1);
      expect(res.data?.hasExplicitScorers).toBe(false);
      expect(res.data?.notes).toBe('Diinput manual panitia');
    });

    it('rejects invalid score formats', () => {
      const res = parseQuickReport('fix-005 abc');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Format skor tidak dikenali');
    });
  });

  describe('matchScorerToRoster', () => {
    const mockRoster: Player[] = [
      {
        id: 'p-1',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'AVO | Bunny',
        nickname_nfc: 'AVO | Bunny',
        nickname_search_key: 'avo | bunny',
        position: 'OUTFIELD',
        roster_slot: 1,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-2',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'HX · Razorr',
        nickname_nfc: 'HX · Razorr',
        nickname_search_key: 'hx · razorr',
        position: 'OUTFIELD',
        roster_slot: 2,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-3',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'AVO | lkyy.✘',
        nickname_nfc: 'AVO | lkyy.✘',
        nickname_search_key: 'avo | lkyy.✘',
        position: 'OUTFIELD',
        roster_slot: 3,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-gk',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'AVO | KingGK',
        nickname_nfc: 'AVO | KingGK',
        nickname_search_key: 'avo | kinggk',
        position: 'GOALKEEPER',
        roster_slot: 4,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-5',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'AVO | Striker',
        nickname_nfc: 'AVO | Striker',
        nickname_search_key: 'avo | striker',
        position: 'OUTFIELD',
        roster_slot: 5,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
    ];

    it('matches exact name with clan tag', () => {
      const match = matchScorerToRoster('AVO | Bunny', mockRoster);
      expect(match.player?.id).toBe('p-1');
      expect(match.similarity).toBe(1.0);
    });

    it('matches clan-tag stripped name ("Bunny" -> "AVO | Bunny")', () => {
      const match = matchScorerToRoster('Bunny', mockRoster);
      expect(match.player?.id).toBe('p-1');
      expect(match.similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('matches clan-tag stripped name ("Razorr" -> "HX · Razorr")', () => {
      const match = matchScorerToRoster('Razorr', mockRoster);
      expect(match.player?.id).toBe('p-2');
      expect(match.similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('matches nickname with special symbol and typo ("Ikyy" -> "AVO | lkyy.✘")', () => {
      const match = matchScorerToRoster('Ikyy', mockRoster);
      expect(match.player?.id).toBe('p-3');
      expect(match.similarity).toBeGreaterThanOrEqual(0.7);
    });

    it('returns error when name is not in roster', () => {
      const match = matchScorerToRoster('NonExistentPlayer', mockRoster);
      expect(match.player).toBeNull();
      expect(match.error).toContain('Tidak ada pemain di roster');
    });
  });

  describe('buildLineupWithScorers', () => {
    const mockRoster: Player[] = [
      {
        id: 'p-gk',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'TeamGK',
        nickname_nfc: 'TeamGK',
        nickname_search_key: 'teamgk',
        position: 'GOALKEEPER',
        roster_slot: 1,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-out-1',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'Striker1',
        nickname_nfc: 'Striker1',
        nickname_search_key: 'striker1',
        position: 'OUTFIELD',
        roster_slot: 2,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-out-2',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'Striker2',
        nickname_nfc: 'Striker2',
        nickname_search_key: 'striker2',
        position: 'OUTFIELD',
        roster_slot: 3,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-out-3',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'Midfielder',
        nickname_nfc: 'Midfielder',
        nickname_search_key: 'midfielder',
        position: 'OUTFIELD',
        roster_slot: 4,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p-out-4',
        tournament_id: 't-1',
        team_id: 'team-1',
        nickname_raw: 'Defender',
        nickname_nfc: 'Defender',
        nickname_search_key: 'defender',
        position: 'OUTFIELD',
        roster_slot: 5,
        roster_type: 'STARTER',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
    ];

    it('correctly maps goals to matched outfield scorers', () => {
      const res = buildLineupWithScorers(
        mockRoster,
        [
          { playerId: 'p-out-1', goals: 2 },
          { playerId: 'p-out-2', goals: 1 },
        ],
        1,
        false
      );

      expect(res.error).toBeUndefined();
      expect(res.lineup.length).toBe(5);

      const s1 = res.lineup.find((p) => p.player_id === 'p-out-1');
      const s2 = res.lineup.find((p) => p.player_id === 'p-out-2');
      const gk = res.lineup.find((p) => p.player_id === 'p-gk');
      const mid = res.lineup.find((p) => p.player_id === 'p-out-3');

      expect(s1?.goals).toBe(2);
      expect(s2?.goals).toBe(1);
      expect(gk?.goals).toBe(0);
      expect(gk?.defense_raw).toBe(1);
      expect(gk?.goalkeeper_saves).toBe(1);
      expect(mid?.goals).toBe(0);
    });

    it('sets all player goals to 0 when allowUnassigned is true', () => {
      const res = buildLineupWithScorers(mockRoster, [], 0, true);
      expect(res.error).toBeUndefined();
      expect(res.lineup.length).toBe(5);
      for (const p of res.lineup) {
        expect(p.goals).toBe(0);
      }
    });
  });
});
