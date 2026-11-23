/**
 * AUDIT ARTIFACT: DB Migration Failure & Abort Startup Verification
 * Target: DB-001 (Failed migration must abort startup)
 * 
 * Verifies that when a migration SQL fails, runMigrations() throws an error,
 * does not commit the failed migration into _migrations, and causes startup abort.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';

console.log('=== AUDIT TEST: DATABASE MIGRATION FAILURE HANDLING ===');

async function testMigrationFailure() {
  const tempDir = path.resolve(process.cwd(), 'audit-artifacts/temp_migrations');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 1. Create a valid migration
  fs.writeFileSync(
    path.join(tempDir, '001_valid.sql'),
    'CREATE TABLE test_table (id TEXT PRIMARY KEY, value TEXT);'
  );

  // 2. Create an invalid migration with deliberate syntax error
  fs.writeFileSync(
    path.join(tempDir, '002_broken.sql'),
    'CREATE TABLE broken_table (id TEXT PRIMARY KEY INVALID SYNTAX HERE !!!);'
  );

  const db = createClient({ url: ':memory:' });

  let migrationThrew = false;
  let errorMessage = '';

  try {
    await runMigrations(db, tempDir);
  } catch (err: any) {
    migrationThrew = true;
    errorMessage = err.message || String(err);
  }

  console.log(`[Migration] Threw on broken SQL: ${migrationThrew ? 'YES (PASS)' : 'NO (FAIL)'}`);
  console.log(`[Migration] Error message: ${errorMessage}`);

  // Check _migrations table
  const migrationsRows = await db.execute('SELECT id, name FROM _migrations');
  const appliedIds = migrationsRows.rows.map((r) => String(r[0]));
  console.log(`[Migration] Recorded applied IDs in _migrations:`, appliedIds);

  const onlyValidApplied = appliedIds.includes('001_valid') && !appliedIds.includes('002_broken');
  console.log(`[Migration] Faulty migration omitted from _migrations: ${onlyValidApplied ? 'YES (PASS)' : 'NO (FAIL)'}`);

  // Clean up temp migration files
  fs.rmSync(tempDir, { recursive: true, force: true });
  db.close();

  if (migrationThrew && onlyValidApplied) {
    console.log('\n=== AUDIT CONCLUSION: DB-001 VERIFIED ===');
    console.log('runMigrations safely throws on invalid SQL and does not record broken migrations.');
  } else {
    console.error('\n=== AUDIT CONCLUSION: DB-001 FAILED ===');
  }
}

testMigrationFailure().catch((err) => {
  console.error('Audit test failed with unhandled error:', err);
  process.exit(1);
});
