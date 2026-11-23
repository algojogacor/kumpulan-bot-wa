import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client.js';

async function resetAllData() {
  console.log('--- Flash Peak TMS Data Reset Utility ---');
  
  // 1. Create a timestamped backup of local.sqlite if it exists
  const dbPath = path.resolve(process.cwd(), 'local.sqlite');
  if (fs.existsSync(dbPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.resolve(process.cwd(), `local.sqlite.backup-${timestamp}`);
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[Backup] Created backup: ${backupPath}`);
  }

  const db = getDb();

  // 2. Clear tables in dependency order
  const tables = [
    'approvals',
    'corrections',
    'player_game_stats',
    'goalkeeper_reports',
    'report_media',
    'report_versions',
    'report_sessions',
    'media_assets',
    'inbound_messages',
    'standings',
    'games',
    'series',
    'fixtures',
    'group_members',
    'groups',
    'group_draws',
    'players',
    'teams',
    'whatsapp_identities',
    'delegates',
    'tournaments',
    'audit_events',
  ];

  console.log('[Reset] Disabling foreign keys temporarily...');
  await db.execute('PRAGMA foreign_keys = OFF;');

  for (const table of tables) {
    try {
      await db.execute(`DELETE FROM ${table};`);
      console.log(`[Reset] Cleared table '${table}'`);
    } catch (err: unknown) {
      console.warn(`[Reset] Note for table '${table}':`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('[Reset] Re-enabling foreign keys...');
  await db.execute('PRAGMA foreign_keys = ON;');
  console.log('✅ All tournament, delegate, team, and match data successfully reset!');
}

resetAllData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Reset failed:', err);
    process.exit(1);
  });
