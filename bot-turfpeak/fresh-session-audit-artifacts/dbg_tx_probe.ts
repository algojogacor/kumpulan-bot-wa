// Probe: does @libsql/client local :memory: support db.transaction('write')?
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';

const db = createClient({ url: ':memory:' });
await runMigrations(db);
try {
  const tx = await db.transaction('write');
  const now = new Date().toISOString();
  await tx.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('tx1','TX','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
  await tx.commit();
  const r = await db.execute('SELECT COUNT(*) AS c FROM tournaments');
  console.log('COMMIT OK, tournaments rows:', r.rows[0]);
} catch (e) {
  console.log('TX FAILED:', (e as Error).message);
}
db.close();
