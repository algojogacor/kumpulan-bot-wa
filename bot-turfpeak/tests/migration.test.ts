import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';

describe('Database Migrations (001_initial.sql + later versioned migrations)', () => {
  let db: Client;

  beforeEach(() => {
    // In-memory isolated SQLite instance for each test
    db = createClient({
      url: ':memory:',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('successfully applies all pending migrations and records them in _migrations', async () => {
    const result = await runMigrations(db);

    expect(result.applied).toContain('001_initial.sql');
    expect(result.skipped).toEqual([]);

    // Check _migrations table: every migration file in the directory is applied
    const migrationRows = await db.execute('SELECT id, name FROM _migrations');
    expect(migrationRows.rows.length).toBe(result.applied.length);
    expect(migrationRows.rows.map((r) => String(r[0]))).toContain('001_initial');

    // Query sqlite_master to verify tables were created
    const tablesResult = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tableNames = tablesResult.rows.map((r) => String(r[0]));

    const expectedTables = [
      '_migrations',
      'approvals',
      'audit_events',
      'bot_instances',
      'corrections',
      'delegates',
      'fixtures',
      'games',
      'goalkeeper_reports',
      'group_draws',
      'group_members',
      'groups',
      'inbound_messages',
      'ko_game_evidence',
      'media_assets',
      'player_game_stats',
      'players',
      'provider_usage',
      'report_media',
      'report_sessions',
      'report_versions',
      'series',
      'standings',
      'teams',
      'tournaments',
      'whatsapp_identities',
    ];

    for (const expectedTable of expectedTables) {
      expect(tableNames).toContain(expectedTable);
    }
  });

  it('is idempotent on repeated runs', async () => {
    // First run applies the full pending set
    const firstRun = await runMigrations(db);
    expect(firstRun.applied.length).toBeGreaterThan(0);
    expect(firstRun.applied).toContain('001_initial.sql');

    // Second run applies nothing; everything is skipped
    const secondRun = await runMigrations(db);
    expect(secondRun.applied.length).toBe(0);
    expect(secondRun.skipped).toContain('001_initial.sql');
    expect(secondRun.skipped).toEqual(firstRun.applied);
  });

  it('enforces table foreign key constraints when inserting related rows', async () => {
    await runMigrations(db);

    // Attempting to insert a team with a non-existent tournament_id should fail
    await expect(
      db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES ('t-1', 'non-existent-tourney', 'Team Alpha', 'PENDING', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
        args: [],
      })
    ).rejects.toThrow();

    // Now insert valid tournament first
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
            VALUES ('tourney-1', 'Flash Peak Championship', 'REGISTRATION', '1.0', '{}', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
      args: [],
    });

    // Valid insertion should succeed
    const validInsert = await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES ('t-1', 'tourney-1', 'Team Alpha', 'PENDING', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
      args: [],
    });
    expect(validInsert.rowsAffected).toBe(1);
  });
});
