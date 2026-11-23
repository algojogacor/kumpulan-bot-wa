/**
 * Flash Peak TMS - Fixtures & Scheduling Engine
 * 
 * Generates single round-robin fixtures within groups with strictly balanced
 * left/right host side assignment (FR-COMP-012, FR-COMP-013, D-034).
 * Generates knockout stage single-elimination brackets with BO3/BO5 series mapping.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { recalculateAndPersistGroupStandings } from './standings.js';
import { cryptoFisherYates } from './draw.js';
import type {
  Fixture,
  Series,
  UUID,
  ISODateString,
} from '../shared/types/index.js';

export interface GroupTeamParticipant {
  team_id: UUID;
  team_name: string;
  draw_position?: number;
}

export interface ScheduledMatchPair {
  round: number;
  team_a: GroupTeamParticipant; // Left-side host recommendation
  team_b: GroupTeamParticipant; // Right-side team
}

export interface KnockoutQualifier {
  team_id: UUID;
  team_name: string;
  group_code: string;
  group_rank: 1 | 2; // 1st or 2nd place
}

/**
 * Berger / circle-method round-robin algorithm that strictly enforces:
 * 1. Every team plays every other team in the group exactly once (FR-COMP-012).
 * 2. Left vs Right host count difference for every team is <= 1 (FR-COMP-013, D-034).
 * 
 * Works deterministically for 4-team and 5-team groups (and any size).
 */
export function generateBalancedRoundRobin(
  teams: GroupTeamParticipant[]
): ScheduledMatchPair[] {
  const n = teams.length;
  if (n < 2) {
    return [];
  }

  // If odd number of teams, add a dummy BYE team at the end
  const isOdd = n % 2 !== 0;
  const numParticipants = isOdd ? n + 1 : n;
  const numRounds = numParticipants - 1;
  const half = numParticipants / 2;

  const matches: ScheduledMatchPair[] = [];
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();

  for (const team of teams) {
    leftCounts.set(team.team_id, 0);
    rightCounts.set(team.team_id, 0);
  }

  for (let r = 0; r < numRounds; r++) {
    // Fixed match: fixed team (numParticipants - 1) against team r
    const fixedIndex = numParticipants - 1;
    const oppIndex = r;

    const isFixedDummy = isOdd && fixedIndex === n;
    const isOppDummy = isOdd && oppIndex === n;

    if (!isFixedDummy && !isOppDummy) {
      // Alternate home/away for the fixed team
      const fixedTeam = teams[fixedIndex]!;
      const oppTeam = teams[oppIndex]!;

      let left: GroupTeamParticipant;
      let right: GroupTeamParticipant;

      if (r % 2 === 0) {
        // fixed team is away (Right)
        left = oppTeam;
        right = fixedTeam;
      } else {
        // fixed team is home (Left)
        left = fixedTeam;
        right = oppTeam;
      }

      matches.push({ round: r + 1, team_a: left, team_b: right });
      leftCounts.set(left.team_id, (leftCounts.get(left.team_id) || 0) + 1);
      rightCounts.set(right.team_id, (rightCounts.get(right.team_id) || 0) + 1);
    }

    // Rotating matches
    for (let k = 1; k < half; k++) {
      const idx1 = (r + k) % (numParticipants - 1);
      const idx2 = (r - k + (numParticipants - 1)) % (numParticipants - 1);

      const is1Dummy = isOdd && idx1 === n;
      const is2Dummy = isOdd && idx2 === n;

      if (is1Dummy || is2Dummy) {
        continue;
      }

      const team1 = teams[idx1]!;
      const team2 = teams[idx2]!;

      let left: GroupTeamParticipant;
      let right: GroupTeamParticipant;

      if (k % 2 === 1) {
        left = team1;
        right = team2;
      } else {
        left = team2;
        right = team1;
      }

      matches.push({ round: r + 1, team_a: left, team_b: right });
      leftCounts.set(left.team_id, (leftCounts.get(left.team_id) || 0) + 1);
      rightCounts.set(right.team_id, (rightCounts.get(right.team_id) || 0) + 1);
    }
  }

  // Strict assertion: |left - right| <= 1 for all teams
  for (const team of teams) {
    const left = leftCounts.get(team.team_id) || 0;
    const right = rightCounts.get(team.team_id) || 0;
    const diff = Math.abs(left - right);
    if (diff > 1) {
      throw new Error(
        `Side balance violation for team ${team.team_name} (${team.team_id}): Left=${left}, Right=${right}, Diff=${diff} > 1`
      );
    }
  }

  return matches;
}

/**
 * Generates and stores all group stage fixtures for a tournament.
 */
export async function generateGroupStageFixtures(
  db: Client,
  tournamentId: string
): Promise<Fixture[]> {
  // Retrieve groups for this tournament via group_draws
  const groupsResult = await db.execute({
    sql: `
      SELECT g.id, g.group_code
      FROM groups g
      JOIN group_draws gd ON g.draw_id = gd.id
      WHERE gd.tournament_id = ?
      ORDER BY g.display_order ASC
    `,
    args: [tournamentId],
  });

  if (groupsResult.rows.length === 0) {
    throw new Error('Tidak ada grup yang ditemukan. Jalankan draw terlebih dahulu.');
  }

  const generatedFixtures: Fixture[] = [];
  const now: ISODateString = new Date().toISOString();

  for (const gRow of groupsResult.rows) {
    const groupId = String(gRow.id ?? (gRow as { id?: unknown }).id);

    // Fetch members of this group
    const membersResult = await db.execute({
      sql: `
        SELECT t.id as team_id, t.team_name, gm.draw_position
        FROM group_members gm
        JOIN teams t ON gm.team_id = t.id
        WHERE gm.group_id = ?
        ORDER BY gm.draw_position ASC
      `,
      args: [groupId],
    });

    const participants: GroupTeamParticipant[] = membersResult.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        team_id: String(row.team_id),
        team_name: String(row.team_name),
        draw_position: Number(row.draw_position),
      };
    });

    const scheduledMatches = generateBalancedRoundRobin(participants);

    for (const match of scheduledMatches) {
      const fixtureId: UUID = randomUUID();
      const roundCode = `ROUND_${match.round}`;

      const fixture: Fixture = {
        id: fixtureId,
        tournament_id: tournamentId,
        stage: 'GROUP',
        group_id: groupId,
        round_code: roundCode,
        team_a_id: match.team_a.team_id,
        team_b_id: match.team_b.team_id,
        left_side_team_id: match.team_a.team_id, // Assigned at fixture generation time (FR-COMP-013)
        scheduled_at: null,
        timezone: 'Asia/Jakarta',
        host_team_id: null,
        host_assignment_reason: 'DEFAULT_LEFT_SIDE',
        status: 'SCHEDULED',
        created_at: now,
        updated_at: now,
      };

      await db.execute({
        sql: `
          INSERT INTO fixtures (
            id, tournament_id, stage, group_id, round_code,
            team_a_id, team_b_id, left_side_team_id, scheduled_at,
            timezone, host_team_id, host_assignment_reason, status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          fixture.id,
          fixture.tournament_id,
          fixture.stage,
          fixture.group_id,
          fixture.round_code,
          fixture.team_a_id,
          fixture.team_b_id,
          fixture.left_side_team_id,
          fixture.scheduled_at,
          fixture.timezone,
          fixture.host_team_id,
          fixture.host_assignment_reason,
          fixture.status,
          fixture.created_at,
          fixture.updated_at,
        ],
      });

      // Group stage fixtures consist of exactly 1 game
      const gameId: UUID = randomUUID();
      await db.execute({
        sql: `
          INSERT INTO games (
            id, fixture_id, series_id, game_number, status,
            team_a_score, team_b_score, winner_team_id, is_draw,
            is_walkover, walkover_type, evidence_status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          gameId,
          fixtureId,
          null,
          1,
          'SCHEDULED',
          null,
          null,
          null,
          0,
          0,
          'NONE',
          'PENDING',
          now,
          now,
        ],
      });

      generatedFixtures.push(fixture);
    }
  }

  return generatedFixtures;
}

/**
 * Generates Knockout Stage bracket pairings from qualified teams (FR-COMP-011, D-010, D-011).
 * Exactly 2 teams qualify per group: 1st place and 2nd place.
 * Knockout format: BO3 before final; BO5 for Grand Final.
 */
export interface GenerateKnockoutOptions {
  /**
   * BRACKET-REDRAW (Arya decision, 21 Nov 2026): for SECOND-AND-LATER knockout
   * rounds the surviving teams are RE-DRAWN (re-paired) each round instead of
   * being mapped from the previous round's fixture order. The shuffle function
   * is injectable so tests can make the draw deterministic; production passes
   * cryptoFisherYates (same primitive as the group-stage !draw).
   */
  shuffle?: <T>(array: T[]) => T[];
}

/**
 * Canonical knockout round progression, from widest to narrowest. Round labels
 * are derived from this order so every round of a tournament gets a UNIQUE,
 * human-readable label that reflects how far the bracket has progressed.
 */
const KNOCKOUT_ROUND_PROGRESSION = [
  'ROUND_OF_32',
  'ROUND_OF_16',
  'QUARTER_FINAL',
  'SEMI_FINAL',
  'FINAL',
] as const;

/**
 * REVIEW-FIX blocker-roundcode (21 Nov 2026): the round label used to be
 * derived from the NUMBER OF FIXTURES in the round being created
 * (1->FINAL, 2->SEMI_FINAL, 4->QUARTER_FINAL, else->ROUND_OF_16). Two
 * different rounds can produce the same fixture count (e.g. a 6-group
 * tournament: 12 qualifiers -> 6 fixtures, then 6 winners -> 3 fixtures
 * labeled ROUND_OF_16 AGAIN by the old default). Because !startknockout
 * collects winners via `WHERE round_code = <label>`, a repeated label makes
 * it resurrect teams that were already eliminated — the tournament never
 * converges to a final.
 *
 * The label is now derived from the tournament's ACTUAL round history in the
 * DB: pick the natural label for this fixture count, but if it (or any
 * earlier label) is already taken, advance along the progression to the next
 * unused label; if the whole progression is exhausted (very large brackets,
 * or repeated odd-survivor rounds), fall back to a unique generic
 * KNOCKOUT_ROUND_<n> label so labels can never collide.
 */
export async function deriveKnockoutRoundCode(
  db: Client,
  tournamentId: string,
  matchCount: number
): Promise<string> {
  const usedRes = await db.execute({
    sql: `SELECT DISTINCT round_code FROM fixtures
          WHERE tournament_id = ? AND stage = 'KNOCKOUT' AND round_code IS NOT NULL`,
    args: [tournamentId],
  });
  const used = new Set(
    usedRes.rows.map((r) => String((r as { round_code?: unknown }).round_code ?? ''))
  );

  // Natural label for this bracket size (what participants expect to read).
  // REVIEW-FIX: a single-fixture round is ALWAYS the FINAL in this system
  // (the next round after it ends the tournament), even when earlier rounds
  // took the "FINAL" slot of the progression — a 2-survivor round is the
  // last one by definition, so it is named FINAL regardless.
  const natural =
    matchCount === 1
      ? 'FINAL'
      : matchCount === 2
        ? 'SEMI_FINAL'
        : matchCount === 4
          ? 'QUARTER_FINAL'
          : matchCount === 8
            ? 'ROUND_OF_16'
            : matchCount === 16
              ? 'ROUND_OF_32'
              : null;

  // A 1-match round is always the FINAL, never a duplicate label.
  if (natural === 'FINAL') return 'FINAL';

  const order = [...KNOCKOUT_ROUND_PROGRESSION];
  // Where to start scanning for a free label:
  // - With a natural label (standard bracket sizes), start there — a normal
  //   16-team tournament still reads QF -> SF -> FINAL exactly as before.
  // - Without one (odd survivor pools, e.g. 3 fixtures), start AFTER the
  //   DEEPEST label already used, so the label always NARROWS (a round that
  //   follows ROUND_OF_16 becomes QUARTER_FINAL, never a wider ROUND_OF_32).
  let startIndex: number;
  if (natural) {
    startIndex = order.indexOf(natural);
  } else {
    let deepestUsed = -1;
    for (let i = 0; i < order.length; i++) {
      if (used.has(order[i]!)) deepestUsed = i;
    }
    startIndex = deepestUsed + 1;
  }
  for (let i = Math.max(0, startIndex); i < order.length; i++) {
    if (!used.has(order[i]!)) return order[i]!;
  }

  // Progression exhausted: unique generic label (never collides).
  let n = used.size + 1;
  while (used.has(`KNOCKOUT_ROUND_${n}`)) n++;
  return `KNOCKOUT_ROUND_${n}`;
}

export async function generateKnockoutFixtures(
  db: Client,
  tournamentId: string,
  qualifiers: KnockoutQualifier[],
  options?: GenerateKnockoutOptions
): Promise<{ fixtures: Fixture[]; series: Series[]; byeTeamId: string | null }> {
  if (qualifiers.length < 2) {
    throw new Error('Minimal 2 tim yang lolos untuk membentuk bracket Knockout');
  }

  // D-032 revised safety net: a team can never be paired against itself.
  const uniqueTeamIds = new Set(qualifiers.map((q) => q.team_id));
  if (uniqueTeamIds.size !== qualifiers.length) {
    throw new Error('Bracket tidak valid: ada tim yang dipasangkan dengan dirinya sendiri (kualifikasi duplikat).');
  }

  // AUDIT-VERIFY-T2 (21 Nov 2026): an ODD number of survivors (e.g. 3 after a
  // D-032 double-loss bye in the previous round) used to make
  // winners.length !== runnersUp.length and throw, deadlocking the bracket.
  // Instead, grant a BYE to the LAST qualifier: it advances without playing,
  // and the remaining even pool is paired (adjacent rotation when balanced,
  // sequential pairing otherwise). The bye recipient is reported via the
  // return value so the group announcement can explain it.
  let byeQualifier: KnockoutQualifier | null = null;
  if (qualifiers.length % 2 === 1) {
    byeQualifier = qualifiers[qualifiers.length - 1]!;
  }
  let pool = byeQualifier ? qualifiers.slice(0, -1) : qualifiers;

  const winners = pool.filter((q) => q.group_rank === 1);
  const runnersUp = pool.filter((q) => q.group_rank === 2);

  const now: ISODateString = new Date().toISOString();
  const createdFixtures: Fixture[] = [];
  const createdSeries: Series[] = [];

  const firstRoundMatches: { team_a: KnockoutQualifier; team_b: KnockoutQualifier }[] = [];

  // BRACKET-REDRAW: when a shuffle function is supplied (later rounds via
  // !startknockout), the pool is re-drawn: shuffle first, then pair
  // sequentially. This makes the pairing independent of any previous round's
  // fixture order/indices. Without a shuffle (first knockout round derived
  // from group standings), the classic seeding is kept:
  const hasRealGroupSeeding = winners.length === runnersUp.length && winners.length > 0;

  if (options?.shuffle) {
    const drawn = options.shuffle(pool);
    // REVIEW-FIX quickwin-shuffle-validation (21 Nov 2026): the old check
    // used Set identity of the ARRAY ELEMENTS (object references), so a
    // tampered shuffle that returned NEW objects with swapped/duplicated
    // team_ids passed validation and could produce a self-match X vs X.
    // The draw is now validated by team_id multiset: the drawn pool must
    // contain EXACTLY the same team ids as the pre-draw pool (no team
    // added, dropped, duplicated, or mutated).
    const poolIds = pool.map((q) => q.team_id).sort();
    const drawnIds = drawn.map((q) => q.team_id).sort();
    const idsMatch =
      poolIds.length === drawnIds.length && poolIds.every((id, i) => id === drawnIds[i]);
    if (drawn.length !== pool.length || !idsMatch) {
      throw new Error('Draw ulang bracket tidak valid: hasil shuffle mengubah jumlah/isi tim.');
    }
    pool = drawn;
    for (let i = 0; i + 1 < pool.length; i += 2) {
      firstRoundMatches.push({ team_a: pool[i]!, team_b: pool[i + 1]! });
    }
  } else if (hasRealGroupSeeding) {
    // First knockout round from group standings: pair winners against adjacent
    // group runners-up so no same-group rematch (Winner Group i vs Runner-up
    // Group (i + 1) % numGroups). Winner is assigned left side (host
    // recommendation).
    const numGroups = winners.length;
    for (let i = 0; i < numGroups; i++) {
      const winner = winners[i]!;
      const runnerUpIndex = (i + 1) % numGroups;
      const runnerUp = runnersUp[runnerUpIndex]!;
      firstRoundMatches.push({ team_a: winner, team_b: runnerUp });
    }
  } else {
    // Unbalanced sides without a shuffle (defensive; !startknockout always
    // passes one): pair the even pool sequentially in qualifier order.
    for (let i = 0; i + 1 < pool.length; i += 2) {
      firstRoundMatches.push({ team_a: pool[i]!, team_b: pool[i + 1]! });
    }
  }

  // REVIEW-FIX blocker-roundcode (21 Nov 2026): the label is derived from the
  // tournament's EXISTING knockout rounds (see deriveKnockoutRoundCode), so a
  // second round with the "default" fixture count can never reuse a label
  // that is already in the DB (which used to resurrect eliminated teams via
  // !startknockout's per-label winner collection).
  const roundCode = await deriveKnockoutRoundCode(db, tournamentId, firstRoundMatches.length);

  for (const match of firstRoundMatches) {
    const fixtureId: UUID = randomUUID();
    const seriesId: UUID = randomUUID();

    const isGrandFinal = roundCode === 'FINAL';
    const seriesFormat = isGrandFinal ? 'BO5' : 'BO3';
    const targetWins = isGrandFinal ? 3 : 2;

    const fixture: Fixture = {
      id: fixtureId,
      tournament_id: tournamentId,
      stage: 'KNOCKOUT',
      group_id: null,
      round_code: roundCode,
      team_a_id: match.team_a.team_id,
      team_b_id: match.team_b.team_id,
      left_side_team_id: match.team_a.team_id,
      scheduled_at: null,
      timezone: 'Asia/Jakarta',
      host_team_id: null,
      host_assignment_reason: 'DEFAULT_LEFT_SIDE',
      status: 'SCHEDULED',
      created_at: now,
      updated_at: now,
    };

    const s: Series = {
      id: seriesId,
      fixture_id: fixtureId,
      format: seriesFormat,
      target_wins: targetWins,
      status: 'PENDING',
      winner_team_id: null,
      team_a_game_wins: 0,
      team_b_game_wins: 0,
      created_at: now,
      updated_at: now,
    };

    await db.execute({
      sql: `
        INSERT INTO fixtures (
          id, tournament_id, stage, group_id, round_code,
          team_a_id, team_b_id, left_side_team_id, scheduled_at,
          timezone, host_team_id, host_assignment_reason, status,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        fixture.id,
        fixture.tournament_id,
        fixture.stage,
        fixture.group_id,
        fixture.round_code,
        fixture.team_a_id,
        fixture.team_b_id,
        fixture.left_side_team_id,
        fixture.scheduled_at,
        fixture.timezone,
        fixture.host_team_id,
        fixture.host_assignment_reason,
        fixture.status,
        fixture.created_at,
        fixture.updated_at,
      ],
    });

    await db.execute({
      sql: `
        INSERT INTO series (
          id, fixture_id, format, target_wins, status,
          winner_team_id, team_a_game_wins, team_b_game_wins,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        s.id,
        s.fixture_id,
        s.format,
        s.target_wins,
        s.status,
        s.winner_team_id,
        s.team_a_game_wins,
        s.team_b_game_wins,
        s.created_at,
        s.updated_at,
      ],
    });

    createdFixtures.push(fixture);
    createdSeries.push(s);
  }

  // AUDIT-VERIFY-T2: report the bye recipient (if any) so the caller can
  // announce WHO advanced without playing and WHY (odd survivor pool).
  return { fixtures: createdFixtures, series: createdSeries, byeTeamId: byeQualifier?.team_id ?? null };
}

/**
 * Derives Knockout Stage qualifiers from final persisted group standings:
 * exactly the top 2 teams of every group (O-004, FR-COMP-011).
 * Rejects when any group has unresolved tied ranks at the qualifying cut.
 *
 * AUDIT-VERIFY-T15 (21 Nov 2026): ranking is computed by the same engine
 * !standings uses (computeGroupStandings via recalculateAndPersistGroupStandings).
 * The old raw SQL ordered by points/GD/GF only, which diverged from
 * !standings whenever head-to-head resolved a tie (H2H GD/GF are not
 * persisted in the standings table, so SQL alone could never replicate it)
 * and could qualify a different runner-up than the table shown to
 * participants. A COMPLETE tie at the cut (incl. head-to-head) still throws
 * and asks the organizer to resolve it manually.
 */
export async function deriveKnockoutQualifiers(
  db: Client,
  tournamentId: string
): Promise<KnockoutQualifier[]> {
  const groupsRes = await db.execute({
    sql: `
      SELECT DISTINCT g.id, g.group_code
      FROM groups g
      JOIN group_draws gd ON g.draw_id = gd.id
      WHERE gd.tournament_id = ?
      ORDER BY g.display_order ASC
    `,
    args: [tournamentId],
  });

  if (groupsRes.rows.length === 0) {
    throw new Error('Tidak ada grup yang ditemukan. Jalankan draw terlebih dahulu.');
  }

  const qualifiers: KnockoutQualifier[] = [];

  for (const gRow of groupsRes.rows) {
    const groupId = String((gRow as Record<string, unknown>).id);
    const groupCode = String((gRow as Record<string, unknown>).group_code);

    // AUDIT-VERIFY-T15: rank via the SAME engine !standings uses. The old
    // raw-SQL ordering (points/GD/GF only) diverged from computeGroupStandings
    // whenever a tie was resolved by head-to-head (H2H points, and H2H GD/GF
    // which are not even persisted in the standings table), so the bracket
    // could qualify a different runner-up than the table shown to
    // participants. Recomputing here guarantees identical ordering and also
    // refreshes the persisted projection.
    const standings = await recalculateAndPersistGroupStandings(db, tournamentId, groupId);

    if (standings.length < 2) {
      throw new Error(
        `Klasemen grup ${groupCode} belum lengkap untuk menentukan kualifikasi knockout.`
      );
    }

    const first = standings[0]!;
    const second = standings[1]!;

    // Policy guard kept from the original implementation: a COMPLETE tie at
    // the qualifying cut (points, GD, GF, and head-to-head all equal — the
    // table order would then rest on team-name alphabetical order only) must
    // be resolved by the organizer, not silently by name order.
    const firstKey = `${first.points}-${first.goal_difference}-${first.goals_for}-${first.head_to_head_points}`;
    const secondKey = `${second.points}-${second.goal_difference}-${second.goals_for}-${second.head_to_head_points}`;

    if (firstKey === secondKey) {
      throw new Error(
        `Peringkat 1 dan 2 di grup ${groupCode} masih seri penuh (poin, selisih gol, gol dicetak, head-to-head). ` +
        'Tidak dapat menentukan kualifikasi knockout secara adil. ' +
        'Panitia harus menyelesaikan seri tersebut terlebih dahulu (misal via pertandingan tambahan atau keputusan manual).'
      );
    }

    qualifiers.push({
      team_id: first.team_id,
      team_name: first.team_name,
      group_code: groupCode,
      group_rank: 1,
    });
    qualifiers.push({
      team_id: second.team_id,
      team_name: second.team_name,
      group_code: groupCode,
      group_rank: 2,
    });
  }

  return qualifiers;
}

/**
 * Retrieves fixtures for a tournament, optionally filtered by stage and group.
 */
export async function getFixtures(
  db: Client,
  tournamentId: string,
  options?: { stage?: 'GROUP' | 'KNOCKOUT'; groupId?: string }
): Promise<Fixture[]> {
  let sql = 'SELECT * FROM fixtures WHERE tournament_id = ?';
  const args: (string | number)[] = [tournamentId];

  if (options?.stage) {
    sql += ' AND stage = ?';
    args.push(options.stage);
  }
  if (options?.groupId) {
    sql += ' AND group_id = ?';
    args.push(options.groupId);
  }

  sql += ' ORDER BY created_at ASC';

  const result = await db.execute({ sql, args });
  return result.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      tournament_id: String(row.tournament_id),
      stage: row.stage as Fixture['stage'],
      group_id: row.group_id ? String(row.group_id) : null,
      round_code: row.round_code ? String(row.round_code) : null,
      team_a_id: String(row.team_a_id),
      team_b_id: String(row.team_b_id),
      left_side_team_id: String(row.left_side_team_id),
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      timezone: String(row.timezone),
      host_team_id: row.host_team_id ? String(row.host_team_id) : null,
      host_assignment_reason: row.host_assignment_reason as Fixture['host_assignment_reason'],
      status: row.status as Fixture['status'],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });
}
