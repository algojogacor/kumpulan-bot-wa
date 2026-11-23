import { createClient } from '@libsql/client';
import { IdentityResolver } from '../identity/resolver.js';

async function main() {
  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const db = createClient({ url: dbUrl });
  const resolver = new IdentityResolver(db);

  const tRes = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
  if (tRes.rows.length === 0) {
    console.log('No tournaments found.');
    return;
  }
  const tourney = tRes.rows[0];
  const tourneyId = String(tourney.id ?? tourney[0]);
  const tourneyName = String(tourney.name ?? tourney[1]);
  console.log(`Active Tournament: ${tourneyName} (ID: ${tourneyId})`);

  const teamsRes = await db.execute({
    sql: 'SELECT id, team_name, delegate_id, registration_status FROM teams WHERE tournament_id = ? ORDER BY team_name ASC',
    args: [tourneyId],
  });

  console.log(`Found ${teamsRes.rows.length} teams.`);

  let index = 1;
  for (const row of teamsRes.rows) {
    const teamId = String(row.id ?? row[0]);
    const teamName = String(row.team_name ?? row[1]);
    const delegateId = row.delegate_id ?? row[2];
    const status = row.registration_status ?? row[3];

    if (!delegateId || status !== 'VERIFIED') {
      const mockPhone = `62899000000${String(index).padStart(2, '0')}`;
      const mockAddress = `${mockPhone}@s.whatsapp.net`;
      const { delegate } = await resolver.createDelegateWithIdentity(
        `Official ${teamName}`,
        mockAddress,
        'JID'
      );

      await db.execute({
        sql: `UPDATE teams SET delegate_id = ?, registration_status = 'VERIFIED', updated_at = ? WHERE id = ?`,
        args: [delegate.id, new Date().toISOString(), teamId],
      });

      console.log(`[VERIFIED] Team '${teamName}' -> Delegate '${delegate.display_name}' (${mockPhone})`);
    } else {
      console.log(`[ALREADY VERIFIED] Team '${teamName}' (Delegate: ${delegateId})`);
    }
    index++;
  }

  // Update tournament status to DRAW_READY
  await db.execute({
    sql: `UPDATE tournaments SET status = 'DRAW_READY', updated_at = ? WHERE id = ?`,
    args: [new Date().toISOString(), tourneyId],
  });

  console.log(`\n🎉 All ${teamsRes.rows.length} teams are now VERIFIED.`);
  console.log(`Tournament status is now 'DRAW_READY'. Ready for !draw!`);
}

main().catch(console.error);
