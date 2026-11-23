/**
 * Flash Peak TMS - Migration Runner
 * 
 * Safely applies versioned SQL migrations in alphabetical order.
 * Tracks applied migrations in `_migrations` table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { getDb } from './client.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Runs all pending migrations against the provided or default libSQL client.
 */
export async function runMigrations(
  client?: Client,
  customMigrationsDir?: string
): Promise<MigrationResult> {
  const db = client || getDb();
  const applied: string[] = [];
  const skipped: string[] = [];

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationsDir =
    customMigrationsDir || path.resolve(__dirname, '../../migrations');

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  // Ensure _migrations meta table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Retrieve already applied migrations
  const existingResult = await db.execute('SELECT id FROM _migrations');
  const appliedIds = new Set(
    existingResult.rows.map((row) => String(row[0] ?? (row as { id?: unknown }).id))
  );

  // Read and sort migration files
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const migrationId = path.basename(file, '.sql');

    if (appliedIds.has(migrationId)) {
      skipped.push(file);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');

    // Execute migration within client (executeMultiple runs the full script)
    await db.executeMultiple(sqlContent);

    // Record migration record
    const nowUtc = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)',
      args: [migrationId, file, nowUtc],
    });

    applied.push(file);
  }

  return { applied, skipped };
}

// CLI execution entry point
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isDirectExecution) {
  runMigrations()
    .then((result) => {
      console.log('✅ Migrations completed successfully:');
      console.log(`   Applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'none'}`);
      console.log(`   Skipped: ${result.skipped.length > 0 ? result.skipped.join(', ') : 'none'}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}
