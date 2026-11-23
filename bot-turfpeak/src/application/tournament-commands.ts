/**
 * Flash Peak TMS - Tournament Command Handlers (Application Layer)
 * 
 * Registers and coordinates all tournament management WhatsApp command use cases:
 * - !standings: Current group standings tables
 * - !awards: Authoritative tournament awards summary
 * - !schedule / !jadwal: Balanced group stage fixture schedules
 * - !approve: Three-party match report consensus approvals
 * - !createtournament: Tournament registration opening
 * - !draw: Cryptographic draw with live progressive team reveals
 * - !addteam: Team roster pre-registration
 * - !onboarding: Interactive sequential delegate verification
 * - !manualreport: Admin manual match report fallback (FR-FAIL-003, FR-FAIL-004, FR-FAIL-005)
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { CommandRouter } from '../whatsapp/router.js';
import type { CommandContext } from '../whatsapp/types.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { OnboardingService } from '../identity/onboarding.js';
import type { MatchdayService } from './matchday-service.js';
import { createTournament } from '../competition/tournament.js';
import { prepareDraw, revealNext, cryptoFisherYates } from '../competition/draw.js';
import {
  generateGroupStageFixtures,
  generateKnockoutFixtures,
  deriveKnockoutQualifiers,
  type KnockoutQualifier,
} from '../competition/fixtures.js';
import {
  recordSeriesGameResult,
  getSeriesByFixture,
  evaluateSeriesProgress,
} from '../competition/series.js';
import {
  applyKoGameEvidence,
  getKoSeriesContext,
  deriveOpenGameSlot,
} from './ko-evidence-pipeline.js';
import { calculateTournamentAwards } from '../stats/awards.js';
import { handleSingleForfeit, evaluateRoomHostAvailability } from '../competition/walkover.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';
import { handleManualReport } from '../reports/manual.js';
import {
  organizerOverrideLock,
  organizerReopenReport,
} from '../reports/approval.js';
import { getReportVersion } from '../reports/versioning.js';
import type { RawPlayerMatchStat } from '../reports/validation.js';
import {
  formatAwardsAnnouncement,
  formatDrawCompletedSummary,
  formatDrawRevealStep,
  formatFixturesSchedule,
  formatMatchReportSummary,
  formatKnockoutBracketAnnouncement,
  formatSeriesGameReportMessage,
  formatKnockoutNextRoundMessage,
  type CompletedDrawGroup,
  type FixtureScheduleDisplayItem,
} from '../whatsapp/formatters.js';
import {
  parseQuickReport,
  matchScorerToRoster,
  buildLineupWithScorers,
} from '../reports/manual-parser.js';
import type { ManualReportSessionManager, MatchedScorerDetail, PendingManualReport } from './manual-report-session.js';
import type { WoClaimSessionManager, PendingWoClaim } from './wo-claim-session.js';
import type { RosterExtractor } from '../ai/extractors/roster.js';
import type {
  ApproverType,
  ApprovalDecision,
  DrawResultGroupAssignment,
  Player,
  ReportVersion,
  UUID,
} from '../shared/types/index.js';
import type { ApprovalOutcome } from '../reports/approval.js';

export interface TournamentCommandDeps {
  db: Client;
  identityResolver: IdentityResolver;
  onboardingService: OnboardingService;
  manualReportSession: ManualReportSessionManager;
  matchdayService?: MatchdayService;
  woClaimSession?: WoClaimSessionManager;
  sender?: WhatsAppSender;
  rosterExtractor?: RosterExtractor;
  providerRouter?: import('../ai/router.js').ProviderRouter;
  classifier?: import('../ai/classifier.js').ImageClassifier;
  matchExtractor?: import('../ai/extractors/match.js').MatchSummaryExtractor;
  mediaClient?: import('../media/client.js').FlashPeakMediaClient;
  getStandingsTable: (
    tournamentId: UUID,
    groupId: UUID,
    groupCode?: string,
    options?: { showFooter?: boolean }
  ) => Promise<string>;
  submitApproval: (
    reportVersionId: UUID,
    approverType: ApproverType,
    approverId: string,
    decision: ApprovalDecision,
    isOrganizer?: boolean
  ) => Promise<ApprovalOutcome>;
  findVersionByMessageKey: (messageKey: string) => Promise<ReportVersion | null>;
}

export interface ParsedRosterInput {
  isRegistration: boolean;
  teamName: string | undefined;
  gkName: string | undefined;
  starterList: string[];
  subList: string[];
}

/**
 * Robust and Lenient Roster Parser for Both Rigid and Natural Language Input (Deterministic Fallback)
 */
export function parseRosterInput(raw: string): ParsedRosterInput {
  const norm = raw.trim();

  // 1. Check if input is formatted as a Markdown Table
  const isMarkdownTable =
    /\|(?:\s*:?-+:?\s*\|)+/.test(norm) ||
    (/^\s*\|.*\|\s*$/m.test(norm) && /(?:no|nomor|posisi|role|nickname|pemain|kiper|gk)\s*\|/i.test(norm));

  if (isMarkdownTable) {
    const allLines = norm.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const preTableLines: string[] = [];
    const tableDataLines: string[] = [];

    let tableStarted = false;
    for (const line of allLines) {
      const isSeparator = /^\s*\|?\s*(?::?-+:?\s*\|)+\s*(?::?-+:?)?\s*\|?\s*$/.test(line);
      const isHeader = /^\s*\|?\s*(?:no|nomor|#|posisi|position|role|pos|nama|nickname|player|pemain)(?:\s*\|\s*(?:no|nomor|#|posisi|position|role|pos|nama|nickname|player|pemain))*\s*\|?\s*$/i.test(line);

      if (isSeparator || isHeader) {
        tableStarted = true;
        continue;
      }

      if (line.startsWith('|') || /\|\s*(?:gk|kiper|inti|cadangan|starter)\s*\|/i.test(line)) {
        tableStarted = true;
        tableDataLines.push(line);
      } else if (!tableStarted) {
        preTableLines.push(line);
      }
    }

    let teamName: string | undefined;
    if (preTableLines.length > 0) {
      const rawTeam = preTableLines.join(' ')
        .replace(/^(?:!roster|roster|daftar\s+roster|daftar|tim|team|nama\s*tim)\s+/i, '')
        .replace(/[|:,;.-]+$/, '')
        .trim();
      if (rawTeam.length >= 2) {
        teamName = rawTeam;
      }
    }

    let tableGk: string | undefined;
    const tableStarters: string[] = [];
    const tableSubs: string[] = [];

    for (const line of tableDataLines) {
      const inner = line.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '');
      const cells = inner.split('|').map((c) => c.trim());

      let role: 'GK' | 'INTI' | 'SUB' | null = null;
      const remainingCells: string[] = [];

      for (const cell of cells) {
        if (!cell) continue;
        if (!role && /^(?:gk|kiper|penjaga\s*gawang|goal\s*keeper)$/i.test(cell)) {
          role = 'GK';
        } else if (!role && /^(?:inti|starter|starters|utama|lineup|pemain\s*inti)$/i.test(cell)) {
          role = 'INTI';
        } else if (!role && /^(?:cadangan|sub|subs|substitute|substitutes|cad)$/i.test(cell)) {
          role = 'SUB';
        } else if (/^\d+$/.test(cell) && remainingCells.length === 0) {
          // Skip leading row index
          continue;
        } else {
          remainingCells.push(cell);
        }
      }

      const playerNickname = remainingCells.join(' | ').trim();
      if (!playerNickname) continue;

      if (role === 'GK') {
        tableGk = playerNickname;
      } else if (role === 'INTI') {
        tableStarters.push(playerNickname);
      } else if (role === 'SUB') {
        tableSubs.push(playerNickname);
      } else {
        if (!tableGk) {
          tableGk = playerNickname;
        } else if (tableStarters.length < 4) {
          tableStarters.push(playerNickname);
        } else {
          tableSubs.push(playerNickname);
        }
      }
    }

    if (tableGk || tableStarters.length > 0) {
      return {
        isRegistration: true,
        teamName,
        gkName: tableGk,
        starterList: tableStarters,
        subList: tableSubs,
      };
    }
  }

  // Check if this is an attempt to register
  const hasGkKeyword = /(?:^|[|\n;,.]|\b)(?:gk|kiper|penjaga\s*gawang|goal\s*keeper)(?:nya)?(?:\b|:|=|\s)/i.test(norm);
  const hasIntiKeyword = /(?:^|[|\n;,.]|\b)(?:pemain\s*inti|inti|starters?|pemain\s*utama|lineup)(?:nya)?(?:\b|:|=|\s)/i.test(norm);

  if (!hasGkKeyword && !hasIntiKeyword) {
    return {
      isRegistration: false,
      teamName: undefined,
      gkName: undefined,
      starterList: [],
      subList: [],
    };
  }

  const gkRegex = /(?:^|[|\n;,.]|\b)(?:gk|kiper|penjaga\s*gawang|goal\s*keeper)(?:nya)?(?:\s*(?:adalah|:|=|nya|-)?)\s*/i;
  const intiRegex = /(?:^|[|\n;,.]|\b)(?:pemain\s*inti|inti|starters?|pemain\s*utama|lineup)(?:nya)?(?:\s*(?:adalah|:|=|nya|-)?)\s*/i;
  const subRegex = /(?:^|[|\n;,.]|\b)(?:pemain\s*cadangan|cadangan|subs?|substitutes?|cad)(?:nya)?(?:\s*(?:adalah|:|=|nya|-)?)\s*/i;

  interface Marker {
    type: 'GK' | 'INTI' | 'SUB';
    matchIndex: number;
    contentStartIndex: number;
  }

  const markers: Marker[] = [];

  const gkMatch = norm.match(gkRegex);
  if (gkMatch && gkMatch.index !== undefined) {
    markers.push({
      type: 'GK',
      matchIndex: gkMatch.index,
      contentStartIndex: gkMatch.index + gkMatch[0].length,
    });
  }

  const intiMatch = norm.match(intiRegex);
  if (intiMatch && intiMatch.index !== undefined) {
    markers.push({
      type: 'INTI',
      matchIndex: intiMatch.index,
      contentStartIndex: intiMatch.index + intiMatch[0].length,
    });
  }

  const subMatch = norm.match(subRegex);
  if (subMatch && subMatch.index !== undefined) {
    markers.push({
      type: 'SUB',
      matchIndex: subMatch.index,
      contentStartIndex: subMatch.index + subMatch[0].length,
    });
  }

  markers.sort((a, b) => a.matchIndex - b.matchIndex);

  let teamNameCandidate = '';
  if (markers.length > 0) {
    teamNameCandidate = norm.substring(0, markers[0].matchIndex).trim();
  }

  let teamName: string | undefined = teamNameCandidate
    .replace(/^(?:tim|team|daftar\s+roster|daftar|roster|nama\s*tim)\s+/i, '')
    .replace(/[|:,;.-]+$/, '')
    .trim();

  if (!teamName || teamName.length < 2) {
    teamName = undefined;
  }

  let rawGk = '';
  let rawInti = '';
  let rawSub = '';

  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const nextStart = i + 1 < markers.length ? markers[i + 1].matchIndex : norm.length;
    let content = norm.substring(cur.contentStartIndex, nextStart).trim();
    content = content.replace(/\s*\|\s*$/, '').trim();

    if (cur.type === 'GK') {
      rawGk = content;
    } else if (cur.type === 'INTI') {
      rawInti = content;
    } else if (cur.type === 'SUB') {
      rawSub = content;
    }
  }

  const extractNames = (str: string): string[] => {
    // Split by newlines first so each line is treated as a separate entry
    const lines = str.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const results: string[] = [];

    for (const line of lines) {
      // If the line contains comma or semicolon or "dan"/"&", split by those.
      // DO NOT split by pipe '|' or hyphen '-' since clan tags use them (e.g. AVO | Zenyth).
      const parts = line.includes(',') || line.includes(';') || /\s+dan\s+|\s+&\s+/i.test(line)
        ? line.split(/[,;]+|\s+dan\s+|\s+&\s+/i)
        : [line];

      for (const part of parts) {
        const cleaned = part
          .replace(/^\s*(?:[-•*]|\d+[\.\)]|\[\d+\])\s*/, '')
          .replace(/[.,;]+$/, '')
          .trim();
        if (cleaned.length > 0 && !/^(?:dan|and|nya|adalah)$/i.test(cleaned)) {
          results.push(cleaned);
        }
      }
    }

    return results;
  };

  const gkNames = extractNames(rawGk);
  let gkName = gkNames.length > 0 ? gkNames[0] : undefined;
  let starterList = extractNames(rawInti);
  const subList = extractNames(rawSub);

  // Fallback: If no explicit INTI keyword was provided, but multiple names follow GK (e.g. GK: Budi \n 1. Doni \n 2. Eko)
  if (starterList.length === 0 && gkNames.length > 1) {
    gkName = gkNames[0];
    starterList = gkNames.slice(1);
  }

  // Clean up trailing (GK) or (Kiper) tag from gkName ONLY if in parentheses or preceded by whitespace
  if (gkName) {
    gkName = gkName.replace(/(?:\s*\((?:gk|kiper)\)|\s+(?:gk|kiper))$/i, '').trim();
  }

  return {
    isRegistration: true,
    teamName,
    gkName,
    starterList,
    subList,
  };
}

export function registerTournamentCommands(
  router: CommandRouter,
  deps: TournamentCommandDeps
): void {
  const { db } = deps;

  // !standings <group_code>
  router.registerCommand({
    command: 'standings',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Klasemen per grup atau semua grup (contoh: !standings, !standings A, !standings grup B)',
    handler: async (ctx: CommandContext) => {
      // FIX-STANDINGS-ROBUST (21 Nov 2026): accept variants
      //   !standings            → all groups
      //   !standings C          → single letter (original)
      //   !standings grup C     → "grup" + letter (split by whitespace)
      //   !standings Group A    → mixed case prefix word
      //   !standings GRUP B     → all caps prefix
      //   !standings grupC      → prefix glued to letter
      const PREFIX_RE = /^(?:GRUP|GROUP|GRUB|KELAS)\s*/i;
      let groupArg = ctx.args[0]?.toUpperCase().trim() || '';
      if (groupArg) {
        const stripped = groupArg.replace(PREFIX_RE, '').trim();
        if (stripped) {
          // "grupC" → "C"; "Group A" → "A" (after upper+strip)
          groupArg = stripped;
        } else {
          // args[0] was purely the prefix word (e.g. "GRUP"); take args[1]
          groupArg = ctx.args[1]?.toUpperCase().trim() || '';
        }
      }
      // FIX-STANDINGS-ALL (21 Nov 2026): tanpa argumen → tampilkan semua grup.
      const allGroupsRes = await db.execute({
        sql: `SELECT g.id, g.group_code, gd.tournament_id
              FROM groups g
              JOIN group_draws gd ON g.draw_id = gd.id
              ORDER BY g.group_code ASC`,
      });

      if (allGroupsRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Belum ada grup yang dibuat. Jalankan *!draw* terlebih dahulu.' };
      }

      // Single-group mode: !standings A / !standings B / etc.
      if (groupArg) {
        const row = allGroupsRes.rows.find((r: any) => String(r.group_code).toUpperCase() === groupArg);
        if (!row) {
          const available = allGroupsRes.rows.map((r: any) => String(r.group_code)).join(', ');
          return { success: false, responseText: `⚠️ Grup *${groupArg}* tidak ditemukan. Grup tersedia: ${available}` };
        }
        const groupId = String(row.id);
        const tournamentId = String(row.tournament_id);
        const standingsText = await deps.getStandingsTable(tournamentId, groupId, groupArg);
        return { success: true, responseText: standingsText };
      }

      // All-groups mode: !standings (tanpa argumen) → gabungan semua grup.
      const tournamentId = String(allGroupsRes.rows[0].tournament_id);
      const tournamentNameRow = await db.execute({
        sql: 'SELECT name FROM tournaments WHERE id = ?',
        args: [tournamentId],
      });
      const tournamentName = String(tournamentNameRow.rows[0]?.name || 'Turnamen');
      const blocks: string[] = [];
      blocks.push(`📊 *KLASEMEN ${tournamentName.toUpperCase()} — SEMUA GRUP*`);
      blocks.push('──────────────────────────────');
      for (let idx = 0; idx < allGroupsRes.rows.length; idx++) {
        const r = allGroupsRes.rows[idx];
        const gid = String(r.id);
        const gcode = String(r.group_code);
        const oneBlock = await deps.getStandingsTable(tournamentId, gid, gcode, { showFooter: false });
        blocks.push(oneBlock);
        if (idx < allGroupsRes.rows.length - 1) {
          blocks.push('──────────────────────────────');
        }
      }
      blocks.push('');
      blocks.push('💡 _Keterangan: Top 2 tim tiap grup lolos ke Babak Knockout._');
      return { success: true, responseText: blocks.join('\n') };
    },
  });

  // !awards
  router.registerCommand({
    command: 'awards',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan daftar perolehan penghargaan turnamen (Juara, Top Scorer, Best GK)',
    handler: async () => {
      const res = await db.execute('SELECT id, name FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (res.rows.length === 0) {
        return { success: false, responseText: 'Belum ada turnamen yang terdaftar.' };
      }
      const tournamentId = String(res.rows[0][0]);
      const tournamentName = String(res.rows[0][1]);
      const awards = await calculateTournamentAwards(db, tournamentId);
      const text = formatAwardsAnnouncement(tournamentName, awards);
      return { success: true, responseText: text };
    },
  });

  // !schedule / !jadwal [hari ini | tim | grup]
  const scheduleHandler = async (ctx?: CommandContext) => {
    const rawFilter = (ctx?.rawArgs || '').trim().toLowerCase();

    // 1. If asking about today / active matchday (e.g. "!jadwal hari ini apa", "!jadwal hari ini", "!jadwal sekarang")
    const isTodayQuery =
      rawFilter.includes('hari ini') ||
      rawFilter.includes('today') ||
      rawFilter.includes('sekarang') ||
      rawFilter.includes('ronde ini') ||
      rawFilter.includes('saat ini');

    if (isTodayQuery && deps.matchdayService) {
      const matchdayStatus = await deps.matchdayService.formatMatchdayStatus();
      return {
        success: true,
        responseText: matchdayStatus,
      };
    }

    const tRes = await db.execute("SELECT id, name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
    if (tRes.rows.length === 0) {
      return { success: false, responseText: '⚠️ Belum ada turnamen aktif.' };
    }
    const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
    const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

    const fixturesRes = await db.execute({
      sql: `
        SELECT 
          f.round_code, 
          f.status as fixture_status,
          g.group_code, 
          ta.team_name as team_a_name, 
          tb.team_name as team_b_name, 
          tl.team_name as host_name,
          gm.team_a_score,
          gm.team_b_score,
          gm.is_walkover,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = ta.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_a_address,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = tb.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_b_address
        FROM fixtures f
        LEFT JOIN groups g ON f.group_id = g.id
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        LEFT JOIN teams tl ON f.left_side_team_id = tl.id
        LEFT JOIN games gm ON gm.fixture_id = f.id
        WHERE f.tournament_id = ?
        ORDER BY g.group_code ASC, f.round_code ASC
      `,
      args: [tournamentId],
    });

    if (fixturesRes.rows.length === 0) {
      return { success: false, responseText: '⚠️ Jadwal pertandingan belum dibuat. Jalankan *!draw* terlebih dahulu.' };
    }

    const mentionsSet = new Set<string>();
    let scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r: any) => {
      const rawAddrA = r.delegate_a_address ? String(r.delegate_a_address) : null;
      const rawAddrB = r.delegate_b_address ? String(r.delegate_b_address) : null;

      let phoneA: string | null = null;
      let jidA: string | null = null;
      if (rawAddrA) {
        jidA = jidNormalizedUser(rawAddrA);
        phoneA = jidA.replace(/@.*$/, '');
        mentionsSet.add(jidA);
      }

      let phoneB: string | null = null;
      let jidB: string | null = null;
      if (rawAddrB) {
        jidB = jidNormalizedUser(rawAddrB);
        phoneB = jidB.replace(/@.*$/, '');
        mentionsSet.add(jidB);
      }

      const scoreA = r.team_a_score !== null && r.team_a_score !== undefined ? Number(r.team_a_score) : null;
      const scoreB = r.team_b_score !== null && r.team_b_score !== undefined ? Number(r.team_b_score) : null;
      const isWo = Number(r.is_walkover) === 1;

      return {
        roundCode: String(r.round_code),
        groupCode: r.group_code ? String(r.group_code) : '-',
        teamAName: String(r.team_a_name),
        teamBName: String(r.team_b_name),
        leftSideHostName: String(r.host_name || r.team_a_name),
        teamADelegatePhone: phoneA,
        teamBDelegatePhone: phoneB,
        teamADelegateJid: jidA,
        teamBDelegateJid: jidB,
        status: r.fixture_status ? String(r.fixture_status) : null,
        teamAScore: scoreA,
        teamBScore: scoreB,
        isWalkover: isWo,
      };
    });

    // 2. Filter by specific team or group if specified
    if (rawFilter && !isTodayQuery) {
      const groupMatch = rawFilter.match(/\b(?:grup|group)\s*([a-z0-9]+)\b/i);
      if (groupMatch && groupMatch[1]) {
        const targetGroup = groupMatch[1].toUpperCase();
        scheduleItems = scheduleItems.filter((item) => item.groupCode?.toUpperCase() === targetGroup);
      } else {
        const cleanFilter = rawFilter.replace(/^(jadwal|schedule|main|lawan)\s*/i, '').trim();
        if (cleanFilter.length >= 2) {
          scheduleItems = scheduleItems.filter(
            (item) =>
              item.teamAName.toLowerCase().includes(cleanFilter) ||
              item.teamBName.toLowerCase().includes(cleanFilter)
          );
        }
      }

      if (scheduleItems.length === 0) {
        return {
          success: false,
          responseText: `⚠️ Tidak ditemukan jadwal pertandingan untuk kriteria "${rawFilter}". Ketik *!schedule* untuk melihat semua jadwal.`,
        };
      }
    }

    const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);
    return {
      success: true,
      responseText: scheduleMsg,
      metadata: {
        mentions: Array.from(mentionsSet),
      },
    };
  };

  router.registerCommand({
    command: 'schedule',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan jadwal pertandingan resmi turnamen',
    handler: scheduleHandler,
  });

  router.registerCommand({
    command: 'jadwal',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan jadwal pertandingan resmi turnamen',
    handler: scheduleHandler,
  });

  // !approve
  router.registerCommand({
    command: 'approve',
    requiredRole: 'DELEGATE',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengesahkan draf laporan pertandingan (Reply draf skor atau ketik !approve <id>)',
    handler: async (ctx: CommandContext) => {
      let versionId = ctx.args[0];
      if (!versionId && ctx.message.reply_to_key) {
        const ver = await deps.findVersionByMessageKey(ctx.message.reply_to_key);
        if (ver) versionId = ver.id;
      }
      if (!versionId) {
        const latestVer = await db.execute(`
          SELECT rv.id FROM report_versions rv
          JOIN fixtures f ON rv.fixture_id = f.id
          JOIN tournaments t ON f.tournament_id = t.id
          WHERE t.status = 'ACTIVE' AND rv.status IN ('PENDING_APPROVAL', 'NEEDS_CORRECTION')
          ORDER BY rv.created_at DESC LIMIT 1
        `);
        if (latestVer.rows.length > 0) {
          versionId = String(latestVer.rows[0].id ?? latestVer.rows[0][0]);
        }
      }
      if (!versionId) {
        return {
          success: false,
          responseText: '⚠️ Balas/kutip pesan draf laporan pertandingan dengan *!approve*, atau ketik: `!approve <id>`',
        };
      }
      let approverType: ApproverType = 'ORGANIZER';
      if (ctx.role === 'DELEGATE') {
        const verRes = await db.execute({
          sql: `SELECT f.team_a_id, f.team_b_id, ta.delegate_id, tb.delegate_id
                FROM report_versions rv
                JOIN fixtures f ON rv.fixture_id = f.id
                LEFT JOIN teams ta ON f.team_a_id = ta.id
                LEFT JOIN teams tb ON f.team_b_id = tb.id
                WHERE rv.id = ?`,
          args: [versionId],
        });
        if (verRes.rows.length > 0) {
          const row = verRes.rows[0];
          const delA = row[2] ? String(row[2]) : null;
          const delB = row[3] ? String(row[3]) : null;
          if (ctx.delegateId === delA) approverType = 'TEAM_A';
          else if (ctx.delegateId === delB) approverType = 'TEAM_B';
        }
      }

      const approverId = ctx.delegateId || ctx.message.sender_normalized_address;
      const outcome = await deps.submitApproval(
        versionId,
        approverType,
        approverId,
        'APPROVE',
        ctx.isOrganizer
      );
      return { success: outcome.isLocked, responseText: outcome.message };
    },
  });

  // !createtournament <tournament_name>
  router.registerCommand({
    command: 'createtournament',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membuat turnamen baru format grup + gugur (Admin only)',
    handler: async (ctx: CommandContext) => {
      const name = ctx.rawArgs.trim();
      if (!name) {
        return {
          success: false,
          responseText: '⚠️ Format: *!createtournament <Nama Turnamen>*\nContoh: `!createtournament Flash Peak Championship Season 1`',
        };
      }

      try {
        const tournament = await createTournament(db, {
          name,
          format: 'GROUP_AND_KNOCKOUT',
        });

        return {
          success: true,
          responseText: [
            `🏆 *TURNAMEN BERHASIL DIBUAT*`,
            `──────────────────────────────`,
            `📌 *Nama:* ${tournament.name}`,
            `🆔 *ID:* \`${tournament.id}\``,
            `📊 *Format:* Babak Grup + Knockout (D-008)`,
            `⚙️ *Status:* DRAFT / REGISTRATION`,
            ``,
            `Pendaftaran tim dibuka. Panitia & delegasi dapat mendaftarkan tim ke turnamen ini.`,
          ].join('\n'),
        };
      } catch (err: any) {
        return {
          success: false,
          responseText: `❌ Gagal membuat turnamen: ${err.message || String(err)}`,
        };
      }
    },
  });

  // !draw [tournament_id] [size=4|5]
  router.registerCommand({
    command: 'draw',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengundi pembagian grup secara acak dan membuat jadwal pertandingan (Admin only). Opsi: size=4|5 untuk memilih ukuran grup target (default 5).',
    handler: async (ctx: CommandContext) => {
      // FIX2-COMP-DYN: dynamic group sizing. Args may contain an optional
      // `size=<4|5>` flag (default 5 = FR-COMP-010 behaviour); remaining args
      // are the optional tournament_id as before.
      const rawArgsList = ctx.rawArgs.trim().split(/\s+/).filter(Boolean);
      let targetGroupSize: 4 | 5 = 5;
      const positionalArgs: string[] = [];
      for (const arg of rawArgsList) {
        const sizeMatch = arg.match(/^size[=\s](\d+)$/i) ?? null;
        if (sizeMatch) {
          const requested = Number(sizeMatch[1]);
          if (requested !== 4 && requested !== 5) {
            return {
              success: false,
              responseText: '⚠️ Ukuran grup hanya boleh *4* atau *5* tim per grup (FR-COMP-010). Contoh: `!draw size=5`.',
            };
          }
          targetGroupSize = requested as 4 | 5;
        } else {
          positionalArgs.push(arg);
        }
      }

      let tournamentId = positionalArgs[0]?.trim() || '';
      let tournamentName = '';

      if (tournamentId) {
        const tRes = await db.execute({
          sql: `SELECT id, name, status FROM tournaments WHERE id = ?`,
          args: [tournamentId],
        });
        if (tRes.rows.length === 0) {
          return {
            success: false,
            responseText: `⚠️ Turnamen dengan ID \`${tournamentId}\` tidak ditemukan.`,
          };
        }
        tournamentName = String(tRes.rows[0].name);
      } else {
        const tRes = await db.execute(`
          SELECT id, name, status
          FROM tournaments
          ORDER BY created_at DESC
          LIMIT 1
        `);
        if (tRes.rows.length === 0) {
          return {
            success: false,
            responseText: '⚠️ Belum ada turnamen yang terdaftar di sistem.',
          };
        }
        tournamentId = String(tRes.rows[0].id);
        tournamentName = String(tRes.rows[0].name);
      }

      try {
        // Pre-flight check: total teams & verified teams
        const totalTeamsRes = await db.execute({
          sql: `SELECT 
                  COUNT(*) as total_teams,
                  SUM(CASE WHEN registration_status = 'VERIFIED' THEN 1 ELSE 0 END) as verified_teams
                FROM teams 
                WHERE tournament_id = ?`,
          args: [tournamentId],
        });

        const totalTeams = Number(totalTeamsRes.rows[0]?.total_teams || 0);
        const verifiedTeams = Number(totalTeamsRes.rows[0]?.verified_teams || 0);

        if (totalTeams < 8) {
          return {
            success: false,
            responseText: `⚠️ Belum cukup tim untuk melakukan undian (minimal 8 tim).\nSaat ini baru terdaftar: *${totalTeams} / 8* tim.\nGunakan *!addteam <Nama Tim>* untuk menambah tim.`,
          };
        }

        if (verifiedTeams < totalTeams) {
          const pendingCount = totalTeams - verifiedTeams;
          return {
            success: false,
            responseText: [
              `⚠️ *ONBOARDING DELEGASI BELUM LENGKAP!*`,
              `──────────────────────────────`,
              `Sistem mendeteksi ada langkah yang terlewat:`,
              `Terdapat *${pendingCount}* dari *${totalTeams}* tim yang belum memverifikasi delegasi resminya.`,
              ``,
              `Jadwal pertandingan memerlukan nomor delegasi resmi agar bot dapat me-mention perwakilan tim saat jadwal dan peringatan batas waktu diumumkan.`,
              ``,
              `📌 *Solusi (Langkah Selanjutnya):*`,
              `Ketik *!onboarding* di grup ini sekarang untuk menghubungkan delegasi tim secara bertahap.`,
            ].join('\n'),
          };
        }

        // Prepare the draw (or resume existing draw)
        const draw = await prepareDraw(db, tournamentId, {
          groupSizing: { targetGroupSize },
        });

        if (draw.status === 'COMPLETED') {
          const groupsRes = await db.execute({
            sql: `SELECT g.group_code, t.id as team_id, t.team_name, gm.draw_position
                  FROM groups g
                  JOIN group_members gm ON g.id = gm.group_id
                  JOIN teams t ON gm.team_id = t.id
                  WHERE g.draw_id = ?
                  ORDER BY g.group_code ASC, gm.draw_position ASC`,
            args: [draw.id],
          });
          const grpMap: Record<string, { teamId: string; teamName: string }[]> = {};
          for (const r of groupsRes.rows) {
            const code = String(r.group_code);
            if (!grpMap[code]) grpMap[code] = [];
            grpMap[code].push({ teamId: String(r.team_id), teamName: String(r.team_name) });
          }
          const completedGroups: CompletedDrawGroup[] = Object.entries(grpMap).map(([k, v]) => ({
            groupCode: k,
            teams: v,
          }));
          const summary = formatDrawCompletedSummary(
            tournamentName,
            completedGroups,
            draw.commitment_hash || undefined
          );
          return {
            success: true,
            responseText: `ℹ️ Pengundian grup untuk turnamen ini sudah selesai sebelumnya.\n\n${summary}`,
          };
        }

        // Initial start announcement
        const assignment = JSON.parse(draw.result_json || '[]') as DrawResultGroupAssignment[];
        const totalTeamsInDraw = assignment.reduce((acc, g) => acc + g.teams.length, 0);

        if (deps.sender) {
          await deps.sender.sendText(
            ctx.message.chat_id,
            `🎲 *MEMULAI PENGUNDIAN GRUP — ${tournamentName.toUpperCase()}*\nTotal: ${totalTeamsInDraw} Tim\nHarap tunggu, hasil undian akan diungkap secara langsung...`
          );
        }

        // Progressive reveal loop (reveal team by team)
        while (true) {
          const step = await revealNext(db, draw.id);
          if (step.is_complete || !step.item) {
            break;
          }

          if (deps.sender) {
            const revealMsg = formatDrawRevealStep({
              tournamentTitle: tournamentName,
              stepIndex: step.revealed_count,
              totalSteps: step.total_teams,
              teamName: step.item.team_name,
              groupCode: step.item.group_code,
              seedReveal: step.seed_reveal || undefined,
            });
            await deps.sender.sendText(ctx.message.chat_id, revealMsg);
            // Pacing delay between team reveals (2500ms)
            await new Promise((r) => setTimeout(r, 2500));
          }
        }

        // Generate balanced round-robin group fixtures
        await generateGroupStageFixtures(db, tournamentId);

        // Transition tournament status to ACTIVE
        await db.execute({
          sql: `UPDATE tournaments SET status = 'ACTIVE', updated_at = ? WHERE id = ?`,
          args: [new Date().toISOString(), tournamentId],
        });

        // Send completed draw summary
        const completedGroups: CompletedDrawGroup[] = assignment.map((g) => ({
          groupCode: g.group_code,
          teams: g.teams.map((t) => ({ teamId: t.team_id, teamName: t.team_name })),
        }));
        const summaryMsg = formatDrawCompletedSummary(
          tournamentName,
          completedGroups,
          draw.commitment_hash || undefined
        );

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, summaryMsg);
        }

        // Pathway #11: Fixture Schedule Announcement
        const fixturesRes = await db.execute({
          sql: `
            SELECT 
              f.round_code, 
              g.group_code, 
              ta.team_name as team_a_name, 
              tb.team_name as team_b_name, 
              tl.team_name as host_name,
              (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = ta.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_a_address,
              (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = tb.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_b_address
            FROM fixtures f
            JOIN groups g ON f.group_id = g.id
            JOIN teams ta ON f.team_a_id = ta.id
            JOIN teams tb ON f.team_b_id = tb.id
            LEFT JOIN teams tl ON f.left_side_team_id = tl.id
            WHERE f.tournament_id = ?
            ORDER BY g.group_code ASC, f.round_code ASC
          `,
          args: [tournamentId],
        });

        const mentionsSet = new Set<string>();
        const scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r: any) => {
          const rawAddrA = r.delegate_a_address ? String(r.delegate_a_address) : null;
          const rawAddrB = r.delegate_b_address ? String(r.delegate_b_address) : null;

          let phoneA: string | null = null;
          let jidA: string | null = null;
          if (rawAddrA) {
            jidA = jidNormalizedUser(rawAddrA);
            phoneA = jidA.replace(/@.*$/, '');
            mentionsSet.add(jidA);
          }

          let phoneB: string | null = null;
          let jidB: string | null = null;
          if (rawAddrB) {
            jidB = jidNormalizedUser(rawAddrB);
            phoneB = jidB.replace(/@.*$/, '');
            mentionsSet.add(jidB);
          }

          return {
            roundCode: String(r.round_code),
            groupCode: String(r.group_code),
            teamAName: String(r.team_a_name),
            teamBName: String(r.team_b_name),
            leftSideHostName: String(r.host_name || r.team_a_name),
            teamADelegatePhone: phoneA,
            teamBDelegatePhone: phoneB,
            teamADelegateJid: jidA,
            teamBDelegateJid: jidB,
          };
        });

        const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, scheduleMsg, {
            mentions: Array.from(mentionsSet),
          });
        }

        return {
          success: true,
          responseText: deps.sender
            ? '✅ Pengundian grup dan jadwal pertandingan babak grup telah berhasil disiarkan!'
            : `${summaryMsg}\n\n${scheduleMsg}`,
        };
      } catch (err: any) {
        // FIX2-COMP-DYN: sizing failures carry actionable guidance (which team
        // counts work for the requested target size) instead of a bare error.
        const msg = err.message || String(err);
        if (msg.includes('tidak dapat dibagi menjadi kombinasi grup')) {
          const nearTargets = [targetGroupSize, targetGroupSize === 5 ? 4 : 5];
          const feasible = [8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 20, 24, 25, 28, 30, 35, 40, 45]
            .filter((n) => n % 5 === 0 || n % 4 === 0 || (n - 5) % 4 === 0 || (n - 4) % 5 === 0);
          return {
            success: false,
            responseText: [
              `⚠️ ${msg}`,
              '',
              `Dengan ukuran grup target *${targetGroupSize}* (grup ${nearTargets.join(' dan ')}), jumlah tim harus bisa dinyatakan sebagai kombinasi \`${targetGroupSize}a + ${targetGroupSize === 5 ? 4 : 5}b\`.`,
              `Contoh jumlah tim yang cocok: ${feasible.slice(0, 8).join(', ')}…`,
              '',
              'Solusi: tambah/kurangi tim ke jumlah terdekat yang cocok, atau undi ulang dengan ukuran grup lain (`!draw size=4` / `!draw size=5`).',
            ].join('\n'),
          };
        }
        return {
          success: false,
          responseText: `⚠️ Gagal menjalankan undian: ${msg}`,
        };
      }
    },
  });

  // !addteam <team_name>
  router.registerCommand({
    command: 'addteam',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan tim baru ke turnamen (Admin only)',
    handler: async (ctx: CommandContext) => {
      const teamName = ctx.rawArgs.trim();
      if (!teamName) {
        return {
          success: false,
          responseText: '⚠️ Format: *!addteam <Nama Tim>*\nContoh: `!addteam Garuda FC`',
        };
      }

      const tRes = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (tRes.rows.length === 0) {
        return {
          success: false,
          responseText: '⚠️ Belum ada turnamen yang dibuat. Buat dulu dengan *!createtournament <Nama Turnamen>*.',
        };
      }
      const tourneyId = String(tRes.rows[0].id);
      const tourneyName = String(tRes.rows[0].name);

      // Check if team with this name already exists in this tournament
      const existRes = await db.execute({
        sql: 'SELECT id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?)',
        args: [tourneyId, teamName],
      });
      if (existRes.rows.length > 0) {
        return {
          success: false,
          responseText: `⚠️ Tim *${teamName}* sudah terdaftar di turnamen *${tourneyName}*.`,
        };
      }

      const teamId = randomUUID();
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        args: [teamId, tourneyId, teamName, now, now],
      });

      const cntRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM teams WHERE tournament_id = ?',
        args: [tourneyId],
      });
      const count = Number(cntRes.rows[0].cnt);

      return {
        success: true,
        responseText: [
          `✅ Tim *${teamName}* berhasil didaftarkan ke *${tourneyName}*!`,
          `📊 Total tim terdaftar: *${count} tim*`,
          count >= 8
            ? `\n🎉 *Kuota minimal (8 tim) terpenuhi!* Panitia dapat mengetik *!onboarding* di grup ini untuk memulai verifikasi delegasi resmi masing-masing tim.`
            : `\n💡 _Tambahkan ${8 - count} tim lagi untuk memenuhi syarat minimal 8 tim sebelum pengundian grup._`,
        ].join('\n'),
      };
    },
  });

  // !teams / !tim / !peserta / !daftartim
  const handleTeams = async (_ctx: CommandContext) => {
    const tRes = await db.execute(`
      SELECT id, name, status
      FROM tournaments
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (tRes.rows.length === 0) {
      return {
        success: false,
        responseText: '⚠️ Belum ada turnamen yang dibuat di sistem.',
      };
    }
    const tourney = tRes.rows[0];
    const tourneyId = String(tourney.id);
    const tourneyName = String(tourney.name);
    const tourneyStatus = String(tourney.status);

    const teamsRes = await db.execute({
      sql: `
        SELECT t.id, t.team_name, t.registration_status,
               (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) as player_count
        FROM teams t
        WHERE t.tournament_id = ?
        ORDER BY t.created_at ASC
      `,
      args: [tourneyId],
    });

    const maxSlot = 16;
    if (teamsRes.rows.length === 0) {
      return {
        success: true,
        responseText: `📋 *DAFTAR TIM TERDAFTAR*\n🏆 Turnamen: *${tourneyName}*\n⚙️ Status: *${tourneyStatus}*\n\n_Belum ada tim yang mendaftar (0 / ${maxSlot} Tim)._\n\nKetik *!roster <Nama Tim>* untuk mendaftarkan tim pertama!`,
      };
    }

    const teamList = teamsRes.rows
      .map((row, idx) => {
        const name = String(row.team_name);
        const count = Number(row.player_count || 0);
        const status = String(row.registration_status) === 'VERIFIED' ? '✅' : '⏳';
        return `${idx + 1}. *${name}* (${count} pemain) ${status}`;
      })
      .join('\n');

    const remaining = Math.max(0, maxSlot - teamsRes.rows.length);

    return {
      success: true,
      responseText: `📋 *DAFTAR TIM TERDAFTAR*\n🏆 Turnamen: *${tourneyName}*\n📊 Total: *${teamsRes.rows.length} / ${maxSlot} Tim*\n\n${teamList}\n\n💡 _Slot tersisa: ${remaining} tim_\nKetik *!roster <Nama Tim>* untuk mendaftar.`,
    };
  };

  router.registerCommand({
    command: 'teams',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat daftar tim yang sudah terdaftar di turnamen',
    handler: handleTeams,
  });

  router.registerCommand({
    command: 'tim',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat daftar tim yang sudah terdaftar di turnamen',
    handler: handleTeams,
  });

  router.registerCommand({
    command: 'daftartim',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat daftar tim yang sudah terdaftar di turnamen',
    handler: handleTeams,
  });

  router.registerCommand({
    command: 'peserta',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat daftar tim yang sudah terdaftar di turnamen',
    handler: handleTeams,
  });

  // !status / !info / !turnamen
  const handleStatus = async (_ctx: CommandContext) => {
    const tRes = await db.execute(`
      SELECT id, name, status, created_at
      FROM tournaments
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (tRes.rows.length === 0) {
      return {
        success: false,
        responseText: '⚠️ Belum ada turnamen aktif di sistem.',
      };
    }
    const tourney = tRes.rows[0];
    const tourneyId = String(tourney.id);
    const tourneyName = String(tourney.name);
    const tourneyStatus = String(tourney.status);

    const teamsCountRes = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM teams WHERE tournament_id = ?',
      args: [tourneyId],
    });
    const totalTeams = Number(teamsCountRes.rows[0]?.c || 0);
    const maxSlot = 16;

    let statusMsg = '';
    if (tourneyStatus === 'DRAFT') {
      statusMsg = 'Pendaftaran Terbuka (REGISTRATION OPEN)';
    } else if (tourneyStatus === 'ACTIVE') {
      statusMsg = 'Turnamen Berlangsung (LIVE / ONGOING)';
    } else {
      statusMsg = tourneyStatus;
    }

    return {
      success: true,
      responseText:
        `🏆 *STATUS TURNAMEN: ${tourneyName}*\n\n` +
        `📌 *Status Saat Ini:* ${statusMsg}\n` +
        `👥 *Slot Tim Terdaftar:* ${totalTeams} / ${maxSlot} Tim\n` +
        `⚔️ *Format:* 4 Grup (Top 2 lolos ke 8 Besar Knockout)\n\n` +
        `Menu perintah yang dapat digunakan:\n` +
        `• *!teams* / *!tim* - Melihat daftar tim terdaftar\n` +
        `• *!roster* - Mendaftarkan susunan pemain tim baru\n` +
        `• *!rule* - Melihat regulasi resmi turnamen\n` +
        `• *!help* - Menampilkan daftar perintah lengkap`,
    };
  };

  router.registerCommand({
    command: 'status',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status turnamen saat ini dan jumlah tim terdaftar',
    handler: handleStatus,
  });

  router.registerCommand({
    command: 'info',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status turnamen saat ini dan jumlah tim terdaftar',
    handler: handleStatus,
  });

  router.registerCommand({
    command: 'turnamen',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status turnamen saat ini dan jumlah tim terdaftar',
    handler: handleStatus,
  });

  // !onboarding
  router.registerCommand({
    command: 'onboarding',
    requiredRole: 'ORGANIZER',
    allowedInDm: false,
    allowedInGroup: true,
    description: 'Memulai verifikasi delegasi resmi tim di grup secara bertahap (Admin only)',
    handler: async (ctx: CommandContext) => {
      const tRes = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (tRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Belum ada turnamen yang dibuat.' };
      }
      const tourneyId = String(tRes.rows[0].id);

      const promptResult = await deps.onboardingService.getNextOnboardingPrompt(tourneyId);

      if (promptResult.status === 'NO_TEAMS') {
        return {
          success: false,
          responseText: '⚠️ Belum ada tim yang didaftarkan. Gunakan *!addteam <Nama Tim>* terlebih dahulu.',
        };
      }

      if (promptResult.status === 'COMPLETED') {
        return {
          success: true,
          responseText: '✅ Seluruh tim telah memiliki delegasi terverifikasi! Turnamen siap untuk tahap *!draw*.',
        };
      }

      if (promptResult.status === 'PROMPT_READY' && promptResult.promptText && promptResult.team) {
        if (deps.sender) {
          const sentKey = await deps.sender.sendText(ctx.message.chat_id, promptResult.promptText);
          deps.onboardingService.setActivePrompt(tourneyId, promptResult.team.id, sentKey);
          return { success: true };
        } else {
          return { success: true, responseText: promptResult.promptText };
        }
      }

      return { success: false, responseText: 'Status onboarding tidak diketahui.' };
    },
  });

  // !manualreport
  router.registerCommand({
    command: 'manualreport',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membuat draf laporan pertandingan manual saat AI terkendala (Admin only)',
    handler: async (ctx: CommandContext) => {
      const trimmed = ctx.rawArgs.trim();

      // 1. Full JSON Format (No guessing needed, direct execution)
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          const fixtureId = parsed.fixture_id;
          const gameId = parsed.game_id;
          const scoreA = Number(parsed.team_a_score);
          const scoreB = Number(parsed.team_b_score);
          const notes = parsed.notes;
          const teamAPlayers: RawPlayerMatchStat[] = parsed.team_a_players || [];
          const teamBPlayers: RawPlayerMatchStat[] = parsed.team_b_players || [];

          if (!fixtureId || isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0) {
            return {
              success: false,
              responseText: '⚠️ Parameter JSON tidak valid. Pastikan fixture_id dan skor non-negatif telah diisi.',
            };
          }

          const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
          const res = await handleManualReport(db, {
            organizer_id: organizerId,
            is_organizer: true,
            fixture_id: fixtureId,
            game_id: gameId,
            team_a_score: scoreA,
            team_b_score: scoreB,
            team_a_players: teamAPlayers,
            team_b_players: teamBPlayers,
            notes,
          });

          if (!res.success || !res.version) {
            return {
              success: false,
              responseText: `⚠️ Gagal membuat draf laporan manual:\n${(res.errors || []).join('\n')}`,
            };
          }

          // Fetch team names for formatting
          const fixRes = await db.execute({
            sql: 'SELECT team_a_id, team_b_id FROM fixtures WHERE id = ?',
            args: [fixtureId],
          });
          const teamAId = String(fixRes.rows[0]?.team_a_id ?? fixRes.rows[0]?.[0]);
          const teamBId = String(fixRes.rows[0]?.team_b_id ?? fixRes.rows[0]?.[1]);

          const teamsRes = await db.execute({
            sql: 'SELECT id, team_name FROM teams WHERE id IN (?, ?)',
            args: [teamAId, teamBId],
          });
          const teamAName = String(
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.team_name ??
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.[1] ??
            'Tim A'
          );
          const teamBName = String(
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.team_name ??
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.[1] ??
            'Tim B'
          );

          const summaryText = formatMatchReportSummary({
            status: 'PENDING_APPROVAL',
            versionNumber: res.version.version_number,
            fixtureCode: fixtureId,
            teamAName,
            teamBName,
            teamAScore: scoreA,
            teamBScore: scoreB,
            teamAPlayers: teamAPlayers.map((p, idx) => ({
              ordinal: idx + 1,
              nickname: p.nickname_raw,
              rating: p.rating,
              goals: p.goals ?? 0,
              assists: p.assists ?? 0,
              passes: p.passes,
              defense: p.defense_raw,
              saves: p.goalkeeper_saves,
            })),
            teamBPlayers: teamBPlayers.map((p, idx) => ({
              ordinal: idx + 1,
              nickname: p.nickname_raw,
              rating: p.rating,
              goals: p.goals ?? 0,
              assists: p.assists ?? 0,
              passes: p.passes,
              defense: p.defense_raw,
              saves: p.goalkeeper_saves,
            })),
            pendingApprovers:
              scoreA > scoreB
                ? ['TEAM_A', 'ORGANIZER']
                : scoreB > scoreA
                ? ['TEAM_B', 'ORGANIZER']
                : ['TEAM_A', 'TEAM_B', 'ORGANIZER'],
          });

          return { success: true, responseText: summaryText };
        } catch (err: any) {
          return {
            success: false,
            responseText: `⚠️ Format JSON tidak valid: ${err.message}`,
          };
        }
      }

      // 2. Usage Guide if empty or help
      if (!trimmed || trimmed === 'help' || ctx.args.length < 2) {
        return {
          success: false,
          responseText: [
            `⚠️ *Format Perintah !manualreport (Khusus Organizer)*`,
            ``,
            `1️⃣ *Format Ringkas (Daftar Pencetak Gol):*`,
            `\`!manualreport <fixture_id> <skor_a>-<skor_b>\``,
            `\`gol A: <nama1>, <nama2>\``,
            `\`gol B: <nama3>\``,
            ``,
            `_Contoh satu baris:_`,
            `\`!manualreport fix-001 2-1 A:Bunny,Razorr B:Ikyy\``,
            ``,
            `_Contoh jumlah gol > 1:_`,
            `\`!manualreport fix-001 2-1 A:Bunny(2) B:Ikyy\``,
            ``,
            `_Catatan:_ Bot akan mencocokkan nama ke roster tim dan menampilkan ringkasan untuk Anda konfirmasi (balas *OK*) sebelum draf dibuat.`,
            ``,
            `2️⃣ *Format Tanpa Rincian Pencetak (Unassigned):*`,
            `\`!manualreport <fixture_id> <skor_a>-<skor_b> [catatan]\``,
            `_Gol dicatat sebagai belum ditugaskan dan harus dilengkapi via koreksi sebelum !approve._`,
            ``,
            `3️⃣ *Format JSON Lengkap:*`,
            `\`!manualreport {"fixture_id":"fix-001","team_a_score":2,"team_b_score":1,"team_a_players":[...],"team_b_players":[...]}\``,
          ].join('\n'),
        };
      }

      // 3. Quick Format Parsing
      const parsed = parseQuickReport(trimmed);
      if (!parsed.success || !parsed.data) {
        return {
          success: false,
          responseText: `⚠️ ${parsed.error || 'Format tidak valid.'}`,
        };
      }

      const { fixtureId, scoreA, scoreB, rawScorersA, rawScorersB, notes, hasExplicitScorers } = parsed.data;

      // Look up fixture
      const fixtureRes = await db.execute({
        sql: 'SELECT id, tournament_id, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
        args: [fixtureId],
      });
      if (fixtureRes.rows.length === 0) {
        return { success: false, responseText: `⚠️ Fixture tidak ditemukan: ${fixtureId}` };
      }
      const fixtureRow = fixtureRes.rows[0];
      const teamAId = String(fixtureRow.team_a_id ?? fixtureRow[2]);
      const teamBId = String(fixtureRow.team_b_id ?? fixtureRow[3]);

      // Fetch team names
      const teamsRes = await db.execute({
        sql: 'SELECT id, team_name FROM teams WHERE id IN (?, ?)',
        args: [teamAId, teamBId],
      });
      const teamAName = String(
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.team_name ??
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.[1] ??
        'Tim A'
      );
      const teamBName = String(
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.team_name ??
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.[1] ??
        'Tim B'
      );

      // Fetch active registered rosters
      const playersRes = await db.execute({
        sql: `
          SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key,
                 position, roster_slot, roster_type, status
          FROM players
          WHERE team_id IN (?, ?) AND status = 'ACTIVE'
          ORDER BY roster_slot ASC
        `,
        args: [teamAId, teamBId],
      });

      const rosterA: Player[] = playersRes.rows
        .filter((r) => String(r.team_id ?? r[2]) === teamAId)
        .map((r) => ({
          id: String(r.id ?? r[0]),
          tournament_id: String(r.tournament_id ?? r[1]),
          team_id: teamAId,
          nickname_raw: String(r.nickname_raw ?? r[3]),
          nickname_nfc: String(r.nickname_nfc ?? r[4]),
          nickname_search_key: String(r.nickname_search_key ?? r[5]),
          position: String(r.position ?? r[6]) as Player['position'],
          roster_slot: Number(r.roster_slot ?? r[7]),
          roster_type: String(r.roster_type ?? r[8]) as Player['roster_type'],
          status: String(r.status ?? r[9]) as Player['status'],
          created_at: '',
          updated_at: '',
        }));

      const rosterB: Player[] = playersRes.rows
        .filter((r) => String(r.team_id ?? r[2]) === teamBId)
        .map((r) => ({
          id: String(r.id ?? r[0]),
          tournament_id: String(r.tournament_id ?? r[1]),
          team_id: teamBId,
          nickname_raw: String(r.nickname_raw ?? r[3]),
          nickname_nfc: String(r.nickname_nfc ?? r[4]),
          nickname_search_key: String(r.nickname_search_key ?? r[5]),
          position: String(r.position ?? r[6]) as Player['position'],
          roster_slot: Number(r.roster_slot ?? r[7]),
          roster_type: String(r.roster_type ?? r[8]) as Player['roster_type'],
          status: String(r.status ?? r[9]) as Player['status'],
          created_at: '',
          updated_at: '',
        }));

      if (rosterA.length < 5 || rosterB.length < 5) {
        return {
          success: false,
          responseText: `⚠️ Salah satu tim belum memiliki 5 pemain terdaftar aktif (1 GK, 4 outfield). ${teamAName}: ${rosterA.length}, ${teamBName}: ${rosterB.length}.`,
        };
      }

      let matchedA: MatchedScorerDetail[] = [];
      let matchedB: MatchedScorerDetail[] = [];
      let unassignedA = 0;
      let unassignedB = 0;
      let teamAPlayers: RawPlayerMatchStat[] = [];
      let teamBPlayers: RawPlayerMatchStat[] = [];

      if (hasExplicitScorers) {
        // Validate scorer goal sums against reported scores
        const totalA = rawScorersA.reduce((sum, s) => sum + s.goals, 0);
        const totalB = rawScorersB.reduce((sum, s) => sum + s.goals, 0);

        if (totalA !== scoreA) {
          const diff = Math.abs(totalA - scoreA);
          return {
            success: false,
            responseText: `⚠️ Jumlah gol di daftar pencetak ${teamAName} (${totalA}) tidak cocok dengan skor tim (${scoreA}). Selisih: ${diff} gol. Mohon lengkapi.`,
          };
        }
        if (totalB !== scoreB) {
          const diff = Math.abs(totalB - scoreB);
          return {
            success: false,
            responseText: `⚠️ Jumlah gol di daftar pencetak ${teamBName} (${totalB}) tidak cocok dengan skor tim (${scoreB}). Selisih: ${diff} gol. Mohon lengkapi.`,
          };
        }

        // Fuzzy match scorers for Team A
        for (const item of rawScorersA) {
          const matchRes = matchScorerToRoster(item.name, rosterA);
          if (!matchRes.player) {
            return {
              success: false,
              responseText: `⚠️ ${matchRes.error || `Pencetak "${item.name}" tidak ditemukan di roster ${teamAName}.`}`,
            };
          }
          matchedA.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }

        // Fuzzy match scorers for Team B
        for (const item of rawScorersB) {
          const matchRes = matchScorerToRoster(item.name, rosterB);
          if (!matchRes.player) {
            return {
              success: false,
              responseText: `⚠️ ${matchRes.error || `Pencetak "${item.name}" tidak ditemukan di roster ${teamBName}.`}`,
            };
          }
          matchedB.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }

        const lineupA = buildLineupWithScorers(rosterA, matchedA, scoreB, false);
        if (lineupA.error) return { success: false, responseText: `⚠️ ${lineupA.error}` };
        teamAPlayers = lineupA.lineup;

        const lineupB = buildLineupWithScorers(rosterB, matchedB, scoreA, false);
        if (lineupB.error) return { success: false, responseText: `⚠️ ${lineupB.error}` };
        teamBPlayers = lineupB.lineup;
      } else {
        // Fallback case: no scorers provided at all
        unassignedA = scoreA;
        unassignedB = scoreB;

        const lineupA = buildLineupWithScorers(rosterA, [], scoreB, true);
        if (lineupA.error) return { success: false, responseText: `⚠️ ${lineupA.error}` };
        teamAPlayers = lineupA.lineup;

        const lineupB = buildLineupWithScorers(rosterB, [], scoreA, true);
        if (lineupB.error) return { success: false, responseText: `⚠️ ${lineupB.error}` };
        teamBPlayers = lineupB.lineup;
      }

      // Stage in pending confirmation session (DO NOT create draft report yet!)
      const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
      const pending: PendingManualReport = {
        fixtureId,
        scoreA,
        scoreB,
        teamAId,
        teamBId,
        teamAName,
        teamBName,
        teamAPlayers,
        teamBPlayers,
        rosterA,
        rosterB,
        matchedDetailsA: matchedA,
        matchedDetailsB: matchedB,
        unassignedGoalsA: unassignedA,
        unassignedGoalsB: unassignedB,
        notes,
        organizerId,
        chatId: ctx.message.chat_id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      deps.manualReportSession.stagePendingReport(pending);
      const confirmationPrompt = deps.manualReportSession.formatConfirmationPrompt(pending);

      return {
        success: true,
        responseText: confirmationPrompt,
      };
    },
  });

  // !confirm / !ok
  const confirmHandler = async (ctx: CommandContext) => {
    const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';

    // 1. Check WO Claim Pending first
    if (deps.woClaimSession?.hasPending(ctx.message.chat_id)) {
      const woRes = await deps.woClaimSession.confirmPending(
        db,
        ctx.message.chat_id,
        organizerId
      );
      if (!woRes.success) {
        return { success: false, responseText: woRes.error };
      }
      return { success: true, responseText: woRes.replyText };
    }

    // 2. Check Manual Report Pending
    const confirmRes = await deps.manualReportSession.confirmPending(
      db,
      ctx.message.chat_id,
      organizerId
    );
    if (!confirmRes.success) {
      return { success: false, responseText: confirmRes.error };
    }
    return { success: true, responseText: confirmRes.replyText };
  };

  // !batal / !reject / !tolak
  const cancelHandler = async (ctx: CommandContext) => {
    if (deps.woClaimSession?.hasPending(ctx.message.chat_id)) {
      const rejectRes = deps.woClaimSession.rejectPending(ctx.message.chat_id);
      return { success: true, responseText: rejectRes.replyText };
    }
    if (deps.manualReportSession.hasPending(ctx.message.chat_id)) {
      deps.manualReportSession.clearPending(ctx.message.chat_id);
      return { success: true, responseText: '❌ Draf laporan pertandingan manual telah dibatalkan oleh Admin.' };
    }
    return {
      success: false,
      responseText: '⚠️ Tidak ada pengajuan klaim WO atau draf manual yang sedang menunggu konfirmasi.',
    };
  };

  router.registerCommand({
    command: 'confirm',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi klaim WO atau draf laporan manual (Admin only)',
    handler: confirmHandler,
  });

  router.registerCommand({
    command: 'ok',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi klaim WO atau draf laporan manual (Admin only)',
    handler: confirmHandler,
  });

  router.registerCommand({
    command: 'batal',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  router.registerCommand({
    command: 'reject',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  router.registerCommand({
    command: 'tolak',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  // !matchday / !ronde
  router.registerCommand({
    command: 'matchday',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status ronde, batas waktu 19:59 WIB, dan sisa pertandingan',
    handler: async (ctx: CommandContext) => {
      if (!deps.matchdayService) {
        return { success: false, responseText: '⚠️ Layanan matchday belum diaktifkan.' };
      }

      if (ctx.args[0]?.toLowerCase() === 'cutoff') {
        if (!ctx.isOrganizer) {
          return { success: false, responseText: '⚠️ Hanya panitia yang dapat memicu cutoff matchday manual.' };
        }
        const cutoffRes = await deps.matchdayService.processDailyCutoff(true);
        if (!cutoffRes.announcementText) {
          return {
            success: true,
            responseText: '✅ Evaluasi cutoff selesai. Seluruh pertandingan pada ronde aktif telah diselesaikan sebelumnya.',
          };
        }
        return {
          success: true,
          responseText: cutoffRes.announcementText,
          metadata: { mentions: cutoffRes.mentions },
        };
      }

      const statusText = await deps.matchdayService.formatMatchdayStatus();
      return { success: true, responseText: statusText };
    },
  });

  router.registerCommand({
    command: 'ronde',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status ronde, batas waktu 19:59 WIB, dan sisa pertandingan',
    handler: async (_ctx: CommandContext) => {
      if (!deps.matchdayService) {
        return { success: false, responseText: '⚠️ Layanan matchday belum diaktifkan.' };
      }
      const statusText = await deps.matchdayService.formatMatchdayStatus();
      return { success: true, responseText: statusText };
    },
  });

  // !rule / !rules / !regulasi
  const ruleHandler = async () => {
    let tournamentTitle = 'GOJIHA TURNAMEN';
    try {
      const tRes = await db.execute("SELECT name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
      if (tRes.rows.length > 0 && tRes.rows[0].name) {
        tournamentTitle = String(tRes.rows[0].name).toUpperCase();
      }
    } catch {}

    return {
      success: true,
      responseText: [
        `📜 *REGULASI RESMI TURNAMEN FLASH PEAK — ${tournamentTitle}*`,
        `──────────────────────────────`,
        `1. 👥 *Tim & Roster:*`,
        `   • Format 5 vs 5 (1 Kiper + 4 Pemain Inti).`,
        `   • Cadangan: Maksimal 3 pemain cadangan (Format 5+3, total max 8 pemain). Tim dengan hanya 5 pemain tanpa cadangan tetap diizinkan.`,
        `   • 🚫 *Karakter Unik (No Duplicate):* DILARANG menggunakan karakter yang sama dalam 1 tim (contoh: Dilarang double Ford, double Moco, dll). Setiap pemain wajib memakai karakter berbeda!`,
        `   • 1 Pemain hanya boleh terdaftar & membela 1 tim di turnamen.`,
        `   • Nickname in-game WAJIB sama persis dengan yang didaftarkan.`,
        `   • 🔄 *Pergantian Nickname (Change Name / CN):* WAJIB lapor dan konfirmasi ke Panitia (Arya) terlebih dahulu agar disesuaikan di database sebelum laga berikutnya.`,
        `   • Format pendaftaran roster (bisa format baku atau chat santai):`,
        `     *!roster <Nama Tim> GK: [Nama GK] | Inti: [P1, P2, P3, P4] | Cadangan: [C1, C2]*`,
        ``,
        `2. 🏆 *Format Kompetisi:*`,
        `   • *Babak Grup:* Single Round-Robin (1 leg, durasi laga 8 menit).`,
        `   • *Poin Grup:* Menang = 3 poin | Seri Sah = 1 poin | Kalah = 0 poin.`,
        `   • *Tie-Breaker Grup:* 1. Poin ➔ 2. Selisih Gol ➔ 3. Gol Dicetak ➔ 4. Head-to-Head.`,
        `   • Top 2 tim teratas tiap grup lolos ke Fase Knockout.`,
        `   • *Fase Knockout:* Best of 3 (BO3, first to 2 wins). Grand Final: Best of 5 (BO5, first to 3 wins).`,
        `   • Tidak ada hasil seri di fase gugur; laga seri in-game langsung di-replay.`,
        ``,
        `3. ⏰ *Jadwal & Batasan Waktu (19:59 WIB):*`,
        `   • Setiap ronde/matchday berdurasi 24 jam, dimulai & berakhir pukul *19:59 WIB*.`,
        `   • Toleransi keterlambatan (*grace period*): 10 menit dari waktu kickoff/janjian.`,
        `   • Pengingat otomatis dikirim pada pukul 17:00 WIB dan 18:59 WIB.`,
        ``,
        `4. 🏠 *Host Room & Room Card:*`,
        `   • Tim sebelah kiri pada jadwal (*!schedule*) bertindak sebagai Host Room default.`,
        `   • Jika host tidak memiliki room card, tim lawan dapat berinisiatif menjadi host.`,
        `   • Jika lawan menolak menjadi pengganti host, lawan berhak klaim kemenangan WO.`,
        `   • Jika KEDUA tim sama-sama tidak dapat menyediakan room: Double WO (0 poin).`,
        ``,
        `5. ❌ *Walkover (WO) & Forfeit (D-031):*`,
        `   • *WO Tunggal:* Lawan terlambat >10 menit atau menolak bikin room. Pemenang dapat skor 3–0 (+3 poin).`,
        `   • *Double WO:* Kedua tim tidak bermain hingga pukul 19:59 WIB. Skor 0–0 dan *keduanya mendapat 0 poin*.`,
        `   • Klaim WO wajib menyertakan alasan jelas dan disahkan Panitia melalui *!ok*.`,
        ``,
        `6. 📸 *Pelaporan Skor & Bukti Pertandingan:*`,
        `   • Delegasi tim pemenang CUKUP mengirim *1 screenshot scoreboard utama* hasil akhir pertandingan (menampilkan skor dan statistik pemain).`,
        `   • 🧤 *Status Kiper:* Kewajiban mengirim kartu statistik Kiper DITANGGUHKAN sementara demi kemudahan dan kecepatan pelaporan.`,
        `   • 🏅 *Penghargaan Individu:* Penghargaan Best Goalkeeper ditangguhkan sementara season ini. Penghargaan aktif: *Golden Boot* (Top Scorer), *Top Assist*, dan *Best Defender*.`,
        `   • Laporan skor diverifikasi oleh kedua delegasi dan disahkan oleh Panitia turnamen.`,
        `──────────────────────────────`,
        `💡 _Ketik *!schedule* untuk jadwal tanding, *!standings* untuk klasemen, atau *!awards* untuk daftar topskor._`,
      ].join('\n'),
    };
  };

  router.registerCommand({
    command: 'rule',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  router.registerCommand({
    command: 'rules',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  router.registerCommand({
    command: 'regulasi',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  // !roster [Nama Tim] [GK: ... | Inti: ... | Cadangan: ...]
  const rosterHandler = async (ctx: CommandContext) => {
    const raw = ctx.rawArgs.trim();

    // Check active tournament
    const tRes = await db.execute("SELECT id, name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
    if (tRes.rows.length === 0) {
      return { success: false, responseText: '⚠️ Belum ada turnamen aktif.' };
    }
    const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
    const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

    if (!raw) {
      return {
        success: true,
        responseText: [
          `📋 *PANDUAN PERINTAH ROSTER (FORMAT 5+3)*`,
          `──────────────────────────────`,
          `1. *Melihat Roster Tim:*`,
          `   \`!roster <Nama Tim>\``,
          `   Contoh: \`!roster Garuda FC\``,
          ``,
          `2. *Mendaftarkan / Memperbarui Roster:*`,
          `   Bisa menggunakan format baku maupun bahasa santai/chat WhatsApp.`,
          `   • *Format Baku:*`,
          `     \`!roster Garuda FC GK: Ikyy | Inti: Budi, Joko, Doni, Reza | Cadangan: Rian, Kevin\``,
          `   • *Format Bahasa Santai:*`,
          `     \`!roster tim Garuda FC kipernya Ikyy, pemain intinya Budi, Joko, Doni, Reza, cadangannya Rian, Kevin\``,
          `──────────────────────────────`,
          `💡 _Minimal 5 pemain (1 GK + 4 Inti). Maksimal 3 cadangan (Total max 8 pemain)._`,
          `🚫 *Aturan Karakter:* Dilarang menggunakan karakter kembar dalam 1 tim saat tanding (misal: dilarang double Ford).`,
        ].join('\n'),
      };
    }

    let parsed: {
      isRegistration: boolean;
      teamName?: string;
      gkName?: string;
      starterList: string[];
      subList: string[];
    };

    if (deps.rosterExtractor) {
      try {
        const aiExtracted = await deps.rosterExtractor.extract(raw);
        if (aiExtracted.gk_name || (aiExtracted.starter_list && aiExtracted.starter_list.length > 0)) {
          parsed = {
            isRegistration: true,
            teamName: aiExtracted.team_name || undefined,
            gkName: aiExtracted.gk_name || undefined,
            starterList: aiExtracted.starter_list || [],
            subList: aiExtracted.sub_list || [],
          };
        } else {
          // If AI extraction did not detect registration players, check deterministic parser
          const det = parseRosterInput(raw);
          if (det.isRegistration) {
            parsed = det;
          } else {
            parsed = {
              isRegistration: false,
              teamName: aiExtracted.team_name || undefined,
              gkName: undefined,
              starterList: [],
              subList: [],
            };
          }
        }
      } catch (err) {
        console.warn('[Roster] AI extractor failed, falling back to deterministic parser:', err);
        parsed = parseRosterInput(raw);
      }
    } else {
      parsed = parseRosterInput(raw);
    }

    if (!parsed.isRegistration) {
      // VIEW ROSTER
      // FIX-ROSTER-VIEW (21 Nov 2026): exact-match-first, fallback strip prefix.
      // Bug lama: regex strip 'Team ' dari 'Team Zodiac' → cari 'zodiac' → 0 rows.
      // Sekarang: coba exact match dulu; kalau gagal baru strip prefix umum.
      const rawTeamInput = (parsed.teamName || raw).trim();
      const stripPrefix = (s: string) => s.replace(/^(?:tim|team|lihat|cek)\s+/i, '').trim();
      let teamRes = await db.execute({
        sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?) LIMIT 1`,
        args: [tournamentId, rawTeamInput],
      });
      let targetTeamName = rawTeamInput;
      if (teamRes.rows.length === 0) {
        const stripped = stripPrefix(rawTeamInput);
        if (stripped !== rawTeamInput) {
          teamRes = await db.execute({
            sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?) LIMIT 1`,
            args: [tournamentId, stripped],
          });
          targetTeamName = stripped;
        }
      }
      // Also try LIKE fallback for fuzzy match (e.g. 'zodiac' → 'Team Zodiac')
      if (teamRes.rows.length === 0) {
        teamRes = await db.execute({
          sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND LOWER(team_name) LIKE LOWER(?) ORDER BY LENGTH(team_name) ASC LIMIT 1`,
          args: [tournamentId, `%${rawTeamInput}%`],
        });
        targetTeamName = rawTeamInput;
      }

      if (teamRes.rows.length === 0) {
        return {
          success: false,
          responseText: `⚠️ Tim *${rawTeamInput}* tidak ditemukan di turnamen *${tournamentName}*.`,
        };
      }

      const teamId = String(teamRes.rows[0].id ?? teamRes.rows[0][0]);
      const officialTeamName = String(teamRes.rows[0].team_name ?? teamRes.rows[0][1]);

      const playersRes = await db.execute({
        sql: `SELECT nickname_raw, position, roster_slot, roster_type
              FROM players
              WHERE team_id = ? AND tournament_id = ? AND status = 'ACTIVE'
              ORDER BY roster_slot ASC`,
        args: [teamId, tournamentId],
      });

      if (playersRes.rows.length === 0) {
        return {
          success: true,
          responseText: [
            `📋 *ROSTER TIM: ${officialTeamName.toUpperCase()}*`,
            `──────────────────────────────`,
            `⚠️ Belum ada pemain yang didaftarkan untuk tim ini.`,
            ``,
            `*Format Pendaftaran:*`,
            `\`!roster ${officialTeamName} GK: [Nama GK] | Inti: [P1, P2, P3, P4] | Cadangan: [C1, C2]\``,
          ].join('\n'),
        };
      }

      const gk = playersRes.rows.find((r: any) => String(r.position) === 'GOALKEEPER' || Number(r.roster_slot) === 1);
      const starters = playersRes.rows.filter((r: any) => String(r.roster_type) === 'STARTER' && String(r.position) !== 'GOALKEEPER');
      const subs = playersRes.rows.filter((r: any) => String(r.roster_type) === 'SUBSTITUTE');

      const lines: string[] = [];
      lines.push(`📋 *ROSTER RESMI TIM: ${officialTeamName.toUpperCase()}*`);
      lines.push(`──────────────────────────────`);
      lines.push(`🧤 *Kiper (Slot 1):* ${gk ? String(gk.nickname_raw) : '-(belum ada)-'}`);
      lines.push(`🏃 *Pemain Inti (Slot 2–5):*`);
      if (starters.length === 0) {
        lines.push(`  _(belum ada)_`);
      } else {
        starters.forEach((s: any, idx: number) => {
          lines.push(`  ${idx + 2}. ${String(s.nickname_raw)}`);
        });
      }

      lines.push(`🪑 *Pemain Cadangan (Slot 6–8):*`);
      if (subs.length === 0) {
        lines.push(`  _(tidak ada cadangan)_`);
      } else {
        subs.forEach((s: any, idx: number) => {
          lines.push(`  ${idx + 6}. ${String(s.nickname_raw)}`);
        });
      }
      lines.push(`──────────────────────────────`);
      lines.push(`📊 Total: *${playersRes.rows.length} / 8* pemain terdaftar (Format 5+3).`);

      return { success: true, responseText: lines.join('\n') };
    }

    // REGISTER / UPDATE ROSTER
    let teamId: string | null = null;
    let officialTeamName: string | null = null;
    let officialDelegateId: string | null = null;

    // Resolve sender's delegate ID if not already available in ctx
    let currentDelegateId = ctx.delegateId;
    if (!currentDelegateId && ctx.message?.sender_raw_address) {
      try {
        const res = await deps.identityResolver.resolveIdentity(
          ctx.message.sender_raw_address,
          ctx.message.chat_id
        );
        if (res.status === 'VERIFIED' && res.delegate) {
          currentDelegateId = res.delegate.id;
          ctx.delegateId = res.delegate.id;
        }
      } catch (resErr) {
        console.warn('[Roster] Identity resolve error:', resErr);
      }
    }

    if (parsed.teamName) {
      const teamRes = await db.execute({
        sql: `SELECT id, team_name, delegate_id FROM teams 
              WHERE tournament_id = ? AND (LOWER(team_name) = LOWER(?) OR LOWER(team_name) LIKE ?)
              ORDER BY CASE WHEN LOWER(team_name) = LOWER(?) THEN 0 ELSE 1 END LIMIT 1`,
        args: [tournamentId, parsed.teamName, `%${parsed.teamName.toLowerCase()}%`, parsed.teamName],
      });
      if (teamRes.rows.length > 0) {
        teamId = String(teamRes.rows[0].id ?? teamRes.rows[0][0]);
        officialTeamName = String(teamRes.rows[0].team_name ?? teamRes.rows[0][1]);
        officialDelegateId = teamRes.rows[0].delegate_id ? String(teamRes.rows[0].delegate_id) : null;
      }
    }

    // If team name was omitted or not matched by text, try resolving from sender's delegate ID
    if (!teamId && currentDelegateId) {
      const delTeamRes = await db.execute({
        sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND delegate_id = ? LIMIT 1`,
        args: [tournamentId, currentDelegateId],
      });
      if (delTeamRes.rows.length > 0) {
        teamId = String(delTeamRes.rows[0].id ?? delTeamRes.rows[0][0]);
        officialTeamName = String(delTeamRes.rows[0].team_name ?? delTeamRes.rows[0][1]);
        officialDelegateId = delTeamRes.rows[0].delegate_id ? String(delTeamRes.rows[0].delegate_id) : null;
      }
    }

    if (!teamId || !officialTeamName) {
      // Auto-create team if registering during DRAFT status
      const tStatusRes = await db.execute({
        sql: 'SELECT status FROM tournaments WHERE id = ?',
        args: [tournamentId],
      });
      const currentTourneyStatus = String(tStatusRes.rows[0]?.status || 'DRAFT');

      if (parsed.teamName && currentTourneyStatus === 'DRAFT') {
        const countRes = await db.execute({
          sql: 'SELECT COUNT(*) as c FROM teams WHERE tournament_id = ?',
          args: [tournamentId],
        });
        const currentTeamCount = Number(countRes.rows[0]?.c || 0);
        if (currentTeamCount >= 16) {
          return {
            success: false,
            responseText: '⚠️ Pendaftaran ditutup. Kuota 16 tim sudah penuh!',
          };
        }

        const newTeamId = randomUUID();
        const cleanName = parsed.teamName.trim();
        const nowIso = new Date().toISOString();

        await db.execute({
          sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
                VALUES (?, ?, ?, 'PENDING', ?, ?)`,
          args: [newTeamId, tournamentId, cleanName, nowIso, nowIso],
        });

        teamId = newTeamId;
        officialTeamName = cleanName;

        // Auto-bind sender as official delegate
        let delId = currentDelegateId;
        if (!delId && ctx.message?.sender_raw_address) {
          try {
            const rawAddr = ctx.message.sender_raw_address;
            const addrType = rawAddr.includes('@lid') ? 'LID' : 'PHONE';
            const displayName = `Delegasi ${cleanName}`;
            const { delegate } = await deps.identityResolver.createDelegateWithIdentity(
              displayName,
              rawAddr,
              addrType as any,
              { sourceChatId: ctx.message.chat_id }
            );
            delId = delegate.id;
          } catch (delErr) {
            console.warn('[Roster] Auto-delegate creation error:', delErr);
          }
        }

        if (delId) {
          try {
            await deps.identityResolver.bindDelegateToTeam(newTeamId, delId);
            officialDelegateId = delId;
            currentDelegateId = delId;
            ctx.delegateId = delId;
          } catch (bindErr) {
            console.warn('[Roster] Auto-delegate bind error:', bindErr);
          }
        }
      } else {
        return {
          success: false,
          responseText: `⚠️ Tim tidak ditemukan di turnamen *${tournamentName}*.\nMohon cantumkan nama tim Anda di awal, contoh:\n\`!roster <Nama Tim> Kiper: ... | Inti: ... | Cadangan: ...\``,
        };
      }
    }

    // Auto-bind delegate to existing team if team has no delegate yet
    if (teamId && !officialDelegateId) {
      let delId = currentDelegateId;
      if (!delId && ctx.message?.sender_raw_address) {
        try {
          const rawAddr = ctx.message.sender_raw_address;
          const addrType = rawAddr.includes('@lid') ? 'LID' : 'PHONE';
          const displayName = `Delegasi ${officialTeamName}`;
          const { delegate } = await deps.identityResolver.createDelegateWithIdentity(
            displayName,
            rawAddr,
            addrType as any,
            { sourceChatId: ctx.message.chat_id }
          );
          delId = delegate.id;
        } catch (delErr) {
          console.warn('[Roster] Auto-delegate creation error:', delErr);
        }
      }

      if (delId) {
        try {
          await deps.identityResolver.bindDelegateToTeam(teamId, delId);
          officialDelegateId = delId;
          currentDelegateId = delId;
          ctx.delegateId = delId;
        } catch (bindErr) {
          console.warn('[Roster] Auto-delegate bind error:', bindErr);
        }
      }
    }

    // Authorization: must be Organizer OR team delegate
    if (!ctx.isOrganizer && (!currentDelegateId || currentDelegateId !== officialDelegateId)) {
      return {
        success: false,
        responseText: `⛔ Hanya Panitia atau delegasi resmi dari *${officialTeamName}* yang berhak mendaftarkan roster tim ini.`,
      };
    }

    if (!parsed.gkName) {
      return {
        success: false,
        responseText: '⚠️ Nama Kiper (GK) wajib diisi. Contoh: `GK: Ikyy` atau `Kiper: Ikyy`',
      };
    }

    if (parsed.starterList.length < 4) {
      return {
        success: false,
        responseText: `⚠️ Pemain inti harus minimal 4 pemain outfield (saat ini terdeteksi: ${parsed.starterList.length}).\nContoh: \`Inti: Budi, Joko, Doni, Reza\``,
      };
    }

    if (parsed.starterList.length > 4) {
      // Move excess starters to subs if space permits
      const excess = parsed.starterList.splice(4);
      parsed.subList.unshift(...excess);
    }

    if (parsed.subList.length > 3) {
      return {
        success: false,
        responseText: `⚠️ Pendaftaran ditolak karena kelebihan pemain! Maksimal pemain cadangan adalah 3 orang (Format 5+3: 1 Kiper, 4 Inti, maks 3 Cadangan). Anda memasukkan ${parsed.subList.length} cadangan.`,
      };
    }

    // Validate total players does not exceed 8
    const allNames = [parsed.gkName, ...parsed.starterList, ...parsed.subList];
    if (allNames.length > 8) {
      return {
        success: false,
        responseText: `⚠️ Pendaftaran ditolak karena kelebihan pemain! Format turnamen adalah 5+3 (total maksimal 8 pemain: 1 Kiper, 4 Inti, maks 3 Cadangan). Anda memasukkan ${allNames.length} pemain.`,
      };
    }
    const normalizedMap = new Set<string>();
    for (const n of allNames) {
      const normN = n.toLowerCase().trim();
      if (normalizedMap.has(normN)) {
        return {
          success: false,
          responseText: `⚠️ Ditemukan nama ganda di dalam roster: *"${n}"*. Setiap pemain harus memiliki nickname unik.`,
        };
      }
      normalizedMap.add(normN);
    }

    // Validate no player is registered in another team in this tournament (Rule 2.7)
    for (const n of allNames) {
      const existCheck = await db.execute({
        sql: `SELECT t.team_name FROM players p JOIN teams t ON p.team_id = t.id WHERE p.tournament_id = ? AND p.team_id != ? AND LOWER(p.nickname_raw) = LOWER(?) LIMIT 1`,
        args: [tournamentId, teamId, n],
      });
      if (existCheck.rows.length > 0) {
        const registeredTeam = String(existCheck.rows[0].team_name ?? existCheck.rows[0][0]);
        return {
          success: false,
          responseText: `⚠️ Pemain *"${n}"* sudah terdaftar di tim *${registeredTeam}*. Sesuai regulasi (Pasal 2.7), 1 pemain hanya boleh membela 1 tim di turnamen.`,
        };
      }
    }

    // Save into players table
    // 1. Delete previous players for this team in this tournament
    await db.execute({
      sql: `DELETE FROM players WHERE team_id = ? AND tournament_id = ?`,
      args: [teamId, tournamentId],
    });

    const now = new Date().toISOString();

    // Slot 1: GK
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [
        randomUUID(),
        tournamentId,
        teamId,
        parsed.gkName,
        parsed.gkName.normalize('NFC'),
        parsed.gkName.toLowerCase().replace(/[^a-z0-9]/g, ''),
        now,
        now,
      ],
    });

    // Slot 2-5: Starters
    for (let i = 0; i < parsed.starterList.length; i++) {
      const pName = parsed.starterList[i];
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          randomUUID(),
          tournamentId,
          teamId,
          pName,
          pName.normalize('NFC'),
          pName.toLowerCase().replace(/[^a-z0-9]/g, ''),
          i + 2,
          now,
          now,
        ],
      });
    }

    // Slot 6-8: Substitutes
    for (let i = 0; i < parsed.subList.length; i++) {
      const sName = parsed.subList[i];
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'SUBSTITUTE', 'ACTIVE', ?, ?)`,
        args: [
          randomUUID(),
          tournamentId,
          teamId,
          sName,
          sName.normalize('NFC'),
          sName.toLowerCase().replace(/[^a-z0-9]/g, ''),
          i + 6,
          now,
          now,
        ],
      });
    }

    const lines: string[] = [];
    lines.push(`✅ *ROSTER TIM ${officialTeamName.toUpperCase()} BERHASIL DIDAFTARKAN!*`);
    lines.push(`──────────────────────────────`);
    lines.push(`🧤 *Kiper (Slot 1):* ${parsed.gkName}`);
    lines.push(`🏃 *Pemain Inti (Slot 2–5):*`);
    parsed.starterList.forEach((s, idx) => lines.push(`  ${idx + 2}. ${s}`));
    lines.push(`🪑 *Pemain Cadangan (Slot 6–8):*`);
    if (parsed.subList.length === 0) {
      lines.push(`  _(tidak ada cadangan)_`);
    } else {
      parsed.subList.forEach((s, idx) => lines.push(`  ${idx + 6}. ${s}`));
    }
    lines.push(`──────────────────────────────`);
    lines.push(`📊 Total Terdaftar: *${allNames.length} / 8* pemain (Format 5+3).`);
    lines.push(`🚫 *Aturan Karakter Unik:* Dilarang menggunakan karakter yang sama dalam 1 tim saat tanding (contoh: dilarang double Ford, double Moco, dll).`);
    lines.push(`💡 _Nickname di atas harus sama persis dengan yang digunakan di dalam game._`);

    return { success: true, responseText: lines.join('\n') };
  };

  router.registerCommand({
    command: 'roster',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan atau melihat roster pemain tim (Format 5+3: 1 GK, 4 Inti, max 3 Cadangan)',
    handler: rosterHandler,
  });

  router.registerCommand({
    command: 'daftarroster',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan roster pemain tim',
    handler: rosterHandler,
  });

  router.registerCommand({
    command: 'daftarpemain',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan roster pemain tim',
    handler: rosterHandler,
  });

  // !roomcard / !karturoom / !hostroom <fixture_id> [ok|ganti|tolak|habis]
  const roomCardHandler = async (ctx: CommandContext) => {
    const parts = ctx.args;
    if (parts.length === 0) {
      return {
        success: false,
        responseText: [
          `⚠️ *FORMAT PERINTAH KARTU ROOM:*`,
          `\`!roomcard <id_pertandingan> [status]\``,
          ``,
          `*Pilihan Status:*`,
          `• \`ok\` : Tuan rumah (tim kiri) siap membuat room.`,
          `• \`ganti\` : Tuan rumah kiri tidak ada room, lawan bersedia jadi host pengganti.`,
          `• \`tolak\` : Tuan rumah kiri tidak ada room, lawan menolak menggantikan (lawan menang WO).`,
          `• \`habis\` : Kedua tim tidak memiliki kartu room (Grup = WO Ganda 0 poin, Knockout = Wajib Reschedule).`,
          ``,
          `Contoh:`,
          `\`!roomcard 1 ok\``,
          `\`!roomcard 1 ganti\``,
          `\`!roomcard 1 habis\``,
        ].join('\n'),
      };
    }

    const fixtureInput = parts[0].trim();
    const statusAction = (parts[1] || '').trim().toLowerCase();

    // Query fixture: exact ID match only (FIX2-LOOKUP-001) — prefix LIKE
    // matching previously made short inputs ambiguously resolve to an
    // arbitrary fixture whose ID happens to share the prefix.
    const fRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.team_a_id, f.team_b_id,
               f.left_side_team_id, f.host_team_id, f.host_assignment_reason, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name, t.name as tournament_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        JOIN tournaments t ON f.tournament_id = t.id
        WHERE f.id = ?
        LIMIT 1
      `,
      args: [fixtureInput],
    });

    if (fRes.rows.length === 0) {
      return {
        success: false,
        responseText: `⚠️ Pertandingan dengan ID *"${fixtureInput}"* tidak ditemukan.\nGunakan ID fixture lengkap (lihat via *!schedule*), contoh: \`!roomcard <fixture_id_lengkap> ok\`.`,
      };
    }

    const fixture = fRes.rows[0] as any;
    const fixtureId = String(fixture.id);
    const tournamentId = String(fixture.tournament_id);
    const tournamentName = String(fixture.tournament_name);
    const teamAId = String(fixture.team_a_id);
    const teamBId = String(fixture.team_b_id);
    const teamAName = String(fixture.team_a_name);
    const teamBName = String(fixture.team_b_name);
    const stage = String(fixture.stage);
    const leftSideTeamId = String(fixture.left_side_team_id || fixture.team_a_id);
    const leftSideName = leftSideTeamId === teamAId ? teamAName : teamBName;

    // If no status given, show current room card status and guidance
    if (!statusAction) {
      const currentHostId = fixture.host_team_id ? String(fixture.host_team_id) : null;
      const currentHostName = currentHostId ? (currentHostId === teamAId ? teamAName : teamBName) : 'Belum ditetapkan';
      const reasonLabel = fixture.host_assignment_reason === 'DEFAULT_LEFT_SIDE'
        ? 'Default Tim Kiri'
        : fixture.host_assignment_reason === 'OPPONENT_SUBSTITUTED'
        ? 'Substitusi Lawan'
        : 'Belum dievaluasi';

      return {
        success: true,
        responseText: [
          `🏠 *STATUS KARTU ROOM / HOST PERTANDINGAN*`,
          `──────────────────────────────`,
          `🏆 *Turnamen:* ${tournamentName}`,
          `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}* (${stage})`,
          `📌 *Tuan Rumah Terjadwal (Kiri):* *${leftSideName}*`,
          `🏠 *Host Aktif:* *${currentHostName}* (${reasonLabel})`,
          `📊 *Status Fixture:* ${fixture.status}`,
          ``,
          `*Cara menetapkan/mengubah status host:*`,
          `• \`!roomcard ${fixtureInput} ok\` (Tuan rumah kiri siap host)`,
          `• \`!roomcard ${fixtureInput} ganti\` (Lawan bersedia jadi host pengganti)`,
          `• \`!roomcard ${fixtureInput} tolak\` (Kiri tidak ada room, lawan menolak ganti -> lawan menang WO)`,
          `• \`!roomcard ${fixtureInput} habis\` (Kedua tim tidak punya kartu room)`,
        ].join('\n'),
      };
    }

    if (fixture.status === 'COMPLETED') {
      return {
        success: false,
        responseText: `⚠️ Pertandingan *${teamAName} vs ${teamBName}* sudah berstatus SELESAI (COMPLETED). Status host room tidak dapat diubah.`,
      };
    }

    // Role check: Organizer or delegate of team A / B
    if (!ctx.isOrganizer) {
      let isDelegate = false;
      if (ctx.delegateId) {
        const teamCheck = await db.execute({
          sql: `SELECT id FROM teams WHERE id IN (?, ?) AND delegate_id = ?`,
          args: [teamAId, teamBId, ctx.delegateId],
        });
        isDelegate = teamCheck.rows.length > 0;
      }
      if (!isDelegate) {
        return {
          success: false,
          responseText: '⛔ Hanya panitia atau delegasi dari tim yang bertanding yang dapat mengatur status kartu room.',
        };
      }
    }

    // Map action to evaluateRoomHostAvailability input
    let input: { left_side_has_card: boolean; right_side_willing_to_host: boolean; right_side_has_card?: boolean };

    if (statusAction === 'ok' || statusAction === 'ada' || statusAction === 'ready' || statusAction === 'kiri') {
      input = { left_side_has_card: true, right_side_willing_to_host: false };
    } else if (statusAction === 'ganti' || statusAction === 'sub' || statusAction === 'substitute' || statusAction === 'kanan') {
      input = { left_side_has_card: false, right_side_willing_to_host: true, right_side_has_card: true };
    } else if (statusAction === 'tolak' || statusAction === 'refuse') {
      input = { left_side_has_card: false, right_side_willing_to_host: false, right_side_has_card: true };
    } else if (statusAction === 'habis' || statusAction === 'kosong' || statusAction === 'none' || statusAction === 'both_none') {
      input = { left_side_has_card: false, right_side_willing_to_host: false, right_side_has_card: false };
    } else {
      return {
        success: false,
        responseText: `⚠️ Status *"${statusAction}"* tidak dikenali. Pilih salah satu: \`ok\`, \`ganti\`, \`tolak\`, atau \`habis\`.`,
      };
    }

    const evalRes = await evaluateRoomHostAvailability(db, fixtureId, input);

    // If match resulted in walkover or double loss, update standings if group stage
    if (!evalRes.match_can_proceed && evalRes.walkover_outcome) {
      if (fixture.group_id && evalRes.walkover_outcome.action !== 'KNOCKOUT_DOUBLE_LOSS_RECORDED') {
        await recalculateAndPersistGroupStandings(db, tournamentId, String(fixture.group_id));
      }

      const outcome = evalRes.walkover_outcome;
      if (outcome.action === 'GROUP_DOUBLE_WALKOVER_RECORDED') {
        return {
          success: true,
          responseText: [
            `❌ *KEPUTUSAN KARTU ROOM: WO GANDA (DOUBLE WALKOVER)*`,
            `──────────────────────────────`,
            `🏆 *Turnamen:* ${tournamentName}`,
            `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}* (Group Stage)`,
            ``,
            `⚠️ *Alasan:* ${outcome.reason}`,
            `📊 *Skor Resmi:* 0–0 (*0 Poin* untuk kedua tim, tanpa statistik pemain sesuai FR-COMP-014 / D-031).`,
            `📌 *Klasemen grup telah diperbarui secara otomatis.*`,
          ].join('\n'),
        };
      }

      if (outcome.action === 'KNOCKOUT_DOUBLE_LOSS_RECORDED') {
        return {
          success: true,
          responseText: [
            `❌ *KEPUTUSAN KARTU ROOM: KALAH GANDA (DOUBLE LOSS — KNOCKOUT)*`,
            `──────────────────────────────`,
            `🏆 *Turnamen:* ${tournamentName}`,
            `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}* (${stage})`,
            ``,
            `⚠️ *Alasan:* ${outcome.reason}`,
            `📉 *Keputusan:* KEDUA tim dinyatakan KALAH — tidak ada pemenang dari pertandingan ini (D-032 revisi 20 Nov 2026).`,
            `➡️ *Konsekuensi:* Tim yang seharusnya bertemu pemenang pertandingan ini di ronde berikutnya otomatis LOLOS tanpa bertanding (bye).`,
            `💡 _Panitia memicu ronde berikutnya dengan *!startknockout*; pasangan penerima bye akan ditampilkan otomatis._`,
          ].join('\n'),
        };
      }

      if (outcome.action === 'SINGLE_FORFEIT_RECORDED') {
        const winnerName = outcome.winner_team_id === teamAId ? teamAName : teamBName;
        const loserName = outcome.loser_team_id === teamAId ? teamAName : teamBName;
        return {
          success: true,
          responseText: [
            `❌ *KEPUTUSAN KARTU ROOM: FORFEIT / WO*`,
            `──────────────────────────────`,
            `🏆 *Turnamen:* ${tournamentName}`,
            `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}*`,
            ``,
            `⚠️ *Tim Kalah WO:* *${loserName}* (Tidak memiliki kartu room & lawan menolak menggantikan)`,
            `🎉 *Pemenang WO:* *${winnerName}*`,
            `📊 *Skor Resmi:* ${outcome.score.team_a_score}–${outcome.score.team_b_score} (*3 Poin* untuk ${winnerName})`,
            `📌 *Klasemen grup telah diperbarui secara otomatis.*`,
          ].join('\n'),
        };
      }
    }

    // Match can proceed
    const hostTeamName = evalRes.host_team_id === teamAId ? teamAName : teamBName;
    if (evalRes.host_assignment_reason === 'DEFAULT_LEFT_SIDE') {
      return {
        success: true,
        responseText: [
          `✅ *PENETAPAN TUAN RUMAH / ROOM HOST*`,
          `──────────────────────────────`,
          `🏆 *Turnamen:* ${tournamentName}`,
          `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}*`,
          `🏠 *Host Terpilih:* *${hostTeamName}* (Tuan Rumah Terjadwal - Tim Kiri)`,
          `📋 *Status:* Room card tersedia. Pertandingan dapat dilanjutkan. Silakan buat room pertandingan.`,
        ].join('\n'),
      };
    } else {
      return {
        success: true,
        responseText: [
          `✅ *PENETAPAN TUAN RUMAH / ROOM HOST (SUBSTITUSI)*`,
          `──────────────────────────────`,
          `🏆 *Turnamen:* ${tournamentName}`,
          `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}*`,
          `⚠️ Tim kiri (*${leftSideName}*) tidak memiliki kartu room.`,
          `🏠 *Host Pengganti:* *${hostTeamName}* bersedia bertindak sebagai room host.`,
          `📋 *Status:* Pertandingan dapat dilanjutkan dengan host pengganti.`,
        ].join('\n'),
      };
    }
  };

  router.registerCommand({
    command: 'roomcard',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengecek dan menetapkan ketersediaan room card host pertandingan',
    handler: roomCardHandler,
  });

  router.registerCommand({
    command: 'karturoom',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengecek dan menetapkan ketersediaan room card host pertandingan',
    handler: roomCardHandler,
  });

  router.registerCommand({
    command: 'hostroom',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengecek dan menetapkan ketersediaan room card host pertandingan',
    handler: roomCardHandler,
  });

  // !claimwo / !wo <fixture_id> <nama_tim_forfeit> [alasan]
  const claimWoHandler = async (ctx: CommandContext) => {
    const parts = ctx.args;
    if (parts.length < 2) {
      return {
        success: false,
        responseText: [
          `⚠️ *FORMAT KLAIM WALKOVER (WO):*`,
          `\`!claimwo <fixture_id> <nama_tim_yang_forfeit> [alasan]\``,
          ``,
          `Contoh:`,
          `\`!claimwo 1 Garuda FC Tidak hadir 10 menit setelah kick-off\``,
          `\`!claimwo 2 Elang FC Menolak bertindak sebagai host room\``,
          ``,
          `💡 _Tim yang disebutkan adalah tim yang kalah WO. Lawannya otomatis menang 3–0 (3 poin)._`,
        ].join('\n'),
      };
    }

    const fixtureInput = parts[0].trim();
    const forfeitingTeamInput = parts[1].trim();
    const reason = parts.slice(2).join(' ').trim() || 'Lawan tidak hadir / forfeit setelah batas toleransi';

    // Find fixture: exact ID match only (FIX2-LOOKUP-001)
    const fRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.round_code, f.team_a_id, f.team_b_id, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name, t.name as tournament_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        JOIN tournaments t ON f.tournament_id = t.id
        WHERE f.id = ?
        LIMIT 1
      `,
      args: [fixtureInput],
    });

    if (fRes.rows.length === 0) {
      return {
        success: false,
        responseText: `⚠️ Pertandingan dengan ID *"${fixtureInput}"* tidak ditemukan.\nGunakan ID fixture lengkap (lihat via *!schedule*), contoh: \`!claimwo <fixture_id_lengkap> <nama_tim_forfeit> <alasan>\`.`,
      };
    }

    const fixture = fRes.rows[0] as any;
    const fixtureId = String(fixture.id);
    const tournamentId = String(fixture.tournament_id);
    const tournamentName = String(fixture.tournament_name);
    const teamAId = String(fixture.team_a_id);
    const teamBId = String(fixture.team_b_id);
    const teamAName = String(fixture.team_a_name);
    const teamBName = String(fixture.team_b_name);

    if (fixture.status === 'COMPLETED') {
      return {
        success: false,
        responseText: `⚠️ Pertandingan *${teamAName} vs ${teamBName}* sudah berstatus SELESAI (COMPLETED). Tidak dapat di-WO.`,
      };
    }

    // Determine forfeiting team
    let forfeitingTeamId: string | null = null;
    let winningTeamName = '';
    let losingTeamName = '';

    const lowerInput = forfeitingTeamInput.toLowerCase();
    if (teamAName.toLowerCase().includes(lowerInput)) {
      forfeitingTeamId = teamAId;
      losingTeamName = teamAName;
      winningTeamName = teamBName;
    } else if (teamBName.toLowerCase().includes(lowerInput)) {
      forfeitingTeamId = teamBId;
      losingTeamName = teamBName;
      winningTeamName = teamAName;
    } else {
      return {
        success: false,
        responseText: `⚠️ Tim *"${forfeitingTeamInput}"* tidak cocok dengan tim peserta di pertandingan ini (*${teamAName}* vs *${teamBName}*).`,
      };
    }

    const winningTeamId = forfeitingTeamId === teamAId ? teamBId : teamAId;

    // Delegate flow: stage pending WO claim for organizer "!ok" confirmation
    if (!ctx.isOrganizer) {
      if (!ctx.delegateId) {
        return {
          success: false,
          responseText: '⛔ Hanya panitia atau delegasi resmi tim yang dapat mengajukan klaim walkover (WO).',
        };
      }

      const delegateCheck = await db.execute({
        sql: `SELECT id FROM teams WHERE id IN (?, ?) AND delegate_id = ?`,
        args: [teamAId, teamBId, ctx.delegateId],
      });
      if (delegateCheck.rows.length === 0) {
        return {
          success: false,
          responseText: '⚠️ Anda bukan delegasi dari tim yang bertanding dalam pertandingan ini.',
        };
      }

      if (!deps.woClaimSession) {
        return {
          success: false,
          responseText: '⚠️ Layanan pengajuan klaim WO tidak tersedia.',
        };
      }

      // BUGFIX-TS-001: PendingWoClaim.id is required by the interface but was
      // never populated on this (!claimwo) path — the natural-language WO path
      // in index.ts already sets it with randomUUID(). Generate it here too so
      // the contract holds and any future id reference gets a real value.
      const claim: PendingWoClaim = {
        id: randomUUID(),
        chatId: ctx.message.chat_id,
        fixtureId,
        tournamentId,
        tournamentName,
        groupId: fixture.group_id ? String(fixture.group_id) : null,
        stage: String(fixture.stage),
        roundCode: fixture.round_code ? String(fixture.round_code) : null,
        teamAName,
        teamBName,
        reportingTeamId: winningTeamId,
        reportingTeamName: winningTeamName,
        forfeitingTeamId,
        forfeitingTeamName: losingTeamName,
        reason,
        // BUGFIX-TS-002: sender_id never existed on NormalizedMessage (legacy
        // field name from before the normalization refactor). sender_raw_address
        // is a required, always-populated field guaranteed non-empty by the
        // normalizer (participant || remoteJid, and messages without remoteJid
        // are dropped entirely), so the fallback was dead code.
        reportedByAddress: ctx.message.sender_raw_address,
        reportedByDelegateId: ctx.delegateId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      deps.woClaimSession.stagePendingClaim(claim);

      const organizerPhone = (router as any).organizerPhone || process.env.WA_ORGANIZER_PHONE || '';
      const promptText = deps.woClaimSession.formatClaimPrompt(claim, organizerPhone);

      const rawOrgJid =
        (router as any).organizerJid ||
        process.env.WA_ORGANIZER_JID ||
        (organizerPhone ? `${organizerPhone.replace(/\D/g, '')}@s.whatsapp.net` : '');
      const orgJid = rawOrgJid.split(',')[0].trim();
      const mentions = orgJid ? [orgJid] : [];

      return {
        success: true,
        responseText: promptText,
        metadata: { mentions },
      };
    }

    // Organizer flow: execute administrative single forfeit directly
    const outcome = await handleSingleForfeit(db, fixtureId, forfeitingTeamId, reason);

    // Recalculate standings if group stage
    if (fixture.group_id) {
      await recalculateAndPersistGroupStandings(db, tournamentId, String(fixture.group_id));
    }

    const announcement = [
      `❌ *KEPUTUSAN KLAIM WALKOVER (WO)*`,
      `──────────────────────────────`,
      `🏆 *Turnamen:* ${tournamentName}`,
      `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}*`,
      ``,
      `⚠️ *Tim Forfeit / Kalah WO:* ${losingTeamName}`,
      `🎉 *Pemenang WO:* *${winningTeamName}*`,
      `📊 *Skor Resmi:* ${outcome.score.team_a_score}–${outcome.score.team_b_score} (*3 Poin* untuk ${winningTeamName})`,
      `📝 *Alasan:* ${reason}`,
      `──────────────────────────────`,
      `📌 *Klasemen grup telah diperbarui secara otomatis.*`,
    ].join('\n');

    return {
      success: true,
      responseText: announcement,
    };
  };

  router.registerCommand({
    command: 'claimwo',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengajukan atau mengesahkan klaim walkover (WO) 3-0 untuk tim lawan',
    handler: claimWoHandler,
  });

  router.registerCommand({
    command: 'klaimwo',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengajukan atau mengesahkan klaim walkover (WO) 3-0 untuk tim lawan',
    handler: claimWoHandler,
  });

  router.registerCommand({
    command: 'wo',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengajukan atau mengesahkan klaim walkover (WO) 3-0 untuk tim lawan',
    handler: claimWoHandler,
  });

  // ============================================================================
  // !startknockout — Organizer trigger for the Knockout Stage (FIX2-KO-001)
  // ============================================================================
  const startKnockoutHandler = async (ctx: CommandContext) => {
    let tournamentId = ctx.args[0]?.trim();
    let tournamentName = '';

    if (tournamentId) {
      const tRes = await db.execute({
        sql: 'SELECT id, name, status FROM tournaments WHERE id = ?',
        args: [tournamentId],
      });
      if (tRes.rows.length === 0) {
        return {
          success: false,
          responseText: `⚠️ Turnamen dengan ID \`${tournamentId}\` tidak ditemukan.`,
        };
      }
      tournamentName = String(tRes.rows[0].name);
    } else {
      const tRes = await db.execute(`
        SELECT id, name, status
        FROM tournaments
        WHERE status NOT IN ('COMPLETED', 'ARCHIVED')
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (tRes.rows.length === 0) {
        return {
          success: false,
          responseText: '⚠️ Belum ada turnamen aktif di sistem.',
        };
      }
      tournamentId = String(tRes.rows[0].id);
      tournamentName = String(tRes.rows[0].name);
    }

    try {
      // 1. Guard: all group-stage fixtures must be resolved
      const unfinRes = await db.execute({
        sql: `SELECT COUNT(*) as c FROM fixtures
              WHERE tournament_id = ? AND stage = 'GROUP'
                AND status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')`,
        args: [tournamentId],
      });
      const unfinished = Number(unfinRes.rows[0]?.c || 0);
      if (unfinished > 0) {
        return {
          success: false,
          responseText: `⚠️ Masih ada *${unfinished}* pertandingan babak grup yang belum selesai.\nSelesaikan seluruh babak grup (termasuk batas waktu matchday 19:59 WIB / D-031) sebelum memulai fase knockout.\nKetik *!matchday* untuk status ronde aktif.`,
        };
      }

      // 2. Guard: knockout fixtures must not already exist
      const koRes = await db.execute({
        sql: `SELECT COUNT(*) as c FROM fixtures
              WHERE tournament_id = ? AND stage = 'KNOCKOUT'`,
        args: [tournamentId],
      });
      if (Number(koRes.rows[0]?.c || 0) > 0) {
        // All series of the current KO round complete? Then generate the next round.
        const pendingSeriesRes = await db.execute({
          sql: `SELECT COUNT(*) as c FROM series s
                JOIN fixtures f ON s.fixture_id = f.id
                WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
                  AND s.status != 'COMPLETED'`,
          args: [tournamentId],
        });
        const pendingSeries = Number(pendingSeriesRes.rows[0]?.c || 0);
        if (pendingSeries > 0) {
          const activeKoRes = await db.execute({
            sql: `SELECT f.round_code, f.status, ta.team_name AS team_a_name, tb.team_name AS team_b_name
                  FROM fixtures f
                  JOIN teams ta ON f.team_a_id = ta.id
                  JOIN teams tb ON f.team_b_id = tb.id
                  WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND f.status NOT IN ('COMPLETED')
                  ORDER BY f.created_at ASC`,
            args: [tournamentId],
          });
          const activeNames = activeKoRes.rows
            .map((r: any) => `• *${String(r.team_a_name)}* vs *${String(r.team_b_name)}* (${String(r.round_code)})`)
            .join('\n');

          return {
            success: false,
            responseText: `ℹ️ Fase knockout sudah berjalan. Masih ada *${pendingSeries}* series yang belum selesai:\n${activeNames}\n\nSelesaikan seluruh series ronde aktif dengan *!kores <fixture_id> <game_no> <skor_a>-<skor_b>*, lalu ketik *!startknockout* lagi untuk membentuk ronde berikutnya.`,
          };
        }

        // All series complete: determine next round from series winners.
        const currentRoundRes = await db.execute({
          sql: `SELECT f.round_code FROM fixtures f
                WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
                ORDER BY f.created_at DESC LIMIT 1`,
          args: [tournamentId],
        });
        const currentRoundCode = currentRoundRes.rows.length > 0
          ? String((currentRoundRes.rows[0] as any).round_code)
          : null;

        // Collect per-fixture results of the current KO round, including
        // double-loss fixtures (D-032 revised): a COMPLETED series without a
        // winner yields NO qualifier but grants a BYE to its pairing slot.
        const roundFixturesRes = await db.execute({
          sql: `SELECT f.id AS fixture_id, f.round_code, f.team_a_id, f.team_b_id, f.status,
                       s.winner_team_id, s.status AS series_status,
                       ta.team_name AS team_a_name, tb.team_name AS team_b_name
                FROM fixtures f
                LEFT JOIN series s ON s.fixture_id = f.id
                JOIN teams ta ON f.team_a_id = ta.id
                JOIN teams tb ON f.team_b_id = tb.id
                WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
                ORDER BY f.created_at ASC`,
          args: [tournamentId],
        });

        interface RoundFixtureRow {
          fixture_id: string;
          round_code: string;
          team_a_id: string;
          team_b_id: string;
          status: string;
          winner_team_id: string | null;
          series_status: string | null;
          team_a_name: string;
          team_b_name: string;
        }
        const roundFixtures = roundFixturesRes.rows.map((r: any) => ({
          fixture_id: String(r.fixture_id),
          round_code: String(r.round_code || ''),
          team_a_id: String(r.team_a_id),
          team_b_id: String(r.team_b_id),
          status: String(r.status),
          winner_team_id: r.winner_team_id ? String(r.winner_team_id) : null,
          series_status: r.series_status ? String(r.series_status) : null,
          team_a_name: String(r.team_a_name),
          team_b_name: String(r.team_b_name),
        })) as RoundFixtureRow[];

        const currentRoundFixtures = roundFixtures.filter(
          (f) => f.round_code === currentRoundCode
        );

        // Qualifiers for the next round: series winners, plus BYE recipients
        // (pairing partner of a double-loss fixture) flagged as bye.
        interface NextRoundSeed {
          team_id: string;
          team_name: string;
          from_double_loss_bye: boolean;
          double_loss_pairing?: string;
        }
        const seeds: NextRoundSeed[] = [];
        const byeMessages: string[] = [];

        for (const f of currentRoundFixtures) {
          if (f.winner_team_id) {
            const winnerName = f.winner_team_id === f.team_a_id ? f.team_a_name : f.team_b_name;
            seeds.push({ team_id: f.winner_team_id, team_name: winnerName, from_double_loss_bye: false });
          } else if (f.status === 'WALKOVER' && (f.series_status === 'COMPLETED' || f.series_status === null)) {
            // Double-loss fixture (D-032 revised): no winner. The pairing
            // partner of this fixture advances automatically (bye).
            const fixtureIndex = currentRoundFixtures.indexOf(f);
            const partner = currentRoundFixtures[fixtureIndex % 2 === 0 ? fixtureIndex + 1 : fixtureIndex - 1];
            if (partner && partner.winner_team_id) {
              const byeTeamName = partner.winner_team_id === partner.team_a_id ? partner.team_a_name : partner.team_b_name;
              seeds.push({
                team_id: partner.winner_team_id,
                team_name: byeTeamName,
                from_double_loss_bye: true,
                double_loss_pairing: `${f.team_a_name} vs ${f.team_b_name}`,
              });
              byeMessages.push(
                `➡️ *BYE OTOMATIS:* *${byeTeamName}* lolos ke ronde berikutnya tanpa bertanding — pasangannya (${f.team_a_name} vs ${f.team_b_name}) berakhir KALAH GANDA (D-032 revisi 20 Nov 2026).`
              );
            }
          }
        }

        // Dedup seeds: a bye recipient may already be present as a series
        // winner (same team). A self-match (team vs itself) must never be
        // generated — generateKnockoutFixtures also guards this.
        const uniqueSeeds: NextRoundSeed[] = [];
        const seenTeamIds = new Set<string>();
        for (const s of seeds) {
          if (seenTeamIds.has(s.team_id)) continue;
          seenTeamIds.add(s.team_id);
          uniqueSeeds.push(s);
        }

        // If dedup leaves <= 1 unique team, that team is the CHAMPION directly
        // (e.g. both semi-finals ended in double loss but one had a winner
        // paired against the double-loss fixture, or every remaining opponent
        // is gone). Crown them and complete the tournament.
        if (uniqueSeeds.length <= 1) {
          const champion = uniqueSeeds[0];
          if (champion) {
            const nowIso = new Date().toISOString();
            await db.execute({
              sql: `UPDATE tournaments SET status = 'COMPLETED', updated_at = ? WHERE id = ?`,
              args: [nowIso, tournamentId],
            });
            await db.execute({
              sql: `INSERT INTO audit_events (
                      id, actor_type, actor_id, event_type, entity_type, entity_id,
                      before_json, after_json, reason, correlation_id, created_at
                    ) VALUES (?, 'ORGANIZER', ?, 'KNOCKOUT_CHAMPION_BY_DEFAULT', 'TOURNAMENT', ?, ?, ?, ?, ?, ?)`,
              args: [
                randomUUID(),
                ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER',
                tournamentId,
                JSON.stringify({ round: currentRoundCode }),
                JSON.stringify({ champion_team_id: champion.team_id, status: 'COMPLETED' }),
                `Sole surviving qualifier after double-loss fixtures (${byeMessages.length} bye); crowned champion by default (D-032 revised).`,
                randomUUID(),
                nowIso,
              ],
            });

            const championMsg = formatKnockoutNextRoundMessage({
              tournamentName,
              isGrandFinal: true,
              isChampionship: true,
              nextRoundFixtures: [],
              winnerTeamNames: [champion.team_name],
            });
            const fullChampionMsg = byeMessages.length > 0
              ? `${championMsg}\n\n${byeMessages.join('\n')}`
              : championMsg;
            if (deps.sender) {
              await deps.sender.sendText(ctx.message.chat_id, fullChampionMsg);
            }
            return {
              success: true,
              responseText: deps.sender
                ? `👑 Tidak ada lawan tersisa — *${champion.team_name}* dinobatkan JUARA secara otomatis (double-loss berantai).`
                : fullChampionMsg,
            };
          }
          return {
            success: false,
            responseText: '⚠️ Tidak ada tim tersisa untuk ronde berikutnya (semua pertandingan berakhir double loss). Panitia perlu menetapkan juara secara manual.',
          };
        }

        // Grand Final already played -> tournament over
        if (currentRoundCode === 'FINAL') {
          return {
            success: false,
            responseText: '✅ Fase knockout turnamen ini sudah selesai hingga Grand Final. Turnamen telah tuntas.',
          };
        }

        if (seeds.length < 2) {
          return {
            success: false,
            responseText: '⚠️ Jumlah pemenang series belum cukup untuk membentuk ronde knockout berikutnya.',
          };
        }

        // BRACKET-REDRAW (Arya decision, 21 Nov 2026): for SECOND-AND-LATER
        // knockout rounds the survivors are RE-DRAWN each round — the pairing
        // no longer maps from the previous round's fixture order/indices (this
        // also removes the index-adjacency assumption flagged as suspected
        // new-bug #3). The previous implementation faked pseudo "rank 1/rank 2"
        // group seeding from the winners list; survivors of a knockout round
        // have no group ranks, so the draw is a fresh shuffle + sequential
        // pairing (cryptoFisherYates — the same primitive as the group-stage
        // !draw), with the T2 odd-survivor bye handled inside
        // generateKnockoutFixtures.
        const teamNameOf = (seeds: NextRoundSeed[], teamId: string): string =>
          seeds.find((s) => s.team_id === teamId)?.team_name || teamId;
        const nextQualifiers: KnockoutQualifier[] = uniqueSeeds.map((s) => ({
          team_id: s.team_id,
          team_name: s.team_name,
          group_code: 'KO',
          group_rank: 1,
        }));

        const { fixtures: nextFixtures, series: nextSeries, byeTeamId: nextRoundByeTeamId } = await generateKnockoutFixtures(
          db,
          tournamentId,
          nextQualifiers,
          { shuffle: cryptoFisherYates }
        );

        const isFinalRound = nextFixtures.length === 1;

        // Audit event — the drawn pairings are recorded so the draw is
        // auditable after the fact (who met whom per round).
        const nowIso = new Date().toISOString();
        await db.execute({
          sql: `INSERT INTO audit_events (
                  id, actor_type, actor_id, event_type, entity_type, entity_id,
                  before_json, after_json, reason, correlation_id, created_at
                ) VALUES (?, 'ORGANIZER', ?, 'KNOCKOUT_ROUND_GENERATED', 'TOURNAMENT', ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER',
            tournamentId,
            JSON.stringify({ round: currentRoundCode, drawMethod: 'RE-DRAW (cryptoFisherYates)' }),
            JSON.stringify({
              nextRoundFixtures: nextFixtures.map((f) => f.id),
              series: nextSeries.map((s) => s.id),
              drawnPairings: nextFixtures.map((f) => ({
                team_a: teamNameOf(uniqueSeeds, f.team_a_id),
                team_b: teamNameOf(uniqueSeeds, f.team_b_id),
              })),
              byeTeamId: nextRoundByeTeamId,
            }),
            `Next knockout round generated by fresh draw from series winners of ${currentRoundCode}`,
            randomUUID(),
            nowIso,
          ],
        });

        const bracketItems = nextFixtures.map((f) => {
          const s = nextSeries.find((ser) => ser.fixture_id === f.id)!;
          return {
            fixtureId: f.id,
            roundCode: f.round_code || '',
            teamAName: '',
            teamBName: '',
            seriesFormat: s.format,
            targetWins: s.target_wins,
          };
        });

        // Enrich team names
        const teamsRes = await db.execute('SELECT id, team_name FROM teams');
        const teamNameById = new Map<string, string>();
        for (const r of teamsRes.rows as any[]) {
          teamNameById.set(String(r.id), String(r.team_name));
        }
        for (const item of bracketItems) {
          const f = nextFixtures.find((fx) => fx.id === item.fixtureId)!;
          item.teamAName = teamNameById.get(f.team_a_id) || 'Tim A';
          item.teamBName = teamNameById.get(f.team_b_id) || 'Tim B';
        }

        const announcement = formatKnockoutNextRoundMessage({
          tournamentName,
          isGrandFinal: isFinalRound,
          isChampionship: false,
          nextRoundFixtures: bracketItems,
          winnerTeamNames: uniqueSeeds.map((s) => s.team_name),
        });

        // BRACKET-REDRAW: state clearly that the pairings were re-drawn, like
        // the group-stage !draw announcement.
        const redrawNotice = `🎲 *Pasangan ronde ini ditentukan lewat DRAW ULANG* dari para pemenang ronde sebelumnya.`;
        const announcementWithDraw = `${announcement}\n\n${redrawNotice}`;

        // Append explicit bye notices so the group sees WHO advanced without
        // playing and WHY (double-loss pairing, D-032 revised — and the odd-
        // survivor pool bye from AUDIT-VERIFY-T2).
        if (nextRoundByeTeamId) {
          const byeName = uniqueSeeds.find((s) => s.team_id === nextRoundByeTeamId)?.team_name || null;
          if (byeName) {
            byeMessages.push(
              `➡️ *BYE OTOMATIS:* *${byeName}* lolos ke ronde berikutnya tanpa bertanding — jumlah tim yang lolos ganjil setelah hasil ronde ini, sehingga satu tim mendapat bye (D-032 revisi).`
            );
          }
        }
        const fullAnnouncement = byeMessages.length > 0
          ? `${announcementWithDraw}\n\n${byeMessages.join('\n')}`
          : announcementWithDraw;

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, fullAnnouncement);
        }

        return {
          success: true,
          responseText: deps.sender
            ? `✅ Ronde knockout berikutnya (${isFinalRound ? 'GRAND FINAL' : bracketItems[0]?.roundCode || ''}) telah dibentuk dan diumumkan!${byeMessages.length > 0 ? ` (${byeMessages.length} bye otomatis dari double-loss diterapkan.)` : ''}`
            : fullAnnouncement,
        };
      }

      // 3. First knockout round: derive qualifiers from final group standings
      const qualifiers = await deriveKnockoutQualifiers(db, tournamentId);

      const { fixtures: koFixtures, series: koSeries } = await generateKnockoutFixtures(
        db,
        tournamentId,
        qualifiers
      );

      // Audit event
      const nowIso = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO audit_events (
                id, actor_type, actor_id, event_type, entity_type, entity_id,
                before_json, after_json, reason, correlation_id, created_at
              ) VALUES (?, 'ORGANIZER', ?, 'KNOCKOUT_STAGE_STARTED', 'TOURNAMENT', ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER',
          tournamentId,
          JSON.stringify({ stage: 'GROUP_COMPLETED' }),
          JSON.stringify({
            qualifiers: qualifiers.map((q) => q.team_name),
            fixtures: koFixtures.map((f) => f.id),
            series: koSeries.map((s) => s.id),
          }),
          'Knockout stage started from final group standings (O-004: top 2 per group)',
          randomUUID(),
          nowIso,
        ],
      });

      const teamsRes = await db.execute('SELECT id, team_name FROM teams');
      const teamNameById = new Map<string, string>();
      for (const r of teamsRes.rows as any[]) {
        teamNameById.set(String(r.id), String(r.team_name));
      }

      const bracketItems = koFixtures.map((f) => {
        const s = koSeries.find((ser) => ser.fixture_id === f.id)!;
        return {
          fixtureId: f.id,
          roundCode: f.round_code || '',
          teamAName: teamNameById.get(f.team_a_id) || 'Tim A',
          teamBName: teamNameById.get(f.team_b_id) || 'Tim B',
          seriesFormat: s.format,
          targetWins: s.target_wins,
        };
      });

      const announcement = formatKnockoutBracketAnnouncement(
        tournamentName,
        qualifiers.map((q) => ({
          team_name: q.team_name,
          group_code: q.group_code,
          group_rank: q.group_rank,
        })),
        bracketItems
      );

      if (deps.sender) {
        await deps.sender.sendText(ctx.message.chat_id, announcement);
      }

      return {
        success: true,
        responseText: deps.sender
          ? `✅ Fase knockout resmi dimulai! Bracket ${bracketItems.length} pasangan telah dibuat dan diumumkan ke grup.`
          : announcement,
      };
    } catch (err: any) {
      return {
        success: false,
        responseText: `⚠️ Gagal memulai fase knockout: ${err.message || String(err)}`,
      };
    }
  };

  router.registerCommand({
    command: 'startknockout',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Memulai fase knockout dari klasemen akhir babak grup / membentuk ronde knockout berikutnya (Admin only)',
    handler: startKnockoutHandler,
  });

  // AUDIT-VERIFY-T18: the old alias 'mulainokout' (typo of 'mulai knockout',
  // missing a 'k') is replaced by the correctly spelled 'mulaiknockout'.
  router.registerCommand({
    command: 'mulaiknockout',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Alias dari !startknockout — memulai fase knockout / ronde berikutnya (Admin only)',
    handler: startKnockoutHandler,
  });

  // ============================================================================
  // !kogame — Delegate interactive per-game knockout evidence (FIX2-KO-002)
  // ============================================================================
  // Text form gives guidance/status; the actual evidence flow is photo-based:
  // delegate sends the match-result screenshot with caption "!kogame ..." and
  // FlashPeakApp.handleKoGameEvidenceMessage runs the interactive pipeline.
  const koGameInfoHandler = async (ctx: CommandContext) => {
    // Status/lookup mode: !kogame <fixture_id> shows current series progress
    const fixtureArg = ctx.args[0]?.trim();
    if (fixtureArg) {
      const ctxInfo = await getKoSeriesContext(db, fixtureArg);
      if (!ctxInfo) {
        return {
          success: false,
          responseText: `⚠️ Series knockout tidak ditemukan untuk fixture *"${fixtureArg}"*. Pastikan fase knockout sudah dimulai (*!startknockout*) dan ID fixture benar (lihat *!schedule*).`,
        };
      }
      const slot = await deriveOpenGameSlot(db, fixtureArg);
      const lines = [
        `🎮 *STATUS SERIES KNOCKOUT:*`,
        `──────────────────────────────`,
        `⚔️ *${ctxInfo.teamAName}* vs *${ctxInfo.teamBName}* (${ctxInfo.roundCode || 'KNOCKOUT'})`,
        `📊 *Skor Series:* ${ctxInfo.gameWinsA} — ${ctxInfo.gameWinsB} (${ctxInfo.format}, first to ${ctxInfo.targetWins})`,
      ];
      if (ctxInfo.status === 'COMPLETED') {
        const winnerName = ctxInfo.seriesWinnerTeamId === ctxInfo.teamAId ? ctxInfo.teamAName : ctxInfo.teamBName;
        lines.push(`🏆 Series selesai — pemenang: *${winnerName}*.`);
      } else if (slot) {
        lines.push(
          `➡️ Menunggu hasil *game ke-${slot.gameNumber}*${slot.isTiedPendingReplay ? ' (replay game seri)' : ''}.`,
          `📸 Kirim screenshot hasil game dengan caption *!kogame* untuk mencatat hasil game ini.`
        );
      }
      return { success: true, responseText: lines.join('\n') };
    }

    return {
      success: true,
      responseText: [
        '🎮 *CARA MELAPORKAN HASIL GAME KNOCKOUT (per game):*',
        '',
        'Kirim screenshot hasil pertandingan game berikutnya dengan caption:',
        '`!kogame` (atau sebutkan fixture: `!kogame <fixture_id>`)',
        '',
        'Bot akan:',
        '1️⃣ Membaca skor dari screenshot',
        '2️⃣ Mencatat hasil game itu ke series',
        '3️⃣ Membalas skor series terkini',
        '4️⃣ Meminta foto game berikutnya — atau mengumumkan pemenang jika series sudah selesai',
        '',
        '💡 _Format best-of-N (BO3 first to 2 / BO5 first to 3) otomatis; game seri wajib replay pada slot yang sama._',
        '_Foto boleh dikirim tidak berurutan/sekaligus — sistem selalu mengisi slot game yang benar._',
        '_Cek status series: `!kogame <fixture_id>`_',
      ].join('\n'),
    };
  };

  router.registerCommand({
    command: 'kogame',
    requiredRole: 'DELEGATE',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melaporkan hasil satu game knockout via screenshot (per game); !kogame <fixture_id> untuk cek status series',
    handler: koGameInfoHandler,
  });

  // ============================================================================
  // !kores — Organizer correction path for knockout game results (FIX2-KO-002)
  // ============================================================================
  // The delegate photo pipeline (!kogame) is the primary reporting route;
  // !kores remains the organizer tool to correct/override any game result,
  // including re-recording any game the photo pipeline got wrong.
  const knockoutSeriesReportHandler = async (ctx: CommandContext) => {
    const parts = ctx.args;
    if (parts.length < 3) {
      return {
        success: false,
        responseText: [
          '⚠️ *FORMAT KOREKSI HASIL GAME KNOCKOUT (Khusus Organizer):*',
          '`!kores <fixture_id> <game_no> <skor_a>-<skor_b>`',
          '',
          'Digunakan untuk:',
          '• Mengoreksi hasil game yang salah tercatat',
          '• Menetapkan hasil game yang ditandai *perlu review* (foto bentrok)',
          '• Mencatat hasil game secara manual bila bukti foto tidak terbaca',
          '',
          'Contoh:',
          '`!kores abc-123 1 2-1` (koreksi game 1 menjadi 2-1)',
          '',
          '💡 _Jalur pelaporan utama delegasi adalah screenshot via *!kogame*._',
        ].join('\n'),
      };
    }

    const fixtureInput = parts[0].trim();
    const gameNumber = parseInt(parts[1], 10);
    const scoreMatch = parts[2].match(/^(\d+)[–-](\d+)$/);

    if (isNaN(gameNumber) || gameNumber < 1 || !scoreMatch) {
      return {
        success: false,
        responseText: '⚠️ Format tidak valid. Gunakan: `!kores <fixture_id> <game_no> <skor_a>-<skor_b>` (contoh: `!kores fix-1 1 2-1`).',
      };
    }

    const scoreA = parseInt(scoreMatch[1], 10);
    const scoreB = parseInt(scoreMatch[2], 10);

    // Lookup fixture: exact match (FIX2-LOOKUP-001)
    const fRes = await db.execute({
      sql: `SELECT f.id, f.tournament_id, f.stage, f.round_code, f.status, f.team_a_id, f.team_b_id,
                   ta.team_name AS team_a_name, tb.team_name AS team_b_name, t.name AS tournament_name
            FROM fixtures f
            JOIN teams ta ON f.team_a_id = ta.id
            JOIN teams tb ON f.team_b_id = tb.id
            JOIN tournaments t ON f.tournament_id = t.id
            WHERE f.id = ?`,
      args: [fixtureInput],
    });

    if (fRes.rows.length === 0) {
      return {
        success: false,
        responseText: `⚠️ Pertandingan dengan ID *"${fixtureInput}"* tidak ditemukan. Gunakan ID fixture lengkap (bisa dilihat via *!schedule*).`,
      };
    }

    const fixture = fRes.rows[0] as any;
    const fixtureId = String(fixture.id);

    if (String(fixture.stage) !== 'KNOCKOUT') {
      return {
        success: false,
        responseText: `⚠️ *!kores* hanya untuk pertandingan fase KNOCKOUT. Pertandingan ini bertipe ${String(fixture.stage)}. Gunakan pipeline bukti/AI atau *!manualreport* untuk babak grup.`,
      };
    }

    const series = await getSeriesByFixture(db, fixtureId);
    if (!series) {
      return {
        success: false,
        responseText: `⚠️ Series BO3/BO5 tidak ditemukan untuk fixture ini. Fase knockout mungkin belum dimulai — ketik *!startknockout*.`,
      };
    }

    // Organizer correction on a COMPLETED series is allowed (that is the point
    // of the correction path): re-recording a game re-runs the decrement logic
    // in recordSeriesGameResult and recomputes the series outcome. The
    // photo pipeline keeps rejecting completed series (no flag set there).
    // AUDIT-VERIFY-T5: pass allow_completed_series so !kores can fix a
    // wrongly recorded game even after the series ended, as documented in
    // cara-penggunaan.md.
    const teamAName = String(fixture.team_a_name);
    const teamBName = String(fixture.team_b_name);
    const tournamentName = String(fixture.tournament_name);
    const teamAId = String(fixture.team_a_id);
    const teamBId = String(fixture.team_b_id);

    try {
      const outcome = await recordSeriesGameResult(db, {
        series_id: series.id,
        game_number: gameNumber,
        team_a_score: scoreA,
        team_b_score: scoreB,
        allow_completed_series: true,
      });

      const winnerName = outcome.winner_team_id
        ? (outcome.winner_team_id === teamAId ? teamAName : teamBName)
        : null;

      const messageText = formatSeriesGameReportMessage({
        tournamentName,
        roundCode: String(fixture.round_code || ''),
        seriesFormat: series.format,
        gameNumber,
        teamAName,
        teamBName,
        teamAScore: scoreA,
        teamBScore: scoreB,
        isReplay: outcome.is_replay_required,
        isSeriesComplete: outcome.is_series_complete,
        seriesScoreA: outcome.series.team_a_game_wins,
        seriesScoreB: outcome.series.team_b_game_wins,
        winnerTeamName: winnerName,
        nextGameNumber: outcome.next_game_number,
      });

      // Grand Final won -> tournament completed
      if (
        outcome.is_series_complete &&
        String(fixture.round_code) === 'FINAL' &&
        outcome.winner_team_id
      ) {
        await db.execute({
          sql: `UPDATE tournaments SET status = 'COMPLETED', updated_at = ? WHERE id = ?`,
          args: [new Date().toISOString(), String(fixture.tournament_id)],
        });

        const championMsg = formatKnockoutNextRoundMessage({
          tournamentName,
          isGrandFinal: true,
          isChampionship: true,
          nextRoundFixtures: [],
          winnerTeamNames: [winnerName || ''],
        });

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, messageText);
          await deps.sender.sendText(ctx.message.chat_id, championMsg);
        }

        return {
          success: true,
          responseText: deps.sender
            ? `✅ Hasil game dicatat & turnamen selesai — Juara: *${winnerName}*!`
            : `${messageText}\n\n${championMsg}`,
        };
      }

      return {
        success: true,
        responseText: deps.sender ? `✅ Hasil game ke-${gameNumber} series knockout telah dicatat (koreksi organizer).` : messageText,
      };
    } catch (err: any) {
      return {
        success: false,
        responseText: `⚠️ Gagal mencatat hasil game knockout: ${err.message || String(err)}`,
      };
    }
  };

  router.registerCommand({
    command: 'kores',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Koreksi hasil game knockout / tetapkan hasil game yang perlu review (Admin only)',
    handler: knockoutSeriesReportHandler,
  });

  // ============================================================================
  // !reopen / !override — Organizer lock management on LOCKED reports (FIX2-APR-001)
  // ============================================================================
  // Resolves a report version id from user input. Accepts:
  // 1. A full report version UUID directly.
  // 2. A fixture id -> latest version of that fixture.
  const resolveReportVersionId = async (
    input: string
  ): Promise<{ versionId: string | null; version: ReportVersion | null }> => {
    const direct = await getReportVersion(db, input);
    if (direct) {
      return { versionId: input, version: direct };
    }

    const verRes = await db.execute({
      sql: `SELECT rv.id FROM report_versions rv
            WHERE rv.fixture_id = ?
            ORDER BY rv.version_number DESC LIMIT 1`,
      args: [input],
    });
    if (verRes.rows.length === 0) {
      return { versionId: null, version: null };
    }
    const fallbackId = String(verRes.rows[0].id ?? verRes.rows[0][0]);
    const fallbackVersion = await getReportVersion(db, fallbackId);
    return { versionId: fallbackId, version: fallbackVersion };
  };

  const reopenReportHandler = async (ctx: CommandContext) => {
    const rawArgs = ctx.rawArgs.trim();

    const usageText = [
      '⚠️ *FORMAT PERINTAH REOPEN LAPORAN:*',
      '',
      'Membuka kembali laporan yang sudah LOCKED agar bisa dikoreksi:',
      '`!reopen <report_version_id> <alasan>`',
      '',
      '💡 _ID juga bisa berupa fixture id; sistem otomatis memakai versi terbarunya._',
    ].join('\n');

    if (!rawArgs) {
      return { success: false, responseText: usageText };
    }

    const firstSpace = rawArgs.indexOf(' ');
    const versionInput = firstSpace === -1 ? rawArgs : rawArgs.slice(0, firstSpace);
    const reason = firstSpace === -1 ? '' : rawArgs.slice(firstSpace + 1).trim();

    if (!reason) {
      return { success: false, responseText: `⚠️ Alasan reopen wajib diisi (tercatat di audit trail).\n\n${usageText}` };
    }

    const { versionId, version } = await resolveReportVersionId(String(versionInput));
    if (!versionId || !version) {
      return {
        success: false,
        responseText: `⚠️ Report version / fixture dengan ID *"${versionInput}"* tidak ditemukan.`,
      };
    }

    if (version.status !== 'LOCKED') {
      return {
        success: false,
        responseText: `ℹ️ Laporan versi ${version.version_number} belum berstatus LOCKED (status saat ini: *${version.status}*). Reopen hanya berlaku untuk laporan terkunci.`,
      };
    }

    try {
      const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
      const updated = await organizerReopenReport(db, {
        report_version_id: versionId,
        organizer_id: organizerId,
        reason,
      });

      return {
        success: true,
        responseText: [
          `🔓 *LAPORAN DIBUKA KEMBALI (REOPEN) OLEH PANITIA*`,
          `──────────────────────────────`,
          `🆔 *Report Version:* ${versionId} (versi ${updated.version_number})`,
          `📊 *Status Baru:* NEEDS_CORRECTION`,
          `📝 *Alasan:* ${reason}`,
          ``,
          `✅ Jalur koreksi laporan (balas pesan draf dengan kalimat koreksi) kini dapat digunakan kembali untuk laporan ini.`,
          `Setelah koreksi dibuat, versi baru akan membutuhkan persetujuan 3 pihak ulang (FR-APR-003).`,
        ].join('\n'),
      };
    } catch (err: any) {
      return {
        success: false,
        responseText: `⚠️ Gagal reopen laporan: ${err.message || String(err)}`,
      };
    }
  };

  router.registerCommand({
    command: 'reopen',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membuka kembali laporan LOCKED untuk koreksi (Admin only)',
    handler: reopenReportHandler,
  });

  // !override — Organizer unilateral lock (FIX2-APR-001, FR-APR-004)
  const overrideLockHandler = async (ctx: CommandContext) => {
    const rawArgs = ctx.rawArgs.trim();

    const usageText = [
      '⚠️ *FORMAT PERINTAH OVERRIDE LAPORAN:*',
      '',
      'Mengunci paksa laporan tanpa konsensus 3 pihak (darurat, tercatat di audit trail):',
      '`!override <report_version_id> <alasan>`',
      '',
      '💡 _ID juga bisa berupa fixture id; sistem otomatis memakai versi terbarunya._',
    ].join('\n');

    if (!rawArgs) {
      return { success: false, responseText: usageText };
    }

    const firstSpace = rawArgs.indexOf(' ');
    const versionInput = firstSpace === -1 ? rawArgs : rawArgs.slice(0, firstSpace);
    const reason = firstSpace === -1 ? '' : rawArgs.slice(firstSpace + 1).trim();

    if (!reason) {
      return { success: false, responseText: `⚠️ Alasan override wajib diisi (tercatat di audit trail).\n\n${usageText}` };
    }

    const { versionId, version } = await resolveReportVersionId(String(versionInput));
    if (!versionId || !version) {
      return {
        success: false,
        responseText: `⚠️ Report version / fixture dengan ID *"${versionInput}"* tidak ditemukan.`,
      };
    }

    if (version.status === 'LOCKED') {
      return {
        success: false,
        responseText: `ℹ️ Laporan versi ${version.version_number} sudah berstatus LOCKED. Gunakan *!reopen* untuk membukanya kembali.`,
      };
    }

    try {
      const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
      const updated = await organizerOverrideLock(db, {
        report_version_id: versionId,
        organizer_id: organizerId,
        reason,
      });

      return {
        success: true,
        responseText: [
          `🔐 *PENGUNCIAN PAKSA OLEH PANITIA (OVERRIDE)*`,
          `──────────────────────────────`,
          `🆔 *Report Version:* ${versionId} (versi ${updated.version_number})`,
          `📊 *Status Baru:* LOCKED`,
          `📝 *Alasan:* ${reason}`,
          ``,
          `📌 Statistik pemain dan finalisasi pertandingan telah diproses seperti lock konsensus biasa.`,
          `⚠️ _Tindakan override darurat ini tercatat di audit trail (FR-APR-004)._`,
        ].join('\n'),
      };
    } catch (err: any) {
      return {
        success: false,
        responseText: `⚠️ Gagal override lock laporan: ${err.message || String(err)}`,
      };
    }
  };

  router.registerCommand({
    command: 'override',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengunci paksa laporan tanpa konsensus 3 pihak (darurat, Admin only)',
    handler: overrideLockHandler,
  });
}
