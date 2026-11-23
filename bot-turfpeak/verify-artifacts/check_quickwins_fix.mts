// REVIEW-FIX checks for the two quick-wins from the second-opinion review:
//
// PART A — quickwin-shuffle-validation: the reviewer proved a tampered shuffle
// that returns NEW objects with swapped team_ids passed the old validation
// (Set-of-object-identity) and produced a self-match X vs X. The fix validates
// the team_id MULTISET; the reviewer's exact attack must now be REJECTED.
//
// PART B — quickwin-group-null-message: !matchday status and the pre-deadline
// reminder used to render "(Grup null)" for knockout fixtures and always
// quoted D-031. After the fix: knockout fixtures are labeled "(Knockout)",
// D-032 is quoted when knockout fixtures are pending, and GROUP fixtures keep
// the exact old "(Grup X)" + D-031 wording (regression).
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';
import { MatchdayService } from '../src/application/matchday-service.js';

async function main() {
  let allOk = true;

  // ================= PART A: shuffle validation =================
  {
    const db = createClient({ url: ':memory:' });
    await runMigrations(db);
    const TID = randomUUID();
    await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'SV', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const id = randomUUID();
      await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'D' + i]);
      ids.push(id);
    }
    const q4: KnockoutQualifier[] = ids.map((id, i) => ({ team_id: id, team_name: 'D' + (i + 1), group_code: 'KO', group_rank: 1 }));

    // A1: reviewer's exact attack — shuffle returns new objects where the first
    // team's id is replaced by the second's (duplicate id, distinct objects).
    // OLD behavior: passed validation AND produced a self-match. Must THROW now.
    let a1Rejected = false;
    try {
      await generateKnockoutFixtures(db, TID, q4, {
        shuffle: (a) => a.map((q) => ({ ...q, team_id: q.team_id === a[0]!.team_id ? a[1]!.team_id : q.team_id })),
      });
      console.log('A1 team_id-swapped: DITERIMA (BUG MASIH ADA)');
    } catch {
      a1Rejected = true;
      console.log('A1 team_id-swapped: DITOLAK ✓');
    }

    // A2: duplicate element (old check already caught this) — still rejected.
    let a2Rejected = false;
    try {
      await generateKnockoutFixtures(db, TID, q4, { shuffle: (a) => [a[0]!, a[0]!, a[1]!, a[2]!] });
    } catch {
      a2Rejected = true;
      console.log('A2 duplicate-element: DITOLAK ✓');
    }

    // A3: dropped element — still rejected.
    let a3Rejected = false;
    try {
      await generateKnockoutFixtures(db, TID, q4, { shuffle: (a) => a.slice(0, 3) });
    } catch {
      a3Rejected = true;
      console.log('A3 dropped-element: DITOLAK ✓');
    }

    // A4: legitimate reorder (reverse) and identity-return are still accepted.
    const a4 = await generateKnockoutFixtures(db, TID, q4, { shuffle: (a) => [...a].reverse() });
    const a4ok = a4.fixtures.length === 2 && a4.fixtures.every((f) => f.team_a_id !== f.team_b_id);
    console.log('A4 reverse shuffle sah: diterima,', a4.fixtures.length, 'fixture,', a4ok ? 'tanpa self-match ✓' : 'SELF-MATCH (BUG)');
    const a5 = await generateKnockoutFixtures(db, TID, q4.map((q) => ({ ...q })), { shuffle: (a) => a });
    const a5ok = a5.fixtures.length === 2 && a5.fixtures.every((f) => f.team_a_id !== f.team_b_id);
    console.log('A5 return-same-ref (identitas): diterima,', a5ok ? 'tanpa self-match ✓' : 'SELF-MATCH (BUG)');

    const pA = a1Rejected && a2Rejected && a3Rejected && a4ok && a5ok;
    if (!pA) allOk = false;
    console.log(pA ? 'PART A PASS' : 'PART A FAIL');
    db.close();
  }

  // ================= PART B: "(Grup null)" & D-031/D-032 =================
  {
    // Two separate scenarios, because the ACTIVE round is the earliest round
    // with pending fixtures (group rounds first):
    //   B1: knockout-only tournament -> SEMI_FINAL is the active round;
    //       must show "(Knockout)" and D-032, never "(Grup null)".
    //   B2: group fixture pending -> "(Grup A)" + D-031 wording unchanged.
    const mkSvcDb = async () => {
      const db = createClient({ url: ':memory:' });
      await runMigrations(db);
      const TID = randomUUID();
      await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'GN', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
      const drawId = randomUUID();
      await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
      const grp = randomUUID();
      await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grp, drawId]);
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const id = randomUUID();
        await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'N' + i]);
        ids.push(id);
      }
      return { db, TID, grp, ids };
    };

    // ---- B1: knockout round active ----
    {
      const { db, TID, ids } = await mkSvcDb();
      await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [randomUUID(), TID, ids[2], ids[3], ids[2]]);
      const fxRes = await db.execute(`SELECT id FROM fixtures WHERE tournament_id = ?`, [TID]);
      for (const r of fxRes.rows as any[]) {
        await db.execute(`INSERT INTO series (id, fixture_id, format, target_wins, status, winner_team_id, team_a_game_wins, team_b_game_wins, created_at, updated_at) VALUES (?, ?, 'BO3', 2, 'PENDING', NULL, 0, 0, datetime('now'), datetime('now'))`, [randomUUID(), String(r.id)]);
      }
      const svc = new MatchdayService({ db, sender: null as any, centralGroupJid: 'g@g.us' });
      const status = await svc.formatMatchdayStatus();
      console.log('\n--- B1: !matchday status (SEMI_FINAL KO pending) ---');
      console.log(status.split('\n').slice(0, 18).join('\n'));
      const b1noNull = !status.includes('(Grup null)');
      const b1koLabel = status.includes('(Knockout)');
      const b1d032 = status.includes('D-032');
      const b1d031 = !status.includes('D-031'); // pure KO round: D-031 not quoted
      console.log(`\nB1: tanpa "(Grup null)": ${b1noNull} | "(Knockout)": ${b1koLabel} | D-032: ${b1d032} | tanpa D-031: ${b1d031}`);
      const pB1 = b1noNull && b1koLabel && b1d032 && b1d031;
      if (!pB1) allOk = false;
      console.log(pB1 ? 'B1 PASS' : 'B1 FAIL');
      db.close();
    }

    // ---- B2: group round active (regression — old wording preserved) ----
    {
      const { db, TID, grp, ids } = await mkSvcDb();
      await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [randomUUID(), TID, grp, ids[0], ids[1], ids[0]]);
      const svc = new MatchdayService({ db, sender: null as any, centralGroupJid: 'g@g.us' });
      const status = await svc.formatMatchdayStatus();
      console.log('\n--- B2: !matchday status (MD1 group pending, regression) ---');
      console.log(status.split('\n').slice(0, 18).join('\n'));
      const b2Group = status.includes('(Grup A)');
      const b2D031 = status.includes('D-031');
      const b2D032 = !status.includes('D-032');
      const b2NoKo = !status.includes('(Knockout)');
      console.log(`\nB2: "(Grup A)": ${b2Group} | D-031: ${b2D031} | tanpa D-032: ${b2D032} | tanpa "(Knockout)": ${b2NoKo}`);
      const pB2 = b2Group && b2D031 && b2D032 && b2NoKo;
      if (!pB2) allOk = false;
      console.log(pB2 ? 'B2 PASS (wording grup tidak berubah)' : 'B2 FAIL');
      db.close();
    }

    const pB = true; // per-scenario verdicts already pushed into allOk
    void pB;
  }

  console.log('\n' + (allOk ? 'QUICKWINS-FIX VERIFIED' : 'QUICKWINS-FIX FAILED'));
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
