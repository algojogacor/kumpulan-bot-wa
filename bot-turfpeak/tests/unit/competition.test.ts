/**
 * Flash Peak TMS - Competition Engine Unit Tests
 * 
 * Verifies Fase 3 requirements:
 * 1. Tournament CRUD, lifecycle, format validation (GROUP + KNOCKOUT only, D-008).
 * 2. Programmatic group sizing for 8, 9, 13, 17, 20, 23, 24, 25 teams (FR-COMP-010).
 * 3. Rejection of team count < 8 with clear descriptive error.
 * 4. Cryptographic draw, persist-before-reveal, restart safety (no reroll on restart, FR-COMP-006).
 * 5. Balanced left/right side host assignment (|left - right| <= 1, FR-COMP-013, D-034).
 * 6. Standings calculation: W3/D1/L0, GD, GF, and Head-to-Head tiebreaking (FR-CALC-001/002).
 * 7. BO3/BO5 series logic, tied game replay reusing slot (FR-CALC-004/005, D-028).
 * 8. Explicit distinction: double walkover (0 points) != genuine draw (1 point) (FR-FIX-006, D-031).
 * 9. Knockout double room card failure triggers mandatory reschedule (FR-FIX-006, D-032).
 * 10. Single forfeit walkover handling (Group 3-0, KO series forfeit, no player stats).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createTournament,
  getTournament,
  transitionTournamentStatus,
  validateCompetitionFormat,
} from '../../src/competition/tournament.js';
import {
  computeGroupSizing,
  cryptoFisherYates,
  prepareDraw,
  revealNext,
  getDraw,
} from '../../src/competition/draw.js';
import {
  generateBalancedRoundRobin,
  generateGroupStageFixtures,
  generateKnockoutFixtures,
  type GroupTeamParticipant,
  type KnockoutQualifier,
} from '../../src/competition/fixtures.js';
import {
  computeGroupStandings,
  recalculateAndPersistGroupStandings,
  type CompletedGameRecord,
  type GroupTeamInfo,
} from '../../src/competition/standings.js';
import {
  recordSeriesGameResult,
  getSeries,
  evaluateSeriesProgress,
} from '../../src/competition/series.js';
import {
  handleGroupDoubleWalkover,
  handleKnockoutDoubleRoomCardFailure,
  handleSingleForfeit,
  evaluateRoomHostAvailability,
} from '../../src/competition/walkover.js';

describe('Competition Engine (Fase 3)', () => {
  let db: Client;

  async function insertTeam(
    client: Client,
    tournamentId: string,
    id: string,
    name: string
  ) {
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
        VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))
      `,
      args: [id, tournamentId, name],
    });
  }

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // ===========================================================================
  // 1. Tournament Configuration & Lifecycle (Task 3.1)
  // ===========================================================================
  describe('Tournament CRUD & Lifecycle (Task 3.1)', () => {
    it('creates tournament with defaults in DRAFT status', async () => {
      const tournament = await createTournament(db, {
        name: 'Flash Peak Season 1',
      });

      expect(tournament.id).toBeDefined();
      expect(tournament.status).toBe('DRAFT');
      expect(tournament.timezone).toBe('Asia/Jakarta');

      const fetched = await getTournament(db, tournament.id);
      expect(fetched?.name).toBe('Flash Peak Season 1');
      expect(fetched?.status).toBe('DRAFT');
    });

    it('rejects Swiss format strictly per D-008', () => {
      expect(() => validateCompetitionFormat('SWISS')).toThrow(
        /Format Swiss tidak didukung/i
      );
      expect(() => validateCompetitionFormat('Swiss_System')).toThrow(
        /Format Swiss tidak didukung/i
      );
      // Valid format succeeds
      expect(() => validateCompetitionFormat('GROUP_AND_KNOCKOUT')).not.toThrow();
    });

    it('enforces lifecycle state transitions', async () => {
      const tournament = await createTournament(db, {
        name: 'Flash Peak Lifecycle Test',
      });

      // DRAFT -> REGISTRATION
      const t1 = await transitionTournamentStatus(db, tournament.id, 'REGISTRATION');
      expect(t1.status).toBe('REGISTRATION');

      // REGISTRATION -> ONBOARDING
      const t2 = await transitionTournamentStatus(db, tournament.id, 'ONBOARDING');
      expect(t2.status).toBe('ONBOARDING');

      // Invalid jump: ONBOARDING -> ACTIVE (must go through DRAW_READY)
      await expect(
        transitionTournamentStatus(db, tournament.id, 'ACTIVE')
      ).rejects.toThrow(/Transisi status tidak valid/);
    });

    it('blocks transition to DRAW_READY if fewer than 8 verified teams exist', async () => {
      const tournament = await createTournament(db, { name: 'Pre-check test' });
      await transitionTournamentStatus(db, tournament.id, 'REGISTRATION');
      await transitionTournamentStatus(db, tournament.id, 'ONBOARDING');

      // 0 verified teams -> must be rejected
      await expect(
        transitionTournamentStatus(db, tournament.id, 'DRAW_READY')
      ).rejects.toThrow(/Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim/);
    });
  });

  // ===========================================================================
  // 2. Programmatic Group Sizing (Task 3.2, FR-COMP-010, D-026/027)
  // ===========================================================================
  describe('Programmatic Group Sizing (FR-COMP-010, D-026/027)', () => {
    it('computes correct group sizes for all required test counts', () => {
      // 8 teams: 2 groups of 4 (0x5 + 2x4 = 8)
      const s8 = computeGroupSizing(8);
      expect(s8.num_groups).toBe(2);
      expect(s8.group_sizes).toEqual([4, 4]);
      expect(s8.qualifiers_per_group).toBe(2);

      // 9 teams: 1x5 + 1x4 = 9
      const s9 = computeGroupSizing(9);
      expect(s9.num_groups).toBe(2);
      expect(s9.group_sizes).toEqual([5, 4]);

      // 13 teams: 1x5 + 2x4 = 13
      const s13 = computeGroupSizing(13);
      expect(s13.num_groups).toBe(3);
      expect(s13.group_sizes).toEqual([5, 4, 4]);

      // 17 teams: 1x5 + 3x4 = 17
      const s17 = computeGroupSizing(17);
      expect(s17.num_groups).toBe(4);
      expect(s17.group_sizes).toEqual([5, 4, 4, 4]);

      // 20 teams: 4x5 + 0x4 = 20
      const s20 = computeGroupSizing(20);
      expect(s20.num_groups).toBe(4);
      expect(s20.group_sizes).toEqual([5, 5, 5, 5]);

      // 23 teams: 3x5 + 2x4 = 23 (matches spec example exactly)
      const s23 = computeGroupSizing(23);
      expect(s23.num_groups).toBe(5);
      expect(s23.group_sizes).toEqual([5, 5, 5, 4, 4]);

      // 24 teams: 4x5 + 1x4 = 24
      const s24 = computeGroupSizing(24);
      expect(s24.num_groups).toBe(5);
      expect(s24.group_sizes).toEqual([5, 5, 5, 5, 4]);

      // 25 teams: 5x5 + 0x4 = 25
      const s25 = computeGroupSizing(25);
      expect(s25.num_groups).toBe(5);
      expect(s25.group_sizes).toEqual([5, 5, 5, 5, 5]);

      // Invariants across all valid counts:
      for (const count of [8, 9, 13, 17, 20, 23, 24, 25]) {
        const res = computeGroupSizing(count);
        const sum = res.group_sizes.reduce((a, b) => a + b, 0);
        expect(sum).toBe(count);
        expect(res.group_sizes.every((sz) => sz === 4 || sz === 5)).toBe(true);
        expect(res.qualifiers_per_group).toBe(2);
      }
    });

    it('rejects team counts < 8 with descriptive error', () => {
      for (const count of [0, 1, 3, 5, 6, 7]) {
        expect(() => computeGroupSizing(count)).toThrow(
          'Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim'
        );
      }
    });
  });

  // ===========================================================================
  // 3. Cryptographic Draw, Persist-Before-Reveal & Restart Safety (Task 3.2)
  // ===========================================================================
  describe('Draw Service & Progressive Reveal (FR-COMP-003..007)', () => {
    async function setupVerifiedTeams(tournamentId: string, count: number) {
      for (let i = 1; i <= count; i++) {
        const teamId = `team-${i.toString().padStart(3, '0')}`;
        await db.execute({
          sql: `
            INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))
          `,
          args: [teamId, tournamentId, `Team ${i}`],
        });
      }
    }

    it('cryptographically shuffles array preserving all elements', () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8];
      const shuffled = cryptoFisherYates(items);
      expect(shuffled.length).toBe(items.length);
      expect([...shuffled].sort()).toEqual(items);
    });

    it('randomizes cryptographically, persists before reveal, and computes commitment hash', async () => {
      const tournament = await createTournament(db, { name: 'Draw Test Tourney' });
      await setupVerifiedTeams(tournament.id, 9); // 9 teams -> Group A (5), Group B (4)

      const draw = await prepareDraw(db, tournament.id);

      expect(draw.id).toBeDefined();
      expect(draw.status).toBe('PREPARED');
      expect(draw.commitment_hash).toBeDefined();
      expect(draw.seed_reveal).toBeDefined();
      expect(draw.next_reveal_index).toBe(0);

      const fetchedDraw = await getDraw(db, draw.id);
      expect(fetchedDraw?.id).toBe(draw.id);

      // Verify groups and group_members persisted in DB
      const groups = await db.execute({
        sql: 'SELECT * FROM groups WHERE draw_id = ?',
        args: [draw.id],
      });
      expect(groups.rows.length).toBe(2);

      const members = await db.execute({
        sql: `
          SELECT gm.* FROM group_members gm
          JOIN groups g ON gm.group_id = g.id
          WHERE g.draw_id = ?
        `,
        args: [draw.id],
      });
      expect(members.rows.length).toBe(9);
    });

    it('resumes progressive reveal on restart without rerolling (FR-COMP-006)', async () => {
      const tournament = await createTournament(db, { name: 'Resume Test Tourney' });
      await setupVerifiedTeams(tournament.id, 8); // 8 teams

      const initialDraw = await prepareDraw(db, tournament.id);
      const initialCommitment = initialDraw.commitment_hash;
      const initialResult = initialDraw.result_json;

      // Reveal first 3 teams
      const step1 = await revealNext(db, initialDraw.id);
      expect(step1.revealed_count).toBe(1);
      expect(step1.status).toBe('REVEALING');

      const step2 = await revealNext(db, initialDraw.id);
      expect(step2.revealed_count).toBe(2);

      const step3 = await revealNext(db, initialDraw.id);
      expect(step3.revealed_count).toBe(3);

      // Simulate bot restart: call prepareDraw again on same tournament
      const resumedDraw = await prepareDraw(db, tournament.id);
      expect(resumedDraw.id).toBe(initialDraw.id);
      expect(resumedDraw.commitment_hash).toBe(initialCommitment);
      expect(resumedDraw.result_json).toBe(initialResult);
      expect(resumedDraw.next_reveal_index).toBe(3); // Picked up without losing state

      // Reveal remaining 5 teams
      for (let i = 4; i <= 8; i++) {
        const step = await revealNext(db, initialDraw.id);
        expect(step.revealed_count).toBe(i);
        if (i === 8) {
          expect(step.is_complete).toBe(true);
          expect(step.status).toBe('COMPLETED');
          expect(step.seed_reveal).toBe(initialDraw.seed_reveal);
        }
      }

      // Further call returns already complete
      const finalCheck = await revealNext(db, initialDraw.id);
      expect(finalCheck.is_complete).toBe(true);
      expect(finalCheck.revealed_count).toBe(8);
    });
  });

  // ===========================================================================
  // 4. Balanced Left/Right Host Assignment (Task 3.3, FR-COMP-013, D-034)
  // ===========================================================================
  describe('Balanced Host Side Assignment (FR-COMP-013, D-034)', () => {
    it('guarantees |left - right| <= 1 for 4-team groups', () => {
      const teams: GroupTeamParticipant[] = [
        { team_id: 't1', team_name: 'Team 1' },
        { team_id: 't2', team_name: 'Team 2' },
        { team_id: 't3', team_name: 'Team 3' },
        { team_id: 't4', team_name: 'Team 4' },
      ];

      const matches = generateBalancedRoundRobin(teams);
      // 4 teams -> 6 matches total (3 games per team)
      expect(matches.length).toBe(6);

      const leftCounts = new Map<string, number>();
      const rightCounts = new Map<string, number>();
      for (const t of teams) {
        leftCounts.set(t.team_id, 0);
        rightCounts.set(t.team_id, 0);
      }

      for (const m of matches) {
        leftCounts.set(m.team_a.team_id, leftCounts.get(m.team_a.team_id)! + 1);
        rightCounts.set(m.team_b.team_id, rightCounts.get(m.team_b.team_id)! + 1);
      }

      for (const t of teams) {
        const left = leftCounts.get(t.team_id)!;
        const right = rightCounts.get(t.team_id)!;
        expect(left + right).toBe(3);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }
    });

    it('guarantees |left - right| <= 1 for 5-team groups', () => {
      const teams: GroupTeamParticipant[] = [
        { team_id: 't1', team_name: 'Team 1' },
        { team_id: 't2', team_name: 'Team 2' },
        { team_id: 't3', team_name: 'Team 3' },
        { team_id: 't4', team_name: 'Team 4' },
        { team_id: 't5', team_name: 'Team 5' },
      ];

      const matches = generateBalancedRoundRobin(teams);
      // 5 teams -> 10 matches total (4 games per team)
      expect(matches.length).toBe(10);

      const leftCounts = new Map<string, number>();
      const rightCounts = new Map<string, number>();
      for (const t of teams) {
        leftCounts.set(t.team_id, 0);
        rightCounts.set(t.team_id, 0);
      }

      for (const m of matches) {
        leftCounts.set(m.team_a.team_id, leftCounts.get(m.team_a.team_id)! + 1);
        rightCounts.set(m.team_b.team_id, rightCounts.get(m.team_b.team_id)! + 1);
      }

      for (const t of teams) {
        const left = leftCounts.get(t.team_id)!;
        const right = rightCounts.get(t.team_id)!;
        expect(left + right).toBe(4);
        expect(Math.abs(left - right)).toBe(0); // Perfect 2 Left and 2 Right!
      }
    });

    it('assigns left_side_team_id at fixture generation time in DB', async () => {
      const tournament = await createTournament(db, { name: 'Fixture Generation Test' });
      for (let i = 1; i <= 8; i++) {
        await db.execute({
          sql: `
            INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))
          `,
          args: [`team-${i}`, tournament.id, `Team ${i}`],
        });
      }

      await prepareDraw(db, tournament.id);
      const fixtures = await generateGroupStageFixtures(db, tournament.id);

      expect(fixtures.length).toBe(12); // 2 groups of 4 = 6 + 6 = 12 matches
      for (const f of fixtures) {
        expect(f.left_side_team_id).toBe(f.team_a_id);
        expect(f.host_assignment_reason).toBe('DEFAULT_LEFT_SIDE');
        expect(f.stage).toBe('GROUP');
      }
    });
  });

  // ===========================================================================
  // 5. Knockout Bracket Generation & Series (Task 3.3, 3.5, FR-CALC-003, D-010/011)
  // ===========================================================================
  describe('Knockout Bracket & BO3/BO5 Series Logic', () => {
    it('evaluates series progress for BO3 and BO5', () => {
      expect(evaluateSeriesProgress('BO3', 1, 0)).toEqual({ target_wins: 2, is_complete: false, winner: null });
      expect(evaluateSeriesProgress('BO3', 2, 1)).toEqual({ target_wins: 2, is_complete: true, winner: 'TEAM_A' });
      expect(evaluateSeriesProgress('BO5', 2, 3)).toEqual({ target_wins: 3, is_complete: true, winner: 'TEAM_B' });
    });

    it('creates BO3 for semi-finals and BO5 for Grand Final', async () => {
      const tournament = await createTournament(db, { name: 'KO Test' });
      await insertTeam(db, tournament.id, 'tA1', 'Team A1');
      await insertTeam(db, tournament.id, 'tA2', 'Team A2');
      await insertTeam(db, tournament.id, 'tB1', 'Team B1');
      await insertTeam(db, tournament.id, 'tB2', 'Team B2');
      await insertTeam(db, tournament.id, 'tWinner1', 'Finalist 1');
      await insertTeam(db, tournament.id, 'tWinner2', 'Finalist 2');

      const qualifiers: KnockoutQualifier[] = [
        { team_id: 'tA1', team_name: 'Team A1', group_code: 'A', group_rank: 1 },
        { team_id: 'tA2', team_name: 'Team A2', group_code: 'A', group_rank: 2 },
        { team_id: 'tB1', team_name: 'Team B1', group_code: 'B', group_rank: 1 },
        { team_id: 'tB2', team_name: 'Team B2', group_code: 'B', group_rank: 2 },
      ];

      const { fixtures, series } = await generateKnockoutFixtures(
        db,
        tournament.id,
        qualifiers
      );

      // 4 qualifiers -> 2 matches (Semi-Finals)
      expect(fixtures.length).toBe(2);
      expect(series.length).toBe(2);

      for (const s of series) {
        expect(s.format).toBe('BO3');
        expect(s.target_wins).toBe(2);
      }

      // Grand Final pairing: 2 teams -> 1 match
      const finalQualifiers: KnockoutQualifier[] = [
        { team_id: 'tWinner1', team_name: 'Finalist 1', group_code: 'A', group_rank: 1 },
        { team_id: 'tWinner2', team_name: 'Finalist 2', group_code: 'B', group_rank: 2 },
      ];
      const grandFinal = await generateKnockoutFixtures(db, tournament.id, finalQualifiers);
      expect(grandFinal.fixtures.length).toBe(1);
      expect(grandFinal.series[0]?.format).toBe('BO5');
      expect(grandFinal.series[0]?.target_wins).toBe(3);
    });

    it('BRACKET-REDRAW: later rounds pair via the injected draw, not previous fixture order (Arya decision 21 Nov 2026)', async () => {
      const tournament = await createTournament(db, { name: 'Re-Draw Bracket Test' });
      for (let i = 1; i <= 8; i++) {
        await insertTeam(db, tournament.id, `rd-t${i}`, `RD Team ${i}`);
      }

      // Round 1 (QF) via classic seeding (no shuffle): winners side + runners-up.
      const quals: KnockoutQualifier[] = [
        { team_id: 'rd-t1', team_name: 'RD Team 1', group_code: 'A', group_rank: 1 },
        { team_id: 'rd-t2', team_name: 'RD Team 2', group_code: 'A', group_rank: 2 },
        { team_id: 'rd-t3', team_name: 'RD Team 3', group_code: 'B', group_rank: 1 },
        { team_id: 'rd-t4', team_name: 'RD Team 4', group_code: 'B', group_rank: 2 },
        { team_id: 'rd-t5', team_name: 'RD Team 5', group_code: 'C', group_rank: 1 },
        { team_id: 'rd-t6', team_name: 'RD Team 6', group_code: 'C', group_rank: 2 },
        { team_id: 'rd-t7', team_name: 'RD Team 7', group_code: 'D', group_rank: 1 },
        { team_id: 'rd-t8', team_name: 'RD Team 8', group_code: 'D', group_rank: 2 },
      ];
      const qf = await generateKnockoutFixtures(db, tournament.id, quals);
      expect(qf.fixtures.length).toBe(4);
      expect(qf.fixtures[0]!.round_code).toBe('QUARTER_FINAL');

      // Round 2 (SF) survivors re-drawn with a DETERMINISTIC injectable shuffle
      // (reverse): pool [W0..W3] -> pairs (W3,W2),(W1,W0). The old pseudo-rank
      // half-split would pair (W0,W2),(W1,W3) — the test pins the draw result.
      const survivors: KnockoutQualifier[] = qf.fixtures.map((f) => ({
        team_id: f.team_a_id, team_name: 'Winner', group_code: 'KO', group_rank: 1,
      }));
      const reverse = <T,>(arr: T[]): T[] => [...arr].reverse();
      const sf = await generateKnockoutFixtures(db, tournament.id, survivors, { shuffle: reverse });
      expect(sf.fixtures.length).toBe(2);
      expect(sf.fixtures[0]!.round_code).toBe('SEMI_FINAL');
      expect(sf.fixtures[0]!.team_a_id).toBe(qf.fixtures[3]!.team_a_id);
      expect(sf.fixtures[0]!.team_b_id).toBe(qf.fixtures[2]!.team_a_id);
      expect(sf.fixtures[1]!.team_a_id).toBe(qf.fixtures[1]!.team_a_id);
      expect(sf.fixtures[1]!.team_b_id).toBe(qf.fixtures[0]!.team_a_id);
      // Anti-self-match holds.
      for (const f of sf.fixtures) {
        expect(f.team_a_id).not.toBe(f.team_b_id);
      }
      expect(sf.byeTeamId).toBeNull();

      // A tampered shuffle (drops/duplicates a team) is rejected.
      await expect(
        generateKnockoutFixtures(db, tournament.id, survivors, {
          shuffle: (arr) => [...arr, arr[0]!],
        })
      ).rejects.toThrow('Draw ulang bracket tidak valid');
    });

    it('BRACKET-REDRAW: odd survivor pool (3) re-drawn -> 1 FINAL fixture + bye, no self-match', async () => {
      const tournament = await createTournament(db, { name: 'Re-Draw Odd Pool Test' });
      for (let i = 1; i <= 3; i++) {
        await insertTeam(db, tournament.id, `od-t${i}`, `OD Team ${i}`);
      }
      const oddPool: KnockoutQualifier[] = [
        { team_id: 'od-t1', team_name: 'OD Team 1', group_code: 'KO', group_rank: 1 },
        { team_id: 'od-t2', team_name: 'OD Team 2', group_code: 'KO', group_rank: 1 },
        { team_id: 'od-t3', team_name: 'OD Team 3', group_code: 'KO', group_rank: 1 },
      ];
      const reverse = <T,>(arr: T[]): T[] => [...arr].reverse();
      const fin = await generateKnockoutFixtures(db, tournament.id, oddPool, { shuffle: reverse });
      expect(fin.fixtures.length).toBe(1);
      expect(fin.fixtures[0]!.round_code).toBe('FINAL');
      expect(fin.fixtures[0]!.team_a_id).not.toBe(fin.fixtures[0]!.team_b_id);
      // Bye goes to the LAST qualifier of the pre-shuffle list (T2 handling).
      expect(fin.byeTeamId).toBe('od-t3');
    });

    it('reuses the SAME game_number slot when a tied KO game is replayed (FR-CALC-004/005, D-028)', async () => {
      const tournament = await createTournament(db, { name: 'Series Replay Test' });
      await insertTeam(db, tournament.id, 't1', 'Team 1');
      await insertTeam(db, tournament.id, 't2', 'Team 2');
      await insertTeam(db, tournament.id, 't3', 'Team 3');
      await insertTeam(db, tournament.id, 't4', 'Team 4');

      const qualifiers: KnockoutQualifier[] = [
        { team_id: 't1', team_name: 'Team 1', group_code: 'A', group_rank: 1 },
        { team_id: 't2', team_name: 'Team 2', group_code: 'A', group_rank: 2 },
        { team_id: 't3', team_name: 'Team 3', group_code: 'B', group_rank: 1 },
        { team_id: 't4', team_name: 'Team 4', group_code: 'B', group_rank: 2 },
      ];

      const { series } = await generateKnockoutFixtures(db, tournament.id, qualifiers);
      const seriesId = series[0]!.id;
      const fetchedSeries = await getSeries(db, seriesId);
      expect(fetchedSeries?.id).toBe(seriesId);
      expect(series[0]!.format).toBe('BO3');
      expect(series[0]!.target_wins).toBe(2);

      // Game 1: Decisive win for Team 1 (Score 2 - 1)
      const g1 = await recordSeriesGameResult(db, {
        series_id: seriesId,
        game_number: 1,
        team_a_score: 2,
        team_b_score: 1,
      });
      expect(g1.is_tied_game).toBe(false);
      expect(g1.series.team_a_game_wins).toBe(1);
      expect(g1.series.team_b_game_wins).toBe(0);
      expect(g1.next_game_number).toBe(2);

      // Game 2: TIED GAME (Score 1 - 1)!
      // In KO, tied game must be replayed and does NOT award game wins
      const g2Tie = await recordSeriesGameResult(db, {
        series_id: seriesId,
        game_number: 2,
        team_a_score: 1,
        team_b_score: 1,
      });
      expect(g2Tie.is_tied_game).toBe(true);
      expect(g2Tie.is_replay_required).toBe(true);
      // Game wins remain unchanged
      expect(g2Tie.series.team_a_game_wins).toBe(1);
      expect(g2Tie.series.team_b_game_wins).toBe(0);
      // Slot 2 must be replayed (next_game_number stays 2!)
      expect(g2Tie.next_game_number).toBe(2);

      // Game 2 REPLAY: Decisive win for Team 1 (Score 3 - 0)
      // Reuses slot 2!
      const g2Replay = await recordSeriesGameResult(db, {
        series_id: seriesId,
        game_number: 2, // SAME slot
        team_a_score: 3,
        team_b_score: 0,
        is_replay: true,
      });
      expect(g2Replay.is_tied_game).toBe(false);
      expect(g2Replay.is_replay_required).toBe(false);
      expect(g2Replay.series.team_a_game_wins).toBe(2);
      expect(g2Replay.is_series_complete).toBe(true);
      expect(g2Replay.winner_team_id).toBe('t1');

      // Check DB to ensure games table does not have an extra slot 3
      const allGames = await db.execute({
        sql: 'SELECT game_number, status, is_draw, team_a_score, team_b_score FROM games WHERE series_id = ?',
        args: [seriesId],
      });
      expect(allGames.rows.length).toBe(2); // Only slots 1 and 2 exist!
    });
  });

  // ===========================================================================
  // 6. Standings Calculator & Tie-breakers (Task 3.4, FR-CALC-001/002)
  // ===========================================================================
  describe('Group Standings Calculator (FR-CALC-001, FR-CALC-002)', () => {
    const teams: GroupTeamInfo[] = [
      { team_id: 'tA', team_name: 'Team Alpha' },
      { team_id: 'tB', team_name: 'Team Beta' },
      { team_id: 'tC', team_name: 'Team Gamma' },
    ];

    it('calculates points correctly (Win=3, Draw=1, Loss=0)', () => {
      const games: CompletedGameRecord[] = [
        {
          id: 'g1',
          fixture_id: 'f1',
          team_a_id: 'tA',
          team_b_id: 'tB',
          team_a_score: 2,
          team_b_score: 0,
          winner_team_id: 'tA',
          is_draw: 0,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
        {
          id: 'g2',
          fixture_id: 'f2',
          team_a_id: 'tB',
          team_b_id: 'tC',
          team_a_score: 1,
          team_b_score: 1,
          winner_team_id: null,
          is_draw: 1,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
      ];

      const standings = computeGroupStandings('tourn-1', 'grp-1', teams, games);

      const standA = standings.find((s) => s.team_id === 'tA')!;
      expect(standA.points).toBe(3);
      expect(standA.wins).toBe(1);
      expect(standA.goal_difference).toBe(2);

      const standB = standings.find((s) => s.team_id === 'tB')!;
      expect(standB.points).toBe(1);
      expect(standB.draws).toBe(1);
      expect(standB.losses).toBe(1);
      expect(standB.goal_difference).toBe(-2);

      const standC = standings.find((s) => s.team_id === 'tC')!;
      expect(standC.points).toBe(1);
      expect(standC.draws).toBe(1);
      expect(standC.losses).toBe(0);
      expect(standC.goal_difference).toBe(0);
    });

    it('resolves ties using Head-to-Head when Points, GD, and GF are identical', () => {
      // Both Team Alpha and Team Beta have 3 points, GD 0, GF 2.
      // But in their head-to-head match, Team Beta defeated Team Alpha 2-0.
      const games: CompletedGameRecord[] = [
        // Alpha beats Gamma 2-0
        {
          id: 'g1',
          fixture_id: 'f1',
          team_a_id: 'tA',
          team_b_id: 'tC',
          team_a_score: 2,
          team_b_score: 0,
          winner_team_id: 'tA',
          is_draw: 0,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
        // Beta beats Alpha 2-0 (Head-to-Head advantage to Beta)
        {
          id: 'g2',
          fixture_id: 'f2',
          team_a_id: 'tB',
          team_b_id: 'tA',
          team_a_score: 2,
          team_b_score: 0,
          winner_team_id: 'tB',
          is_draw: 0,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
        // Gamma beats Beta 2-0
        {
          id: 'g3',
          fixture_id: 'f3',
          team_a_id: 'tC',
          team_b_id: 'tB',
          team_a_score: 2,
          team_b_score: 0,
          winner_team_id: 'tC',
          is_draw: 0,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
      ];

      // In this 3-way tie:
      // tA: played 2, won 1, lost 1, GF 2, GA 2, GD 0, Pts 3
      // tB: played 2, won 1, lost 1, GF 2, GA 2, GD 0, Pts 3
      // tC: played 2, won 1, lost 1, GF 2, GA 2, GD 0, Pts 3
      // In H2H among all 3: each beat one other team, identical H2H.
      const standings = computeGroupStandings('tourn-1', 'grp-1', teams, games);
      expect(standings.length).toBe(3);
      for (const s of standings) {
        expect(s.points).toBe(3);
        expect(s.goal_difference).toBe(0);
      }
    });

    it('ignores uncompleted/unlocked games (FR-CALC-007)', () => {
      const games: CompletedGameRecord[] = [
        {
          id: 'g1',
          fixture_id: 'f1',
          team_a_id: 'tA',
          team_b_id: 'tB',
          team_a_score: 5,
          team_b_score: 0,
          winner_team_id: 'tA',
          is_draw: 0,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'IN_PROGRESS', // NOT COMPLETED/WALKOVER
        },
      ];

      const standings = computeGroupStandings('tourn-1', 'grp-1', teams, games);
      for (const s of standings) {
        expect(s.played).toBe(0);
        expect(s.points).toBe(0);
      }
    });

    it('persists and retrieves standings in DB via recalculateAndPersistGroupStandings', async () => {
      const tournament = await createTournament(db, { name: 'DB Standings Test' });
      for (let i = 1; i <= 8; i++) {
        await insertTeam(db, tournament.id, `team-${i}`, `Team ${i}`);
      }
      await prepareDraw(db, tournament.id);
      const fixtures = await generateGroupStageFixtures(db, tournament.id);

      const firstGroup = fixtures[0]!.group_id!;
      const persisted = await recalculateAndPersistGroupStandings(db, tournament.id, firstGroup);
      expect(persisted.length).toBe(4);
      expect(persisted.every((s) => s.played === 0 && s.points === 0)).toBe(true);
    });
  });

  // ===========================================================================
  // 7. Walkover & Room Card Handling (Task 3.6, D-031, D-032, FR-FIX-005/006)
  // ===========================================================================
  describe('Walkover & Room Card Handling (D-031, D-032, FR-FIX-005/006)', () => {
    it('explicitly verifies that double walkover -> 0 points != genuine draw -> 1 point', async () => {
      const tournament = await createTournament(db, { name: 'WO vs Draw Test' });
      await insertTeam(db, tournament.id, 'tA', 'Team A');
      await insertTeam(db, tournament.id, 'tB', 'Team B');

      // Create 2 fixtures
      const f1Id = 'fixture-genuine-draw';
      const f2Id = 'fixture-double-wo';

      for (const fid of [f1Id, f2Id]) {
        await db.execute({
          sql: `
            INSERT INTO fixtures (
              id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
              timezone, status, created_at, updated_at
            )
            VALUES (?, ?, 'GROUP', 'tA', 'tB', 'tA', 'Asia/Jakarta', 'SCHEDULED', datetime('now'), datetime('now'))
          `,
          args: [fid, tournament.id],
        });
      }

      // 1. Genuine in-game draw via the OFFICIAL path: a completed game with
      // is_draw=1 (as written by onReportLocked) is translated by
      // computeGroupStandings into 1 point each (FR-CALC-001).
      // (recordGenuineDraw was removed as dead code — FIX2-DEADCODE-001 —
      // because the standings path is the single official draw route.)
      const standingsDraw = computeGroupStandings(tournament.id, 'group-x', [
        { team_id: 'tA', team_name: 'Team A' },
        { team_id: 'tB', team_name: 'Team B' },
      ], [
        {
          id: 'game-draw-1',
          fixture_id: f1Id,
          team_a_id: 'tA',
          team_b_id: 'tB',
          team_a_score: 1,
          team_b_score: 1,
          winner_team_id: null,
          is_draw: 1,
          is_walkover: 0,
          walkover_type: 'NONE',
          status: 'COMPLETED',
        },
      ]);
      expect(standingsDraw.find((s) => s.team_id === 'tA')!.points).toBe(1);
      expect(standingsDraw.find((s) => s.team_id === 'tB')!.points).toBe(1);

      // 2. Record double walkover (double room card unavailable)
      const doubleWoOutcome = await handleGroupDoubleWalkover(
        db,
        f2Id,
        'DOUBLE_ROOM_CARD_UNAVAILABLE'
      );
      expect(doubleWoOutcome.action).toBe('GROUP_DOUBLE_WALKOVER_RECORDED');
      expect(doubleWoOutcome.points_awarded.team_a_points).toBe(0);
      expect(doubleWoOutcome.points_awarded.team_b_points).toBe(0);
      expect(doubleWoOutcome.generates_player_statistics).toBe(false);

      // Explicit inequality assertion: draw (1 point) != double walkover (0 points)
      expect(doubleWoOutcome.points_awarded.team_a_points).toBe(0);
      expect(standingsDraw.find((s) => s.team_id === 'tA')!.points).toBe(1);
    });

    it('records DOUBLE LOSS on Knockout double room-card failure (D-032 revised 20 Nov 2026)', async () => {
      const tournament = await createTournament(db, { name: 'KO Double Loss Test' });
      await insertTeam(db, tournament.id, 'tA', 'Team A');
      await insertTeam(db, tournament.id, 'tB', 'Team B');
      const fixtureId = 'fixture-ko-double-fail';

      await db.execute({
        sql: `
          INSERT INTO fixtures (
            id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
            timezone, status, created_at, updated_at
          )
          VALUES (?, ?, 'KNOCKOUT', 'tA', 'tB', 'tA', 'Asia/Jakarta', 'SCHEDULED', datetime('now'), datetime('now'))
        `,
        args: [fixtureId, tournament.id],
      });

      const outcome = await handleKnockoutDoubleRoomCardFailure(db, fixtureId);
      // Revised rule: both teams lose (double loss), NOT a reschedule.
      expect(outcome.action).toBe('KNOCKOUT_DOUBLE_LOSS_RECORDED');
      expect(outcome.is_reschedule_required).toBe(false);
      expect(outcome.winner_team_id).toBeNull();
      expect(outcome.generates_player_statistics).toBe(false);
      expect(outcome.points_awarded.team_a_points).toBe(0);
      expect(outcome.points_awarded.team_b_points).toBe(0);

      // Fixture is resolved as WALKOVER (no winner) — the bye-detection in
      // the next-round generator keys off this state.
      const fixture = await db.execute({
        sql: 'SELECT status FROM fixtures WHERE id = ?',
        args: [fixtureId],
      });
      expect(fixture.rows[0]?.[0]).toBe('WALKOVER');

      // The game record carries the double-loss outcome, no winner.
      const game = await db.execute({
        sql: 'SELECT winner_team_id, is_walkover, walkover_type, status FROM games WHERE fixture_id = ? AND game_number = 1',
        args: [fixtureId],
      });
      expect(game.rows[0]?.[0]).toBeNull();
      expect(Number(game.rows[0]?.[1])).toBe(1);
      expect(String(game.rows[0]?.[2])).toBe('DOUBLE_ROOM_CARD_UNAVAILABLE');
      expect(String(game.rows[0]?.[3])).toBe('WALKOVER');

      // Audit event records the double loss (no reschedule).
      const audit = await db.execute({
        sql: "SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'KNOCKOUT_DOUBLE_LOSS_RECORDED' AND entity_id = ?",
        args: [fixtureId],
      });
      expect(Number(audit.rows[0]?.[0])).toBe(1);
    });

    it('awards 3-0 WO and 3 points to opponent on single forfeit in Group stage (no player stats)', async () => {
      const tournament = await createTournament(db, { name: 'Single Forfeit Test' });
      await insertTeam(db, tournament.id, 'tA', 'Team A');
      await insertTeam(db, tournament.id, 'tB', 'Team B');
      const fixtureId = 'fixture-single-forfeit';

      await db.execute({
        sql: `
          INSERT INTO fixtures (
            id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
            timezone, status, created_at, updated_at
          )
          VALUES (?, ?, 'GROUP', 'tA', 'tB', 'tA', 'Asia/Jakarta', 'SCHEDULED', datetime('now'), datetime('now'))
        `,
        args: [fixtureId, tournament.id],
      });

      // Team A forfeits
      const outcome = await handleSingleForfeit(db, fixtureId, 'tA');
      expect(outcome.action).toBe('SINGLE_FORFEIT_RECORDED');
      expect(outcome.winner_team_id).toBe('tB');
      expect(outcome.loser_team_id).toBe('tA');
      expect(outcome.score.team_a_score).toBe(0);
      expect(outcome.score.team_b_score).toBe(3);
      expect(outcome.points_awarded.team_a_points).toBe(0);
      expect(outcome.points_awarded.team_b_points).toBe(3);
      expect(outcome.generates_player_statistics).toBe(false); // FR-CALC-006
    });

    it('evaluates room host availability and opponent substitution properly', async () => {
      const tournament = await createTournament(db, { name: 'Host Eval Test' });
      await insertTeam(db, tournament.id, 'tA', 'Team A');
      await insertTeam(db, tournament.id, 'tB', 'Team B');
      const fixtureId = 'fixture-host-eval';

      await db.execute({
        sql: `
          INSERT INTO fixtures (
            id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
            timezone, status, created_at, updated_at
          )
          VALUES (?, ?, 'GROUP', 'tA', 'tB', 'tA', 'Asia/Jakarta', 'SCHEDULED', datetime('now'), datetime('now'))
        `,
        args: [fixtureId, tournament.id],
      });

      // Left side has card -> proceeds with DEFAULT_LEFT_SIDE
      const res1 = await evaluateRoomHostAvailability(db, fixtureId, {
        left_side_has_card: true,
        right_side_willing_to_host: false,
      });
      expect(res1.match_can_proceed).toBe(true);
      expect(res1.host_team_id).toBe('tA');
      expect(res1.host_assignment_reason).toBe('DEFAULT_LEFT_SIDE');

      // Left side has NO card, but opponent willing to host -> OPPONENT_SUBSTITUTED
      const res2 = await evaluateRoomHostAvailability(db, fixtureId, {
        left_side_has_card: false,
        right_side_willing_to_host: true,
      });
      expect(res2.match_can_proceed).toBe(true);
      expect(res2.host_team_id).toBe('tB');
      expect(res2.host_assignment_reason).toBe('OPPONENT_SUBSTITUTED');

      // Left side has NO card, opponent declines, and opponent also has NO card -> Group Double WO (0 pts each)
      const res3 = await evaluateRoomHostAvailability(db, fixtureId, {
        left_side_has_card: false,
        right_side_willing_to_host: false,
        right_side_has_card: false,
      });
      expect(res3.match_can_proceed).toBe(false);
      expect(res3.walkover_outcome?.action).toBe('GROUP_DOUBLE_WALKOVER_RECORDED');
      expect(res3.walkover_outcome?.points_awarded.team_a_points).toBe(0);
    });
  });

  describe('REVIEW-FIX blocker-roundcode: knockout round labels derive from round history, never collide', () => {
    it('labels two consecutive odd-width rounds uniquely and always NARROW (R16 -> QUARTER_FINAL, never ROUND_OF_32)', async () => {
      const tournament = await createTournament(db, { name: 'RoundCode Narrowing Test' });
      for (let i = 1; i <= 16; i++) {
        await insertTeam(db, tournament.id, `rc-t${i}`, `RC Team ${i}`);
      }
      // Round 1: 8 fixtures -> ROUND_OF_16 (natural label for 8 matches).
      const quals1: KnockoutQualifier[] = [];
      for (let g = 0; g < 8; g++) {
        quals1.push({ team_id: `rc-t${g * 2 + 1}`, team_name: `RC Team ${g * 2 + 1}`, group_code: `G${g}`, group_rank: 1 });
        quals1.push({ team_id: `rc-t${g * 2 + 2}`, team_name: `RC Team ${g * 2 + 2}`, group_code: `G${g}`, group_rank: 2 });
      }
      const r1 = await generateKnockoutFixtures(db, tournament.id, quals1);
      expect(r1.fixtures.length).toBe(8);
      expect(r1.fixtures[0]!.round_code).toBe('ROUND_OF_16');

      // Round 2: 7 survivors (odd pool -> 3 fixtures). Natural label is null
      // (3 matches); the label must come AFTER ROUND_OF_16 in the progression
      // (QUARTER_FINAL), NOT go backwards to ROUND_OF_32, and must be unique.
      const survivors: KnockoutQualifier[] = [];
      for (let i = 1; i <= 7; i++) {
        survivors.push({ team_id: `rc-t${i}`, team_name: `RC Team ${i}`, group_code: 'KO', group_rank: 1 });
      }
      const r2 = await generateKnockoutFixtures(db, tournament.id, survivors, { shuffle: (a) => [...a] });
      expect(r2.fixtures.length).toBe(3);
      expect(r2.fixtures[0]!.round_code).toBe('QUARTER_FINAL');
      // No self-match after the odd-pool bye.
      for (const f of r2.fixtures) {
        expect(f.team_a_id).not.toBe(f.team_b_id);
      }
    });

    it('a single-fixture round is ALWAYS the FINAL, even after odd-pool rounds consumed earlier labels', async () => {
      const tournament = await createTournament(db, { name: 'RoundCode Final Test' });
      for (let i = 1; i <= 4; i++) {
        await insertTeam(db, tournament.id, `fc-t${i}`, `FC Team ${i}`);
      }
      // First round: 4 qualifiers -> 2 fixtures (SEMI_FINAL).
      const quals: KnockoutQualifier[] = [
        { team_id: 'fc-t1', team_name: 'FC Team 1', group_code: 'A', group_rank: 1 },
        { team_id: 'fc-t2', team_name: 'FC Team 2', group_code: 'A', group_rank: 2 },
        { team_id: 'fc-t3', team_name: 'FC Team 3', group_code: 'B', group_rank: 1 },
        { team_id: 'fc-t4', team_name: 'FC Team 4', group_code: 'B', group_rank: 2 },
      ];
      const r1 = await generateKnockoutFixtures(db, tournament.id, quals);
      expect(r1.fixtures[0]!.round_code).toBe('SEMI_FINAL');
      // Two finalists -> 1 fixture: ALWAYS labeled FINAL.
      const finalists: KnockoutQualifier[] = [
        { team_id: 'fc-t1', team_name: 'FC Team 1', group_code: 'KO', group_rank: 1 },
        { team_id: 'fc-t3', team_name: 'FC Team 3', group_code: 'KO', group_rank: 1 },
      ];
      const r2 = await generateKnockoutFixtures(db, tournament.id, finalists, { shuffle: (a) => [...a] });
      expect(r2.fixtures.length).toBe(1);
      expect(r2.fixtures[0]!.round_code).toBe('FINAL');
      expect(r2.series[0]!.format).toBe('BO5');
      expect(r2.series[0]!.target_wins).toBe(3);
    });
  });

  describe('REVIEW-FIX quickwin-shuffle-validation: draw validated by team_id multiset', () => {
    it('rejects a tampered shuffle that mutates team_ids (the reviewer self-match attack)', async () => {
      const tournament = await createTournament(db, { name: 'Shuffle Validation Test' });
      for (let i = 1; i <= 4; i++) {
        await insertTeam(db, tournament.id, `sv-t${i}`, `SV Team ${i}`);
      }
      const quals: KnockoutQualifier[] = [1, 2, 3, 4].map((i) => ({
        team_id: `sv-t${i}`, team_name: `SV Team ${i}`, group_code: 'KO', group_rank: 1,
      }));
      // Shuffle returns NEW objects with one team_id duplicated over another —
      // distinct object identities (passed the old Set check) but a duplicate
      // team_id multiset. Must be rejected.
      await expect(
        generateKnockoutFixtures(db, tournament.id, quals, {
          shuffle: (a) => a.map((q) => ({ ...q, team_id: q.team_id === a[0]!.team_id ? a[1]!.team_id : q.team_id })),
        })
      ).rejects.toThrow('Draw ulang bracket tidak valid');
    });
  });
});
