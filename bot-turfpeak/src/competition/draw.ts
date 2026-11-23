/**
 * Flash Peak TMS - Draw Service
 * 
 * Handles cryptographically secure group draw, programmatic group sizing,
 * persist-before-reveal, and progressive reveal with resume-on-restart.
 */

import { randomUUID, randomInt, createHash, randomBytes } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  GroupDraw,
  GroupConfigJson,
  EligibleTeamSnapshotItem,
  DrawResultGroupAssignment,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { groupConfigJsonSchema } from '../shared/schemas/index.js';

export interface RevealItem {
  reveal_index: number;
  group_code: string;
  draw_position: number;
  team_id: UUID;
  team_name: string;
}

export interface RevealStepResult {
  is_complete: boolean;
  item: RevealItem | null;
  revealed_count: number;
  total_teams: number;
  status: 'PREPARED' | 'REVEALING' | 'COMPLETED';
  commitment_hash: string | null;
  seed_reveal: string | null;
  current_groups: DrawResultGroupAssignment[];
}

/**
 * Helper to generate group letter codes (A, B, C, ..., Z, AA, AB, ...)
 */
export function getGroupCode(index: number): string {
  let code = '';
  let temp = index;
  while (temp >= 0) {
    code = String.fromCharCode(65 + (temp % 26)) + code;
    temp = Math.floor(temp / 26) - 1;
  }
  return code;
}

/**
 * Programmatic group sizing (FR-COMP-010, D-026/027).
 * Batches of 5, remainder groups of 4. NEVER < 4 or > 5.
 *
 * Sizing rules:
 * - For total registered teams < 8: REJECT with clear descriptive error.
 *   "Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim"
 *   NEVER create a single group silently!
 * - Always forms groups of either 5 or 4 teams.
 * - Exactly 2 teams qualify per group regardless of size (FR-COMP-011).
 */
export interface GroupSizingOptions {
  /**
   * Target group size the organizer wants (e.g. 5 for "semua grup 5 tim").
   * Sizing fills groups of `target` first, then one step lower to absorb the
   * remainder. Must be 4 or 5 (FR-COMP-010: only these sizes are legal).
   */
  targetGroupSize?: number;
}

export function computeGroupSizing(
  totalTeams: number,
  options?: GroupSizingOptions
): GroupConfigJson {
  if (totalTeams < 8) {
    throw new Error(
      'Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim'
    );
  }

  // FIX2-COMP-DYN: dynamic target group size. Default stays the FR-COMP-010
  // behaviour (5 first, remainder 4). With targetGroupSize the algorithm fills
  // groups of the target size first, then the SMALLER legal size absorbs the
  // remainder — so "semua grup 5" needs a team count expressible as 5a + 4b
  // (e.g. 10/20/25/40), exactly the constraint documented in the FAQ.
  const target = options?.targetGroupSize ?? 5;
  if (target !== 5 && target !== 4) {
    throw new Error(
      `Ukuran grup target (${target}) tidak valid — hanya 4 atau 5 tim per grup yang diizinkan (FR-COMP-010)`
    );
  }
  const secondary = target === 5 ? 4 : 5;

  // Find non-negative integers gT (target-size groups) and gS (secondary-size
  // groups) such that T*gT + S*gS == totalTeams, maximizing gT (batches of the
  // target size first, like the original 5-first/4-remainder behaviour).
  let gT = Math.floor(totalTeams / target);
  let gS = -1;

  while (gT >= 0) {
    const remainder = totalTeams - target * gT;
    if (remainder % secondary === 0) {
      gS = remainder / secondary;
      break;
    }
    gT--;
  }

  if (gS === -1) {
    throw new Error(
      `Jumlah tim (${totalTeams}) tidak dapat dibagi menjadi kombinasi grup ${target} dan ${secondary}`
    );
  }

  const numGroups = gT + gS;
  if (numGroups < 2) {
    throw new Error(
      'Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim'
    );
  }

  // Put target-size groups first, then remainder/secondary-size groups
  const groupSizes: number[] = [
    ...Array<number>(gT).fill(target),
    ...Array<number>(gS).fill(secondary),
  ];

  const groupCodes = groupSizes.map((_, i) => getGroupCode(i));

  const config: GroupConfigJson = {
    total_teams: totalTeams,
    num_groups: numGroups,
    group_sizes: groupSizes,
    group_codes: groupCodes,
    qualifiers_per_group: 2, // Fixed top 2 per group (FR-COMP-011)
  };

  return groupConfigJsonSchema.parse(config);
}

/**
 * Cryptographically secure Fisher-Yates shuffle (FR-COMP-003).
 * Uses node:crypto randomInt for unbiased distribution.
 */
export function cryptoFisherYates<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
}

/**
 * Computes pre-reveal SHA-256 commitment hash.
 */
export function computeCommitmentHash(
  assignment: DrawResultGroupAssignment[],
  salt: string
): string {
  return createHash('sha256')
    .update(`${salt}:${JSON.stringify(assignment)}`)
    .digest('hex');
}

/**
 * Flattens group assignments into an ordered reveal sequence.
 * Reveals Position 1 across all groups, then Position 2 across all groups, etc.
 */
export function buildRevealSequence(
  assignment: DrawResultGroupAssignment[]
): RevealItem[] {
  const items: RevealItem[] = [];
  const maxTeamsInAnyGroup = Math.max(
    ...assignment.map((g) => g.teams.length),
    0
  );

  let revealIdx = 0;
  for (let pos = 1; pos <= maxTeamsInAnyGroup; pos++) {
    for (const group of assignment) {
      const teamInPos = group.teams.find((t) => t.draw_position === pos);
      if (teamInPos) {
        items.push({
          reveal_index: revealIdx++,
          group_code: group.group_code,
          draw_position: teamInPos.draw_position,
          team_id: teamInPos.team_id,
          team_name: teamInPos.team_name,
        });
      }
    }
  }

  return items;
}

/**
 * Prepares and persists the full draw to the database before any reveal message (FR-COMP-004).
 * If a draw already exists (in PREPARED or REVEALING status), returns the existing draw without rerolling (FR-COMP-006).
 */
export async function prepareDraw(
  db: Client,
  tournamentId: string,
  options?: { forceNew?: boolean; groupSizing?: GroupSizingOptions }
): Promise<GroupDraw> {
  // Check for existing draw for this tournament
  const existingResult = await db.execute({
    sql: 'SELECT * FROM group_draws WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1',
    args: [tournamentId],
  });

  if (existingResult.rows.length > 0 && !options?.forceNew) {
    const row = existingResult.rows[0] as unknown as Record<string, unknown>;
    const status = String(row.status);
    if (status === 'PREPARED' || status === 'REVEALING' || status === 'COMPLETED') {
      return {
        id: String(row.id),
        tournament_id: String(row.tournament_id),
        status: row.status as GroupDraw['status'],
        group_config_json: String(row.group_config_json),
        eligible_team_snapshot_json: String(row.eligible_team_snapshot_json),
        algorithm: String(row.algorithm),
        algorithm_version: String(row.algorithm_version),
        commitment_hash: row.commitment_hash ? String(row.commitment_hash) : null,
        seed_reveal: row.seed_reveal ? String(row.seed_reveal) : null,
        result_json: row.result_json ? String(row.result_json) : null,
        next_reveal_index: Number(row.next_reveal_index),
        created_at: String(row.created_at),
        completed_at: row.completed_at ? String(row.completed_at) : null,
      };
    }
  }

  // Fetch eligible (VERIFIED) teams
  const teamsResult = await db.execute({
    sql: `
      SELECT id, team_name, organization_name, division_name, delegate_id
      FROM teams
      WHERE tournament_id = ? AND registration_status = 'VERIFIED'
      ORDER BY team_name ASC
    `,
    args: [tournamentId],
  });

  const verifiedTeams = teamsResult.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      team_id: String(row.id),
      team_name: String(row.team_name),
      organization_name: row.organization_name ? String(row.organization_name) : null,
      division_name: row.division_name ? String(row.division_name) : null,
      delegate_id: String(row.delegate_id || ''),
    } satisfies EligibleTeamSnapshotItem;
  });

  if (verifiedTeams.length < 8) {
    throw new Error(
      'Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim'
    );
  }

  // Programmatic group sizing
  const groupConfig = computeGroupSizing(verifiedTeams.length, options?.groupSizing);

  // Cryptographically secure shuffle
  const shuffledTeams = cryptoFisherYates(verifiedTeams);

  // Partition teams into groups
  const assignment: DrawResultGroupAssignment[] = [];
  let teamOffset = 0;

  for (let i = 0; i < groupConfig.num_groups; i++) {
    const groupCode = groupConfig.group_codes[i]!;
    const size = groupConfig.group_sizes[i]!;
    const groupTeams = shuffledTeams.slice(teamOffset, teamOffset + size);

    assignment.push({
      group_code: groupCode,
      teams: groupTeams.map((t, idx) => ({
        team_id: t.team_id,
        team_name: t.team_name,
        draw_position: idx + 1,
      })),
    });

    teamOffset += size;
  }

  const drawId: UUID = randomUUID();
  const now: ISODateString = new Date().toISOString();
  const seedSecret = randomBytes(16).toString('hex');
  const commitmentHash = computeCommitmentHash(assignment, seedSecret);

  const draw: GroupDraw = {
    id: drawId,
    tournament_id: tournamentId,
    status: 'PREPARED',
    group_config_json: JSON.stringify(groupConfig),
    eligible_team_snapshot_json: JSON.stringify(verifiedTeams),
    algorithm: 'FISHER_YATES_CRYPTO',
    algorithm_version: '1.0.0',
    commitment_hash: commitmentHash,
    seed_reveal: seedSecret,
    result_json: JSON.stringify(assignment),
    next_reveal_index: 0,
    created_at: now,
    completed_at: null,
  };

  // Persist draw, groups, and group_members in DB
  await db.execute({
    sql: `
      INSERT INTO group_draws (
        id, tournament_id, status, group_config_json, eligible_team_snapshot_json,
        algorithm, algorithm_version, commitment_hash, seed_reveal, result_json,
        next_reveal_index, created_at, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      draw.id,
      draw.tournament_id,
      draw.status,
      draw.group_config_json,
      draw.eligible_team_snapshot_json,
      draw.algorithm,
      draw.algorithm_version,
      draw.commitment_hash,
      draw.seed_reveal,
      draw.result_json,
      draw.next_reveal_index,
      draw.created_at,
      draw.completed_at,
    ],
  });

  for (let i = 0; i < assignment.length; i++) {
    const group = assignment[i]!;
    const groupId = randomUUID();

    await db.execute({
      sql: 'INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, ?, ?)',
      args: [groupId, drawId, group.group_code, i + 1],
    });

    for (const member of group.teams) {
      await db.execute({
        sql: 'INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)',
        args: [groupId, member.team_id, member.draw_position],
      });
    }
  }

  // Audit trail
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'SYSTEM',
      'DRAW_ENGINE',
      'GROUP_DRAW_PREPARED',
      'GROUP_DRAW',
      drawId,
      null,
      JSON.stringify({
        total_teams: verifiedTeams.length,
        num_groups: groupConfig.num_groups,
        commitment_hash: commitmentHash,
      }),
      'Initial cryptographically randomized group draw generated and committed',
      randomUUID(),
      now,
    ],
  });

  return draw;
}

/**
 * Retrieves a GroupDraw record by ID.
 */
export async function getDraw(db: Client, drawId: string): Promise<GroupDraw | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM group_draws WHERE id = ?',
    args: [drawId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    tournament_id: String(row.tournament_id),
    status: row.status as GroupDraw['status'],
    group_config_json: String(row.group_config_json),
    eligible_team_snapshot_json: String(row.eligible_team_snapshot_json),
    algorithm: String(row.algorithm),
    algorithm_version: String(row.algorithm_version),
    commitment_hash: row.commitment_hash ? String(row.commitment_hash) : null,
    seed_reveal: row.seed_reveal ? String(row.seed_reveal) : null,
    result_json: row.result_json ? String(row.result_json) : null,
    next_reveal_index: Number(row.next_reveal_index),
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

/**
 * Retrieves the latest draw for a tournament.
 */
export async function getDrawByTournament(
  db: Client,
  tournamentId: string
): Promise<GroupDraw | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM group_draws WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1',
    args: [tournamentId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    tournament_id: String(row.tournament_id),
    status: row.status as GroupDraw['status'],
    group_config_json: String(row.group_config_json),
    eligible_team_snapshot_json: String(row.eligible_team_snapshot_json),
    algorithm: String(row.algorithm),
    algorithm_version: String(row.algorithm_version),
    commitment_hash: row.commitment_hash ? String(row.commitment_hash) : null,
    seed_reveal: row.seed_reveal ? String(row.seed_reveal) : null,
    result_json: row.result_json ? String(row.result_json) : null,
    next_reveal_index: Number(row.next_reveal_index),
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

/**
 * Advances the progressive reveal state by exactly one team (FR-COMP-005, FR-COMP-006).
 * Safe against restarts: always reads and advances next_reveal_index from the DB.
 */
export async function revealNext(
  db: Client,
  drawId: string
): Promise<RevealStepResult> {
  const draw = await getDraw(db, drawId);
  if (!draw) {
    throw new Error(`Group draw with id '${drawId}' not found`);
  }

  if (!draw.result_json) {
    throw new Error('Draw result_json is missing or corrupted');
  }

  const assignment = JSON.parse(draw.result_json) as DrawResultGroupAssignment[];
  const revealItems = buildRevealSequence(assignment);
  const totalTeams = revealItems.length;

  if (draw.next_reveal_index >= totalTeams) {
    return {
      is_complete: true,
      item: null,
      revealed_count: totalTeams,
      total_teams: totalTeams,
      status: 'COMPLETED',
      commitment_hash: draw.commitment_hash,
      seed_reveal: draw.seed_reveal,
      current_groups: assignment,
    };
  }

  const currentItem = revealItems[draw.next_reveal_index]!;
  const nextIndex = draw.next_reveal_index + 1;
  const isComplete = nextIndex >= totalTeams;
  const newStatus: GroupDraw['status'] = isComplete ? 'COMPLETED' : 'REVEALING';
  const now = new Date().toISOString();
  const completedAt = isComplete ? now : null;

  await db.execute({
    sql: `
      UPDATE group_draws
      SET next_reveal_index = ?, status = ?, completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
    `,
    args: [nextIndex, newStatus, completedAt, drawId],
  });

  if (isComplete) {
    await db.execute({
      sql: `
        INSERT INTO audit_events (
          id, actor_type, actor_id, event_type, entity_type, entity_id,
          before_json, after_json, reason, correlation_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        randomUUID(),
        'SYSTEM',
        'DRAW_ENGINE',
        'GROUP_DRAW_COMPLETED',
        'GROUP_DRAW',
        drawId,
        JSON.stringify({ revealed_count: draw.next_reveal_index }),
        JSON.stringify({ revealed_count: totalTeams, status: 'COMPLETED' }),
        'All teams progressively revealed and commitment seed disclosed',
        randomUUID(),
        now,
      ],
    });
  }

  return {
    is_complete: isComplete,
    item: currentItem,
    revealed_count: nextIndex,
    total_teams: totalTeams,
    status: newStatus,
    commitment_hash: draw.commitment_hash,
    seed_reveal: isComplete ? draw.seed_reveal : null,
    current_groups: assignment,
  };
}
