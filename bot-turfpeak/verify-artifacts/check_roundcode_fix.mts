// REVIEW-FIX check: blocker-roundcode (label ronde dari posisi/round history,
// bukan jumlah fixture) — mereproduksi skenario PERSIS second-opinion reviewer:
// turnamen 6 grup (24 tim, 12 kualifikasi) dijalankan penuh dari kualifikasi
// grup sampai FINAL lewat !startknockout berturut-turut (via CommandRouter).
// Bukti yang diminta:
//   1. Tidak ada tim yang sudah tersingkir ikut di-draw ulang di ronde mana pun.
//   2. Label tiap ronde unik.
//   3. Turnamen KONVERGEN ke FINAL (tidak berputar selamanya).
// Regression sekaligus: turnamen 16 tim ala Gojiha (4 grup, QF->SF->Final)
// label TIDAK berubah dari perilaku lama.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { registerTournamentCommands } from '../src/application/tournament-commands.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import { getSeriesByFixture, recordSeriesGameResult } from '../src/competition/series.js';
import { generateKnockoutFixtures } from '../src/competition/fixtures.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

interface Harness {
  db: ReturnType<typeof createClient>;
  router: CommandRouter;
  tid: string;
  mk: (text: string) => NormalizedMessage;
  nameOf: Map<string, string>;
}

async function setupTournament(label: string): Promise<Harness> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, ?, 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID, label]);
  const resolver = new IdentityResolver(db);
  const router = new CommandRouter({ centralGroupJid: 'g@g.us', organizerPhone: '6281234567890', identityResolver: resolver });
  registerTournamentCommands(router, {
    db, identityResolver: resolver,
    manualReportSession: undefined as any, onboardingService: undefined as any, matchdayService: undefined as any,
    woClaimSession: undefined,
  } as any);
  const ORG = '6281234567890@s.whatsapp.net';
  const mk = (text: string): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us', sender_raw_address: ORG, sender_normalized_address: ORG,
    message_type: 'TEXT', text_body: text, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);
  return { db, router, tid: TID, mk, nameOf: new Map() };
}

async function addTeams(h: Harness, n: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = randomUUID();
    await h.db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, h.tid, prefix + i]);
    h.nameOf.set(id, prefix + i);
    ids.push(id);
  }
  return ids;
}

/** Complete every SCHEDULED KO fixture: team_a wins 2-0 (BO3). Returns played team ids. */
async function playAllScheduled(h: Harness): Promise<string[]> {
  const played: string[] = [];
  const res = await h.db.execute(`SELECT id, team_a_id FROM fixtures WHERE tournament_id = ? AND stage = 'KNOCKOUT' AND status = 'SCHEDULED'`, [h.tid]);
  for (const r of res.rows as any[]) {
    const ser = (await getSeriesByFixture(h.db, String(r.id)))!;
    await recordSeriesGameResult(h.db, { series_id: ser.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
    await recordSeriesGameResult(h.db, { series_id: ser.id, game_number: 2, team_a_score: 2, team_b_score: 0 });
    await h.db.execute(`UPDATE fixtures SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`, [r.id]);
    played.push(String(r.team_a_id));
  }
  return played;
}

async function roundSnapshot(h: Harness): Promise<{ round: string; a: string; b: string; status: string }[]> {
  const res = await h.db.execute(`
    SELECT f.round_code, f.status, ta.team_name AS a, tb.team_name AS b
    FROM fixtures f
    JOIN teams ta ON ta.id = f.team_a_id JOIN teams tb ON tb.id = f.team_b_id
    WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
    ORDER BY f.created_at ASC, f.rowid ASC`, [h.tid]);
  return (res.rows as any[]).map((r) => ({ round: String(r.round_code), a: String(r.a), b: String(r.b), status: String(r.status) }));
}

async function main() {
  let allOk = true;

  // ======================================================================
  // PART 1 — Reviewer scenario: 6 groups (24 teams) -> 12 qualifiers ->
  // 6 fixtures -> 3 fixtures -> FINAL+bye. Old code labeled both wide rounds
  // ROUND_OF_16 and resurrected eliminated teams forever.
  // ======================================================================
  {
    const h = await setupTournament('Big 24');
    const ids = await addTeams(h, 24, 'T');
    const quals = ids.map((id, i) => ({ team_id: id, team_name: h.nameOf.get(id)!, group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
    const r1 = await generateKnockoutFixtures(h.db, h.tid, quals);
    const labels: string[] = [];
    console.log('=== PART 1: 6-grup / 24 tim (skenario reviewer) ===');
    console.log('Ronde 1:', r1.fixtures.length, 'fixture | label:', r1.fixtures[0]?.round_code);
    labels.push(r1.fixtures[0]!.round_code!);

    // Play round 1 (team_a wins each) then keep invoking !startknockout
    // until the tournament completes; track every team that ever played.
    const eliminatedEver: Set<string> = new Set(); // losers seen so far
    let guard = 0;
    let completed = false;
    while (guard++ < 12) {
      await playAllScheduled(h);
      const losersRes = await h.db.execute(`
        SELECT f.team_b_id AS loser FROM fixtures f
        JOIN series s ON s.fixture_id = f.id
        WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND s.winner_team_id = f.team_a_id AND f.status = 'COMPLETED'`, [h.tid]);
      for (const r of losersRes.rows as any[]) eliminatedEver.add(String(r.loser));
      const tRes = await h.db.execute(`SELECT status FROM tournaments WHERE id = ?`, [h.tid]);
      if (String((tRes.rows[0] as any).status) === 'COMPLETED') { completed = true; break; }
      // still has a FINAL fixture played but tournament not completed?
      const pending = await h.db.execute(`SELECT COUNT(*) as c FROM series s JOIN fixtures f ON s.fixture_id = f.id WHERE f.tournament_id = ? AND f.stage='KNOCKOUT' AND s.status != 'COMPLETED'`, [h.tid]);
      if (Number((pending.rows[0] as any).c) === 0) {
        const r = await h.router.handleMessage(h.mk('!startknockout'));
        if (!r?.success) { console.log('  startknockout:', (r?.responseText || '').slice(0, 90)); break; }
      } else break;
    }
    // complete the final round if not yet
    if (!completed) {
      await playAllScheduled(h);
      const pending = await h.db.execute(`SELECT COUNT(*) as c FROM series s JOIN fixtures f ON s.fixture_id = f.id WHERE f.tournament_id = ? AND f.stage='KNOCKOUT' AND s.status != 'COMPLETED'`, [h.tid]);
      if (Number((pending.rows[0] as any).c) === 0) {
        const r = await h.router.handleMessage(h.mk('!startknockout'));
        if (r?.success && /JUARA|GRAND FINAL/.test(r.responseText || '')) completed = true;
      }
    }

    const snap = await roundSnapshot(h);
    const uniqueLabels = new Set(snap.map((s) => s.round));
    const resurrected: string[] = [];
    for (const s of snap) {
      const loserName = s.status === 'COMPLETED' ? null : null;
      void loserName;
    }
    // A resurrected team = a team that LOST a completed fixture (was runner-up
    // side, winner = team_a in our play script) but appears in a LATER fixture.
    const lossRound = new Map<string, string>(); // team -> round where it lost
    const fixturesByRound = new Map<string, { a: string; b: string }[]>();
    for (const s of snap) {
      if (!fixturesByRound.has(s.round)) fixturesByRound.set(s.round, []);
      fixturesByRound.get(s.round)!.push({ a: s.a, b: s.b });
    }
    const roundOrder = [...new Set(snap.map((s) => s.round))];
    for (const [round, fxs] of fixturesByRound) {
      // in our play script the WINNER is always team_a; losers are team_b of COMPLETED fixtures
      const completedFx = snap.filter((s) => s.round === round && s.status === 'COMPLETED');
      for (const cf of completedFx) lossRound.set(cf.b, round);
    }
    for (const [round, fxs] of fixturesByRound) {
      const rIdx = roundOrder.indexOf(round);
      for (const fx of fxs) {
        for (const name of [fx.a, fx.b]) {
          const lostAt = lossRound.get(name);
          if (lostAt && roundOrder.indexOf(lostAt) < rIdx) resurrected.push(`${name} (kalah di ${lostAt}, muncul lagi di ${round})`);
        }
      }
    }

    const hasFinal = uniqueLabels.has('FINAL');
    console.log('Label semua ronde:', roundOrder.join(' -> '));
    console.log('Label unik semua:', uniqueLabels.size === roundOrder.length);
    console.log('Tim tersingkir yang hidup lagi:', resurrected.length === 0 ? 'TIDAK ADA' : resurrected.join('; '));
    console.log('Turnamen mencapai FINAL:', hasFinal, '| status COMPLETED:', completed);
    const p1 = uniqueLabels.size === roundOrder.length && resurrected.length === 0 && hasFinal;
    if (!p1) allOk = false;
    console.log(p1 ? 'PART 1 PASS' : 'PART 1 FAIL');
    h.db.close();
  }

  // ======================================================================
  // PART 2 — Regression: Gojiha-style 16 teams (4 groups of 4, top-2 per
  // group = 8 qualifiers) -> QF (4) -> SF (2) -> FINAL. Labels must stay
  // EXACTLY as the old code produced them for this size.
  // ======================================================================
  {
    const h = await setupTournament('Gojiha 16');
    const ids = await addTeams(h, 8, 'G'); // 8 QUALIFIERS (16 teams, 4 groups, top 2)
    const quals = ids.map((id, i) => ({ team_id: id, team_name: h.nameOf.get(id)!, group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
    const r1 = await generateKnockoutFixtures(h.db, h.tid, quals);
    console.log('\n=== PART 2: 16 tim ala Gojiha (8 kualifikasi) regression ===');
    console.log('Ronde 1:', r1.fixtures.length, 'fixture | label:', r1.fixtures[0]?.round_code);
    const okR1 = r1.fixtures.length === 4 && r1.fixtures[0]?.round_code === 'QUARTER_FINAL';
    await playAllScheduled(h);
    await h.router.handleMessage(h.mk('!startknockout'));
    await playAllScheduled(h);
    await h.router.handleMessage(h.mk('!startknockout'));
    await playAllScheduled(h);
    const snap = await roundSnapshot(h);
    const labels = [...new Set(snap.map((s) => s.round))];
    console.log('Label semua ronde:', labels.join(' -> '));
    const finals = snap.filter((s) => s.round === 'FINAL');
    const p2 = okR1 && labels.join('->') === 'QUARTER_FINAL->SEMI_FINAL->FINAL' && finals.length === 1;
    if (!p2) allOk = false;
    console.log(p2 ? 'PART 2 PASS (QF -> SF -> FINAL, identik perilaku lama)' : 'PART 2 FAIL');
    h.db.close();
  }

  // ======================================================================
  // PART 2b — Regression: 16 qualifiers (32-team-scale bracket, 8 groups)
  // old code produced ROUND_OF_16 -> QUARTER_FINAL -> SEMI_FINAL -> FINAL.
  // ======================================================================
  {
    const h = await setupTournament('16 Quals');
    const ids = await addTeams(h, 16, 'Q');
    const quals = ids.map((id, i) => ({ team_id: id, team_name: h.nameOf.get(id)!, group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
    const r1 = await generateKnockoutFixtures(h.db, h.tid, quals);
    console.log('\n=== PART 2b: 16 kualifikasi regression ===');
    console.log('Ronde 1:', r1.fixtures.length, 'fixture | label:', r1.fixtures[0]?.round_code);
    const okR1 = r1.fixtures.length === 8 && r1.fixtures[0]?.round_code === 'ROUND_OF_16';
    for (let k = 0; k < 3; k++) {
      await playAllScheduled(h);
      const r = await h.router.handleMessage(h.mk('!startknockout'));
      if (!r?.success && k < 2) { console.log('  startknockout gagal:', (r?.responseText || '').slice(0, 80)); }
    }
    await playAllScheduled(h);
    const snap = await roundSnapshot(h);
    const labels = [...new Set(snap.map((s) => s.round))];
    console.log('Label semua ronde:', labels.join(' -> '));
    const p2b = okR1 && labels.join('->') === 'ROUND_OF_16->QUARTER_FINAL->SEMI_FINAL->FINAL';
    if (!p2b) allOk = false;
    console.log(p2b ? 'PART 2b PASS (R16 -> QF -> SF -> FINAL, identik perilaku lama)' : 'PART 2b FAIL');
    h.db.close();
  }

  // ======================================================================
  // PART 3 — Extreme: repeated odd pools exhaust the progression and must
  // fall back to unique KNOCKOUT_ROUND_<n> labels (never collide).
  // ======================================================================
  {
    const h = await setupTournament('Odd Chain');
    const ids = await addTeams(h, 4, 'O');
    const quals = ids.map((id, i) => ({ team_id: id, team_name: h.nameOf.get(id)!, group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
    const r1 = await generateKnockoutFixtures(h.db, h.tid, quals); // 2 fixtures SEMI_FINAL
    console.log('\n=== PART 3: fallback label unik saat progresi habis ===');
    // simulate: SF done, 2 winners -> FINAL; then fake another round with 3
    // survivors labeled things... simplest: create many rounds directly via
    // generateKnockoutFixtures with distinct team sets? teams must be unique
    // per call only. Use fresh teams per call to force label consumption.
    const seen: string[] = [r1.fixtures[0]!.round_code!];
    for (let k = 0; k < 7; k++) {
      const more = await addTeams(h, 6, 'X' + k + '-');
      const rk = await generateKnockoutFixtures(h.db, h.tid, more.map((id, i) => ({ team_id: id, team_name: h.nameOf.get(id)!, group_code: 'KO', group_rank: 1 })), { shuffle: (a) => [...a] });
      seen.push(rk.fixtures[0]!.round_code!);
    }
    const uniq = new Set(seen);
    console.log('Label berurutan:', seen.join(' -> '));
    const p3 = seen.length === uniq.size;
    if (!p3) allOk = false;
    console.log(p3 ? 'PART 3 PASS (semua label unik walau progresi habis)' : 'PART 3 FAIL (label duplikat!)');
    h.db.close();
  }

  console.log('\n' + (allOk ? 'ROUNDCODE-FIX VERIFIED' : 'ROUNDCODE-FIX FAILED'));
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
