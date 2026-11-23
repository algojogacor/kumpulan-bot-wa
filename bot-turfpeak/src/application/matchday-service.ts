/**
 * Flash Peak TMS - Matchday & Round Schedule Management Service
 * 
 * Manages:
 * 1. 24-hour matchday window starting and ending at 19:59 WIB (Asia/Jakarta)
 * 2. Pre-deadline reminders (17:00 WIB & 18:59 WIB) with delegate @mentions
 * 3. Daily 19:59 WIB cutoff: auto-resolves unplayed matches as Double Walkover (D-031, 0 points each, 0-0 score)
 * 4. Automatic progression and announcement for the next matchday/round
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { handleGroupDoubleWalkover, handleKnockoutDoubleRoomCardFailure } from '../competition/walkover.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';

export interface MatchdayServiceDeps {
  db: Client;
  sender?: WhatsAppSender | null;
  centralGroupJid?: string;
}

export interface MatchdayFixtureItem {
  id: string;
  roundCode: string;
  /** 'GROUP' or 'KNOCKOUT' (AUDIT-VERIFY-T17: knockout fixtures must be visible to the cutoff). */
  stage: string;
  groupId: string | null;
  groupCode: string | null;
  teamAName: string;
  teamBName: string;
  hostName: string;
  delegateAAddress: string | null;
  delegateBAddress: string | null;
  delegateAPhone: string | null;
  delegateBPhone: string | null;
  delegateAJid: string | null;
  delegateBJid: string | null;
  status: string;
}

export interface CutoffResult {
  hasCutoffProcessed: boolean;
  resolvedFixturesCount: number;
  expiredFixtures: MatchdayFixtureItem[];
  nextRoundCode?: string | null;
  announcementText?: string | null;
  mentions?: string[];
}

export interface ReminderResult {
  sent: boolean;
  reminderSlot?: string;
  pendingCount: number;
  announcementText?: string | null;
  mentions?: string[];
}

export class MatchdayService {
  private db: Client;
  private sender?: WhatsAppSender | null;
  private centralGroupJid: string;

  constructor(deps: MatchdayServiceDeps) {
    this.db = deps.db;
    this.sender = deps.sender;
    this.centralGroupJid = deps.centralGroupJid || '';
  }

  public setCentralGroupJid(jid: string): void {
    this.centralGroupJid = jidNormalizedUser(jid);
  }

  public getCentralGroupJid(): string {
    return this.centralGroupJid;
  }

  public setSender(sender: WhatsAppSender): void {
    this.sender = sender;
  }

  /**
   * Helper to get current Date/Time components in Asia/Jakarta (WIB).
   */
  public getWibDateTime(): {
    hours: number;
    minutes: number;
    dateStr: string; // YYYY-MM-DD
    timeStr: string; // HH:mm
    timestamp: number;
  } {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const p: Record<string, string> = {};
    for (const part of parts) {
      p[part.type] = part.value;
    }
    const dateStr = `${p.year}-${p.month}-${p.day}`;
    const hours = parseInt(p.hour, 10);
    const minutes = parseInt(p.minute, 10);
    const timeStr = `${p.hour}:${p.minute}`;
    return { hours, minutes, dateStr, timeStr, timestamp: now.getTime() };
  }

  /**
   * Calculates time remaining until the next 19:59 WIB deadline.
   */
  public getTimeRemainingToCutoff(): {
    hoursLeft: number;
    minutesLeft: number;
    formatted: string;
  } {
    const { hours, minutes } = this.getWibDateTime();
    const currentTotalMinutes = hours * 60 + minutes;
    const cutoffTotalMinutes = 19 * 60 + 59; // 1199 minutes

    let diffMinutes = cutoffTotalMinutes - currentTotalMinutes;
    if (diffMinutes < 0) {
      // Cutoff has passed today, next is tomorrow
      diffMinutes += 24 * 60;
    }

    const hoursLeft = Math.floor(diffMinutes / 60);
    const minutesLeft = diffMinutes % 60;
    return {
      hoursLeft,
      minutesLeft,
      formatted: `${hoursLeft} jam ${minutesLeft} menit`,
    };
  }

  /**
   * Retrieves the latest active tournament and its current unfinished group stage round.
   */
  public async getActiveTournamentCurrentRound(): Promise<{
    tournamentId: string;
    tournamentName: string;
    currentRoundCode: string | null;
    allRounds: string[];
  } | null> {
    const tRes = await this.db.execute(
      "SELECT id, name FROM tournaments WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1"
    );
    if (tRes.rows.length === 0) return null;

    const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
    const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

    // Query distinct rounds across group and knockout stages (FIX2-KO-001:
    // matchday status must also describe the active knockout round)
    // REVIEW-FIX blocker-roundcode (21 Nov 2026): knockout labels are no longer
    // strictly "descending by fixture count" (odd survivor pools can produce
    // repeated widths), and lexical ROUND_CODE order is wrong anyway
    // (FINAL < QUARTER_FINAL < ROUND_OF_16 ... alphabetically). Order knockout
    // rounds by their PROGRESSION rank (widest first), then by first-seen
    // created_at for labels outside the canonical progression (KNOCKOUT_ROUND_n
    // fallbacks), so "next round" after the cutoff always means the round that
    // chronologically follows the current one.
    const roundsRes = await this.db.execute({
      sql: `SELECT DISTINCT round_code, MIN(created_at) AS first_seen
            FROM fixtures
            WHERE tournament_id = ? AND round_code IS NOT NULL
              AND stage IN ('GROUP', 'KNOCKOUT')
            GROUP BY round_code
            ORDER BY CASE WHEN stage = 'GROUP' THEN 0 ELSE 1 END,
              CASE round_code
                WHEN 'ROUND_OF_32' THEN 0
                WHEN 'ROUND_OF_16' THEN 1
                WHEN 'QUARTER_FINAL' THEN 2
                WHEN 'SEMI_FINAL' THEN 3
                WHEN 'FINAL' THEN 4
                ELSE 5
              END ASC,
              first_seen ASC`,
      args: [tournamentId],
    });

    const allRounds = roundsRes.rows.map((r) => String((r as any).round_code ?? r[0]));

    // Earliest round with uncompleted matches (group rounds first, then knockout)
    // REVIEW-FIX blocker-roundcode: same progression ordering as allRounds
    // above, so the "current round" is the chronologically earliest unfinished
    // round (a ROUND_OF_16 that follows a ROUND_OF_32 must win over leftover
    // ROUND_OF_16 fixtures of an earlier round — first_seen handles that).
    const unfinRes = await this.db.execute({
      sql: `SELECT round_code, MIN(created_at) AS first_seen
            FROM fixtures
            WHERE tournament_id = ? AND round_code IS NOT NULL
              AND stage IN ('GROUP', 'KNOCKOUT')
              AND status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
            GROUP BY round_code
            ORDER BY CASE WHEN stage = 'GROUP' THEN 0 ELSE 1 END,
              CASE round_code
                WHEN 'ROUND_OF_32' THEN 0
                WHEN 'ROUND_OF_16' THEN 1
                WHEN 'QUARTER_FINAL' THEN 2
                WHEN 'SEMI_FINAL' THEN 3
                WHEN 'FINAL' THEN 4
                ELSE 5
              END ASC,
              first_seen ASC
            LIMIT 1`,
      args: [tournamentId],
    });

    const currentRoundCode = unfinRes.rows.length > 0
      ? String(unfinRes.rows[0][0] ?? (unfinRes.rows[0] as any).round_code)
      : null;

    return {
      tournamentId,
      tournamentName,
      currentRoundCode,
      allRounds,
    };
  }

  /**
   * Retrieves fixtures for a specific round with delegate WhatsApp identities.
   *
   * AUDIT-VERIFY-T17 (21 Nov 2026): the INNER JOIN on groups silently dropped
   * every KNOCKOUT fixture (group_id NULL) — the 19:59 cutoff was a no-op for
   * the knockout phase. The join is now a LEFT JOIN and the stage is carried
   * through so the cutoff can dispatch per-stage.
   */
  public async getRoundFixturesWithDelegates(
    tournamentId: string,
    roundCode: string
  ): Promise<MatchdayFixtureItem[]> {
    const res = await this.db.execute({
      sql: `
        SELECT
          f.id,
          f.round_code,
          f.stage,
          f.group_id,
          g.group_code,
          ta.team_name as team_a_name,
          tb.team_name as team_b_name,
          COALESCE(tl.team_name, ta.team_name) as host_name,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = ta.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_a_address,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = tb.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_b_address,
          f.status
        FROM fixtures f
        LEFT JOIN groups g ON f.group_id = g.id
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        LEFT JOIN teams tl ON f.left_side_team_id = tl.id
        WHERE f.tournament_id = ? AND f.round_code = ?
        ORDER BY CASE WHEN f.stage = 'GROUP' THEN 0 ELSE 1 END, g.group_code ASC, f.id ASC
      `,
      args: [tournamentId, roundCode],
    });

    return res.rows.map((r: any) => {
      const rawAddrA = r.delegate_a_address ? String(r.delegate_a_address) : null;
      const rawAddrB = r.delegate_b_address ? String(r.delegate_b_address) : null;

      let phoneA: string | null = null;
      let jidA: string | null = null;
      if (rawAddrA) {
        jidA = jidNormalizedUser(rawAddrA);
        phoneA = jidA.replace(/@.*$/, '');
      }

      let phoneB: string | null = null;
      let jidB: string | null = null;
      if (rawAddrB) {
        jidB = jidNormalizedUser(rawAddrB);
        phoneB = jidB.replace(/@.*$/, '');
      }

      return {
        id: String(r.id),
        roundCode: String(r.round_code),
        stage: String(r.stage),
        groupId: r.group_id ? String(r.group_id) : null,
        groupCode: r.group_code ? String(r.group_code) : null,
        teamAName: String(r.team_a_name),
        teamBName: String(r.team_b_name),
        hostName: String(r.host_name),
        delegateAAddress: rawAddrA,
        delegateBAddress: rawAddrB,
        delegateAPhone: phoneA,
        delegateBPhone: phoneB,
        delegateAJid: jidA,
        delegateBJid: jidB,
        status: String(r.status),
      };
    });
  }

  /**
   * Processes the daily 19:59 WIB cutoff.
   * Auto-resolves unplayed matches in the active round as Double Walkover (D-031),
   * recalculates standings, and advances to the next round if available.
   */
  public async processDailyCutoff(force = false): Promise<CutoffResult> {
    const { hours, minutes, dateStr } = this.getWibDateTime();

    // Check if 19:59 WIB
    if (!force && !(hours === 19 && minutes === 59)) {
      return { hasCutoffProcessed: false, resolvedFixturesCount: 0, expiredFixtures: [] };
    }

    // Check idempotency for today
    const auditRes = await this.db.execute({
      sql: `SELECT id FROM audit_events 
            WHERE event_type = 'MATCHDAY_CUTOFF' 
              AND entity_id = ?`,
      args: [dateStr],
    });

    if (!force && auditRes.rows.length > 0) {
      return { hasCutoffProcessed: false, resolvedFixturesCount: 0, expiredFixtures: [] };
    }

    const activeInfo = await this.getActiveTournamentCurrentRound();
    if (!activeInfo || !activeInfo.currentRoundCode) {
      return { hasCutoffProcessed: false, resolvedFixturesCount: 0, expiredFixtures: [] };
    }

    const { tournamentId, tournamentName, currentRoundCode, allRounds } = activeInfo;
    const fixtures = await this.getRoundFixturesWithDelegates(tournamentId, currentRoundCode);

    const pendingFixtures = fixtures.filter(
      (f) => !['COMPLETED', 'WALKOVER', 'CANCELLED'].includes(f.status)
    );

    const expiredFixtures: MatchdayFixtureItem[] = [];
    const modifiedGroupIds = new Set<string>();
    const expiredKoFixtures: MatchdayFixtureItem[] = [];

    for (const pf of pendingFixtures) {
      // AUDIT-VERIFY-T17: dispatch per stage. GROUP fixtures keep the D-031
      // double-walkover (0 pts each + standings recalc). KNOCKOUT fixtures use
      // the D-032 double-loss handler: the series closes with no winner and
      // the fixture is marked WALKOVER, which is exactly the signal
      // !startknockout uses to grant the pairing partner a bye into the next
      // round (the T2 odd-survivor handling already copes with the resulting
      // uneven pool).
      if (pf.stage === 'KNOCKOUT') {
        await handleKnockoutDoubleRoomCardFailure(
          this.db,
          pf.id,
          'Batas waktu matchday 19:59 WIB habis tanpa pertandingan knockout dimainkan (D-032)'
        );
        expiredKoFixtures.push(pf);
        expiredFixtures.push(pf);
        continue;
      }
      await handleGroupDoubleWalkover(
        this.db,
        pf.id,
        'DOUBLE_ABSENT',
        'Batas waktu matchday 19:59 WIB habis tanpa pertandingan dimainkan (D-031)'
      );
      if (pf.groupId) modifiedGroupIds.add(pf.groupId);
      expiredFixtures.push(pf);
    }

    // Recalculate standings for all affected groups
    for (const gid of modifiedGroupIds) {
      await recalculateAndPersistGroupStandings(this.db, tournamentId, gid);
    }

    // Record audit event for today's cutoff
    const nowIso = new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO audit_events (
              id, actor_type, actor_id, event_type, entity_type, entity_id,
              before_json, after_json, reason, correlation_id, created_at
            ) VALUES (?, 'SYSTEM', 'MATCHDAY_SCHEDULER', 'MATCHDAY_CUTOFF', 'TOURNAMENT', ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        dateStr,
        JSON.stringify({ roundCode: currentRoundCode, expiredCount: expiredFixtures.length }),
        JSON.stringify({ resolvedIds: expiredFixtures.map((f) => f.id) }),
        `Daily matchday cutoff 19:59 WIB (force: ${force})`,
        randomUUID(),
        nowIso,
      ],
    });

    // Check for next round
    const currentIdx = allRounds.indexOf(currentRoundCode);
    const nextRoundCode = (currentIdx >= 0 && currentIdx + 1 < allRounds.length)
      ? allRounds[currentIdx + 1]
      : null;

    // Compose announcement
    const lines: string[] = [];
    const mentionsSet = new Set<string>();

    const roundLabel = this.formatRoundLabel(currentRoundCode);

    if (expiredFixtures.length > 0) {
      lines.push(`⌛ *BATAS WAKTU MATCHDAY BERAKHIR (19:59 WIB)*`);
      lines.push(`──────────────────────────────`);
      lines.push(`🏆 *${tournamentName}* — *${roundLabel}*`);
      lines.push(``);
      lines.push(`Pertandingan berikut tidak dimainkan hingga batas waktu:`);
      const expiredGroupFixtures = expiredFixtures.filter((f) => f.stage !== 'KNOCKOUT');
      for (const ef of expiredGroupFixtures) {
        lines.push(`• *${ef.teamAName}* vs *${ef.teamBName}*${ef.groupCode ? ` (Grup ${ef.groupCode})` : ''}`);
      }
      for (const ef of expiredKoFixtures) {
        lines.push(`• *${ef.teamAName}* vs *${ef.teamBName}* (Knockout)`);
      }
      lines.push(``);
      if (expiredGroupFixtures.length > 0) {
        lines.push(`📌 *Regulasi Turnamen (D-031):*`);
        lines.push(`Kedua tim dinyatakan tidak hadir (Double Walkover). Skor dicatat 0–0 dan masing-masing tim mendapatkan *0 poin*.`);
      }
      if (expiredKoFixtures.length > 0) {
        lines.push(`📌 *Regulasi Knockout (D-032):*`);
        lines.push(`Series di atas dinyatakan *KALAH GANDA* (tidak ada pemenang). Pasangan bracket-nya akan mendapat *bye otomatis* ke ronde berikutnya saat Panitia menjalankan *!startknockout*.`);
      }
      lines.push(`──────────────────────────────`);
    }

    // Announce next round if exists
    if (nextRoundCode) {
      const nextRoundLabel = nextRoundCode.replace(/^ROUND_(\d+)$/i, 'Ronde $1').replace(/_/g, ' ');
      const nextFixtures = await this.getRoundFixturesWithDelegates(tournamentId, nextRoundCode);

      if (lines.length > 0) lines.push(``);
      lines.push(`📢 *MATCHDAY BARU RESMI DIMULAI (19:59 WIB)*`);
      lines.push(`──────────────────────────────`);
      lines.push(`🏆 *${tournamentName}* — *${nextRoundLabel}*`);
      lines.push(`⏰ Batas Waktu: 24 Jam (Berakhir besok pukul 19:59 WIB)`);
      lines.push(``);
      lines.push(`📅 *Jadwal Pertandingan Hari Ini:*`);

      for (const nf of nextFixtures) {
        const tagA = nf.delegateAPhone ? ` (@${nf.delegateAPhone})` : '';
        const tagB = nf.delegateBPhone ? ` (@${nf.delegateBPhone})` : '';
        lines.push(`⚽ *${nf.teamAName}*${tagA} vs *${nf.teamBName}*${tagB} (Host: ${nf.hostName})`);

        if (nf.delegateAJid) mentionsSet.add(nf.delegateAJid);
        if (nf.delegateBJid) mentionsSet.add(nf.delegateBJid);
      }

      lines.push(``);
      lines.push(`💡 _Segera hubungi delegasi lawan dan selesaikan pertandingan sebelum pukul 19:59 WIB besok!_`);
    }

    const announcementText = lines.length > 0 ? lines.join('\n') : null;
    const mentions = Array.from(mentionsSet);

    if (announcementText && this.sender && this.centralGroupJid) {
      await this.sender.sendText(this.centralGroupJid, announcementText, { mentions });
    }

    return {
      hasCutoffProcessed: true,
      resolvedFixturesCount: expiredFixtures.length,
      expiredFixtures,
      nextRoundCode,
      announcementText,
      mentions,
    };
  }

  /**
   * Checks and sends pre-deadline reminders at 17:00 WIB (H-3) and 18:59 WIB (H-1).
   */
  public async checkAndSendReminders(): Promise<ReminderResult> {
    const { hours, minutes, dateStr } = this.getWibDateTime();

    let slotKey: string | null = null;
    let labelHours: string | null = null;

    if (hours === 17 && minutes === 0) {
      slotKey = 'REMINDER_1700';
      labelHours = '3 Jam';
    } else if (hours === 18 && minutes === 59) {
      slotKey = 'REMINDER_1859';
      labelHours = '1 Jam';
    }

    if (!slotKey) {
      return { sent: false, pendingCount: 0 };
    }

    // Check if this reminder slot already sent today
    const auditRes = await this.db.execute({
      sql: `SELECT id FROM audit_events 
            WHERE event_type = ? AND entity_id = ?`,
      args: [slotKey, dateStr],
    });

    if (auditRes.rows.length > 0) {
      return { sent: false, pendingCount: 0 };
    }

    const activeInfo = await this.getActiveTournamentCurrentRound();
    if (!activeInfo || !activeInfo.currentRoundCode) {
      return { sent: false, pendingCount: 0 };
    }

    const { tournamentId, tournamentName, currentRoundCode } = activeInfo;
    const fixtures = await this.getRoundFixturesWithDelegates(tournamentId, currentRoundCode);

    const pending = fixtures.filter(
      (f) => !['COMPLETED', 'WALKOVER', 'CANCELLED'].includes(f.status)
    );

    if (pending.length === 0) {
      return { sent: false, pendingCount: 0 };
    }

    const roundLabel = this.formatRoundLabel(currentRoundCode);
    const mentionsSet = new Set<string>();

    const lines: string[] = [];
    lines.push(`⏰ *PENGINGAT MATCHDAY — SISA ${labelHours?.toUpperCase()} LAGI!*`);
    lines.push(`──────────────────────────────`);
    lines.push(`🏆 *${tournamentName}* — *${roundLabel}*`);
    lines.push(`Batas waktu pertandingan: *Hari ini pukul 19:59 WIB*`);
    lines.push(``);
    lines.push(`Pertandingan berikut belum dilaporkan / belum selesai:`);

    for (const pf of pending) {
      const tagA = pf.delegateAPhone ? ` (@${pf.delegateAPhone})` : '';
      const tagB = pf.delegateBPhone ? ` (@${pf.delegateBPhone})` : '';
      // REVIEW-FIX quickwin-group-null-message (21 Nov 2026): knockout
      // fixtures have no group — label them "(Knockout)" instead of
      // rendering "(Grup null)".
      const stageLabel = pf.stage === 'KNOCKOUT' ? ' (Knockout)' : ` (Grup ${pf.groupCode})`;
      lines.push(`• *${pf.teamAName}*${tagA} vs *${pf.teamBName}*${tagB}${stageLabel}`);

      if (pf.delegateAJid) mentionsSet.add(pf.delegateAJid);
      if (pf.delegateBJid) mentionsSet.add(pf.delegateBJid);
    }

    lines.push(``);
    // REVIEW-FIX quickwin-group-null-message: quote the regulation that
    // actually applies — D-031 (double walkover) for group fixtures,
    // D-032 (double loss + bye) for knockout fixtures.
    const pendingHasKo = pending.some((f) => f.stage === 'KNOCKOUT');
    const pendingHasGroup = pending.some((f) => f.stage !== 'KNOCKOUT');
    if (pendingHasGroup) {
      lines.push(`⚠️ _Sesuai regulasi turnamen (D-031), pertandingan yang tidak diselesaikan hingga 19:59 WIB otomatis dinyatakan Double Walkover (0 poin untuk kedua tim)._`);
    }
    if (pendingHasKo) {
      lines.push(`⚠️ _Sesuai regulasi knockout (D-032), series yang tidak diselesaikan hingga 19:59 WIB dinyatakan KALAH GANDA (tidak ada pemenang) dan pasangan bracket-nya mendapat bye otomatis._`);
    }
    lines.push(`Segera bertanding dan kirimkan bukti screenshot skor ke grup! 🔥`);

    const announcementText = lines.join('\n');
    const mentions = Array.from(mentionsSet);

    // Record audit event
    const nowIso = new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO audit_events (
              id, actor_type, actor_id, event_type, entity_type, entity_id,
              before_json, after_json, reason, correlation_id, created_at
            ) VALUES (?, 'SYSTEM', 'MATCHDAY_SCHEDULER', ?, 'TOURNAMENT', ?, null, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        slotKey,
        dateStr,
        JSON.stringify({ pendingCount: pending.length }),
        `Pre-deadline reminder for ${dateStr} (${slotKey})`,
        randomUUID(),
        nowIso,
      ],
    });

    if (this.sender && this.centralGroupJid) {
      await this.sender.sendText(this.centralGroupJid, announcementText, { mentions });
    }

    return {
      sent: true,
      reminderSlot: slotKey,
      pendingCount: pending.length,
      announcementText,
      mentions,
    };
  }

  /**
   * Formats a round code into a human label. Group rounds become
   * "Ronde N"; knockout rounds keep their bracket label (FIX2-KO-001).
   */
  private formatRoundLabel(roundCode: string): string {
    if (/^ROUND_(\d+)$/i.test(roundCode)) {
      return roundCode.replace(/^ROUND_(\d+)$/i, 'Ronde $1');
    }
    return roundCode.replace(/_/g, ' ');
  }

  /**
   * Formats a comprehensive matchday status for user display (!matchday).
   */
  public async formatMatchdayStatus(): Promise<string> {
    const activeInfo = await this.getActiveTournamentCurrentRound();
    if (!activeInfo) {
      return '⚠️ Belum ada turnamen aktif yang sedang berjalan.';
    }

    const { tournamentId, tournamentName, currentRoundCode, allRounds } = activeInfo;
    const { timeStr, dateStr } = this.getWibDateTime();
    const remaining = this.getTimeRemainingToCutoff();

    if (!currentRoundCode) {
      return [
        `🏆 *${tournamentName.toUpperCase()}*`,
        `──────────────────────────────`,
        `✅ *Semua pertandingan babak grup telah selesai!*`,
        `Panitia dapat memeriksa klasemen akhir dengan *!standings* atau memulai fase knockout.`,
      ].join('\n');
    }

    const roundLabel = this.formatRoundLabel(currentRoundCode);
    const fixtures = await this.getRoundFixturesWithDelegates(tournamentId, currentRoundCode);

    const completed = fixtures.filter((f) => ['COMPLETED', 'WALKOVER'].includes(f.status));
    const pending = fixtures.filter((f) => !['COMPLETED', 'WALKOVER', 'CANCELLED'].includes(f.status));

    const lines: string[] = [];
    lines.push(`⏱️ *STATUS MATCHDAY TURNAMEN*`);
    lines.push(`──────────────────────────────`);
    lines.push(`🏆 *Turnamen:* ${tournamentName}`);
    lines.push(`📌 *Ronde Aktif:* ${roundLabel} (dari total ${allRounds.length} ronde)`);
    lines.push(`🕒 *Waktu Server Sekarang:* ${timeStr} WIB (${dateStr})`);
    lines.push(`⏰ *Batas Waktu Harian:* Pukul 19:59 WIB`);
    lines.push(`⏳ *Sisa Waktu Menuju Deadline:* ${remaining.formatted}`);
    lines.push(``);
    lines.push(`📊 *Progres ${roundLabel}:*`);
    lines.push(`  ✅ Selesai: *${completed.length}* pertandingan`);
    lines.push(`  ⏳ Belum Selesai: *${pending.length}* pertandingan`);

    if (pending.length > 0) {
      lines.push(``);
      lines.push(`⚠️ *Pertandingan yang Belum Selesai:*`);
      for (const pf of pending) {
        const tagA = pf.delegateAPhone ? ` (@${pf.delegateAPhone})` : '';
        const tagB = pf.delegateBPhone ? ` (@${pf.delegateBPhone})` : '';
        // REVIEW-FIX quickwin-group-null-message (21 Nov 2026): knockout
        // fixtures have no group — label them "(Knockout)" instead of
        // rendering "(Grup null)".
        const stageLabel = pf.stage === 'KNOCKOUT' ? ' (Knockout)' : ` (Grup ${pf.groupCode})`;
        lines.push(`  • *${pf.teamAName}*${tagA} vs *${pf.teamBName}*${tagB}${stageLabel}`);
      }
      lines.push(``);
      // REVIEW-FIX quickwin-group-null-message: quote the regulation that
      // actually applies — D-031 for group fixtures, D-032 for knockout.
      const pendingHasKo = pending.some((f) => f.stage === 'KNOCKOUT');
      const pendingHasGroup = pending.some((f) => f.stage !== 'KNOCKOUT');
      if (pendingHasGroup) {
        lines.push(`💡 _Pertandingan grup yang belum selesai pukul 19:59 WIB akan otomatis dinyatakan Double Walkover (0 poin) sesuai regulasi D-031._`);
      }
      if (pendingHasKo) {
        lines.push(`💡 _Series knockout yang belum selesai pukul 19:59 WIB dinyatakan KALAH GANDA (tidak ada pemenang) sesuai regulasi D-032, dan pasangan bracket-nya mendapat bye otomatis._`);
      }
    } else {
      lines.push(``);
      lines.push(`🎉 *Luar biasa! Seluruh pertandingan ${roundLabel} sudah selesai dimainkan.*`);
      lines.push(`Ronde berikutnya akan dimulai otomatis pukul 19:59 WIB.`);
    }

    return lines.join('\n');
  }
}
