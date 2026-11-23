/**
 * Flash Peak TMS - Tournament Engine
 * 
 * Manages tournament CRUD, lifecycle state machine, and group/knockout format validation.
 * Supported format: Traditional GROUP + KNOCKOUT only (D-008, no Swiss).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Tournament,
  TournamentStatus,
  TournamentConfig,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { tournamentConfigSchema } from '../shared/schemas/index.js';

/**
 * Valid tournament lifecycle transitions:
 * DRAFT -> REGISTRATION -> ONBOARDING -> DRAW_READY -> ACTIVE -> COMPLETED -> ARCHIVED
 */
const ALLOWED_TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  DRAFT: ['REGISTRATION', 'ARCHIVED'],
  REGISTRATION: ['ONBOARDING', 'ARCHIVED'],
  ONBOARDING: ['DRAW_READY', 'REGISTRATION', 'ARCHIVED'],
  DRAW_READY: ['ACTIVE', 'ONBOARDING', 'ARCHIVED'],
  ACTIVE: ['COMPLETED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export interface CreateTournamentInput {
  name: string;
  timezone?: string;
  rules_version?: string;
  config?: Partial<TournamentConfig>;
  format?: 'GROUP_AND_KNOCKOUT' | string;
}

export interface UpdateTournamentInput {
  name?: string;
  timezone?: string;
  rules_version?: string;
  config?: Partial<TournamentConfig>;
}

/**
 * Validates that the requested competition format is supported.
 * Only GROUP + KNOCKOUT is allowed for MVP (D-008). Swiss format is strictly rejected.
 */
export function validateCompetitionFormat(format?: string): void {
  if (!format || format === 'GROUP_AND_KNOCKOUT' || format === 'GROUP_KNOCKOUT') {
    return;
  }
  if (format.toUpperCase().includes('SWISS')) {
    throw new Error(
      'Format Swiss tidak didukung. Flash Peak TMS hanya mendukung format GROUP + KNOCKOUT (D-008).'
    );
  }
  throw new Error(
    `Format '${format}' tidak didukung. Flash Peak TMS hanya mendukung format GROUP + KNOCKOUT (D-008).`
  );
}

/**
 * Validates and merges tournament configuration with system defaults.
 */
export function resolveTournamentConfig(config?: Partial<TournamentConfig>): TournamentConfig {
  return tournamentConfigSchema.parse(config ?? {});
}

/**
 * Creates a new tournament in DRAFT status.
 */
export async function createTournament(
  db: Client,
  input: CreateTournamentInput
): Promise<Tournament> {
  validateCompetitionFormat(input.format);

  const id: UUID = randomUUID();
  const now: ISODateString = new Date().toISOString();
  const config = resolveTournamentConfig(input.config);
  const configJson = JSON.stringify(config);

  const tournament: Tournament = {
    id,
    name: input.name,
    status: 'DRAFT',
    timezone: input.timezone || 'Asia/Jakarta',
    rules_version: input.rules_version || '1.0.0',
    config_json: configJson,
    created_at: now,
    updated_at: now,
  };

  await db.execute({
    sql: `
      INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      tournament.id,
      tournament.name,
      tournament.status,
      tournament.timezone,
      tournament.rules_version,
      tournament.config_json,
      tournament.created_at,
      tournament.updated_at,
    ],
  });

  return tournament;
}

/**
 * Retrieves a tournament by ID.
 */
export async function getTournament(db: Client, id: string): Promise<Tournament | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM tournaments WHERE id = ?',
    args: [id],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status as TournamentStatus,
    timezone: String(row.timezone),
    rules_version: String(row.rules_version),
    config_json: String(row.config_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Lists all tournaments.
 */
export async function listTournaments(db: Client): Promise<Tournament[]> {
  const result = await db.execute('SELECT * FROM tournaments ORDER BY created_at DESC');
  return result.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name),
      status: row.status as TournamentStatus,
      timezone: String(row.timezone),
      rules_version: String(row.rules_version),
      config_json: String(row.config_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });
}

/**
 * Updates basic tournament details.
 */
export async function updateTournament(
  db: Client,
  id: string,
  update: UpdateTournamentInput
): Promise<Tournament> {
  const current = await getTournament(db, id);
  if (!current) {
    throw new Error(`Tournament with id '${id}' not found`);
  }

  const now = new Date().toISOString();
  let updatedConfigJson = current.config_json;

  if (update.config) {
    const currentConfig = JSON.parse(current.config_json) as TournamentConfig;
    const mergedConfig = resolveTournamentConfig({ ...currentConfig, ...update.config });
    updatedConfigJson = JSON.stringify(mergedConfig);
  }

  const updated: Tournament = {
    ...current,
    name: update.name ?? current.name,
    timezone: update.timezone ?? current.timezone,
    rules_version: update.rules_version ?? current.rules_version,
    config_json: updatedConfigJson,
    updated_at: now,
  };

  await db.execute({
    sql: `
      UPDATE tournaments
      SET name = ?, timezone = ?, rules_version = ?, config_json = ?, updated_at = ?
      WHERE id = ?
    `,
    args: [
      updated.name,
      updated.timezone,
      updated.rules_version,
      updated.config_json,
      updated.updated_at,
      id,
    ],
  });

  return updated;
}

/**
 * Transitions a tournament's status according to the lifecycle state machine.
 */
export async function transitionTournamentStatus(
  db: Client,
  id: string,
  targetStatus: TournamentStatus,
  reason?: string,
  actorId: string = 'SYSTEM'
): Promise<Tournament> {
  const current = await getTournament(db, id);
  if (!current) {
    throw new Error(`Tournament with id '${id}' not found`);
  }

  if (current.status === targetStatus) {
    return current;
  }

  const allowed = ALLOWED_TRANSITIONS[current.status];
  if (!allowed.includes(targetStatus)) {
    throw new Error(
      `Transisi status tidak valid: dari '${current.status}' ke '${targetStatus}'. Alur yang diizinkan: ${allowed.join(', ')}`
    );
  }

  // Pre-condition verification before entering DRAW_READY:
  // Must ensure at least 8 verified teams exist to form the minimum valid group structure (FR-COMP-010).
  if (targetStatus === 'DRAW_READY') {
    const countResult = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM teams WHERE tournament_id = ? AND registration_status = 'VERIFIED'",
      args: [id],
    });
    const verifiedCount = Number(countResult.rows[0]?.[0] ?? (countResult.rows[0] as { cnt?: unknown })?.cnt ?? 0);
    if (verifiedCount < 8) {
      throw new Error(
        `Jumlah tim belum cukup untuk membentuk minimal 2 grup, minimal 8 tim. Tim terverifikasi saat ini: ${verifiedCount}.`
      );
    }
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: 'UPDATE tournaments SET status = ?, updated_at = ? WHERE id = ?',
    args: [targetStatus, now, id],
  });

  // Record audit trail event
  const auditId = randomUUID();
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      auditId,
      actorId === 'SYSTEM' ? 'SYSTEM' : 'ORGANIZER',
      actorId,
      'TOURNAMENT_STATUS_TRANSITION',
      'TOURNAMENT',
      id,
      JSON.stringify({ status: current.status }),
      JSON.stringify({ status: targetStatus }),
      reason || null,
      randomUUID(),
      now,
    ],
  });

  return {
    ...current,
    status: targetStatus,
    updated_at: now,
  };
}
