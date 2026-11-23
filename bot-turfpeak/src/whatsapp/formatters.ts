/**
 * Flash Peak TMS - WhatsApp Response & Message Formatters (Task 6.3)
 * 
 * Formats match reports, standings tables, progressive draw reveals,
 * and individual awards per PROMPT_CATALOG.md §8 and COMPETITION_RULES.
 * 
 * Guarantees:
 * - Explicit status tags: [DRAFT], [NEEDS CORRECTION], [PENDING APPROVAL], [OFFICIAL].
 * - Never claims a result is official until fully approved and locked.
 * - Uncertain values labeled as "Perlu konfirmasi", never guessed numbers.
 * - Monospaced standings table for clean alignment on WhatsApp mobile/desktop.
 */

import type { StandingWithTeamName } from '../competition/standings.js';
import type { TournamentAwardsSummary, AwardDetail } from '../stats/awards.js';
import type { ApproverType } from '../shared/types/index.js';

export type ReportDisplayStatus =
  | 'DRAFT'
  | 'NEEDS_CORRECTION'
  | 'PENDING_APPROVAL'
  | 'OFFICIAL';

export interface PlayerStatDisplayItem {
  ordinal: number;
  nickname: string;
  rating?: number | null;
  goals: number | string | null;
  assists: number | string | null;
  passes?: number | string | null;
  defense?: number | string | null;
  saves?: number | string | null;
  isGoalkeeper?: boolean;
}

export interface MatchReportSummaryParams {
  status: ReportDisplayStatus;
  versionNumber: number;
  fixtureCode?: string;
  stageName?: string;
  teamAName: string;
  teamBName: string;
  teamAScore: number | string | null;
  teamBScore: number | string | null;
  teamAPlayers: PlayerStatDisplayItem[];
  teamBPlayers: PlayerStatDisplayItem[];
  uncertainties?: string[];
  pendingApprovers?: ApproverType[];
  rejectionReason?: string;
}

/**
 * Formats a match report summary message for WhatsApp.
 */
export function formatMatchReportSummary(params: MatchReportSummaryParams): string {
  const {
    status,
    versionNumber,
    fixtureCode,
    stageName,
    teamAName,
    teamBName,
    teamAScore,
    teamBScore,
    teamAPlayers,
    teamBPlayers,
    uncertainties = [],
    pendingApprovers = [],
    rejectionReason,
  } = params;

  const lines: string[] = [];

  // Header with explicit status tag (PROMPT_CATALOG.md §8: DRAFT / NEEDS CORRECTION / PENDING APPROVAL / OFFICIAL)
  const displayStatus = status.replace(/_/g, ' ');
  const statusTag = `[${displayStatus}]`;
  const stageHeader = stageName ? ` • ${stageName}` : '';
  const fixtureHeader = fixtureCode ? ` (${fixtureCode})` : '';
  lines.push(`⚽ *LAPORAN PERTANDINGAN* ${statusTag}${fixtureHeader}${stageHeader}`);
  lines.push(`_Versi ${versionNumber}_`);
  lines.push('');

  // Match Score
  const scoreAStr = formatMetricValue(teamAScore);
  const scoreBStr = formatMetricValue(teamBScore);
  lines.push(`*${teamAName}*  ${scoreAStr} - ${scoreBStr}  *${teamBName}*`);
  lines.push('');

  // Team A Player Details
  lines.push(`📋 *Statistik ${teamAName}:*`);
  if (teamAPlayers.length === 0) {
    lines.push('  _(Belum ada data pemain)_');
  } else {
    for (const p of teamAPlayers) {
      lines.push(formatPlayerLine(p));
    }
  }
  lines.push('');

  // Team B Player Details
  lines.push(`📋 *Statistik ${teamBName}:*`);
  if (teamBPlayers.length === 0) {
    lines.push('  _(Belum ada data pemain)_');
  } else {
    for (const p of teamBPlayers) {
      lines.push(formatPlayerLine(p));
    }
  }
  lines.push('');

  // Uncertainties or warnings
  if (uncertainties.length > 0) {
    lines.push('⚠️ *Perhatian / Perlu Konfirmasi:*');
    for (const u of uncertainties) {
      lines.push(`• ${u}`);
    }
    lines.push('');
  }

  // Rejection reason if any
  if (status === 'NEEDS_CORRECTION' && rejectionReason) {
    lines.push(`❌ *Catatan Koreksi / Penolakan:* ${rejectionReason}`);
    lines.push('');
  }

  // Action instructions based on status
  lines.push('──────────────────────────────');
  if (status === 'DRAFT' || status === 'NEEDS_CORRECTION') {
    lines.push('💬 *Aksi Koreksi:*');
    lines.push(
      'Jika terdapat data yang salah, balas pesan ini dengan koreksi natural language.'
    );
    lines.push(
      '_Contoh:_ "player urutan 2 tim B salah di gol, seharusnya 2 bukan 1"'
    );
  } else if (status === 'PENDING_APPROVAL') {
    lines.push('✍️ *Menunggu Persetujuan:*');
    if (pendingApprovers.length > 0) {
      const names = pendingApprovers
        .map((a) => {
          if (a === 'TEAM_A') return `Delegasi ${teamAName}`;
          if (a === 'TEAM_B') return `Delegasi ${teamBName}`;
          return 'Organizer';
        })
        .join(', ');
      lines.push(`Menunggu: *${names}*`);
      lines.push('');
    }
    lines.push('📖 *PANDUAN LANGKAH SELANJUTNYA:*');
    lines.push('✅ *Jika data di atas SUDAH BENAR:*');
    lines.push('• Pihak pemenang dan Panitia silakan *Balas (Reply)* pesan draf ini dan ketik:');
    lines.push('  👉 *!approve*');
    lines.push('• Ketik *!approve* untuk menyetujui laporan pertandingan ini.');
    lines.push('• _(Begitu disetujui pihak pemenang & panitia, hasil resmi terkunci & klasemen grup otomatis terupdate!)_');
    lines.push('');
    lines.push('❌ *Jika data SALAH / KELIRU:*');
    lines.push('• *JANGAN !approve!* Cukup *Balas (Reply)* pesan draf ini dengan rincian yang benar.');
    lines.push('• _Contoh:_ "koreksi: skor game 2-1 bukan 3-1" atau "salah di gol, pemain nomor 1 bikin 2 gol"');
    lines.push('• Atau kirim ulang foto screenshot hasil match yang lebih jelas ke grup.');
  } else if (status === 'OFFICIAL') {
    lines.push('🔒 *Hasil Resmi Terkunci (OFFICIAL)*');
    lines.push(
      'Laporan telah disetujui ketiga pihak (Delegasi A, Delegasi B, Organizer). Statistik dan klasemen telah diperbarui.'
    );
  }

  return lines.join('\n');
}

function formatMetricValue(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === 'Perlu konfirmasi') {
    return 'Perlu konfirmasi';
  }
  return String(val);
}

function formatPlayerLine(p: PlayerStatDisplayItem): string {
  const parts: string[] = [];
  parts.push(`${p.ordinal}. *${p.nickname}*`);

  const statItems: string[] = [];
  if (p.goals !== null && p.goals !== undefined) {
    statItems.push(`Gol: ${formatMetricValue(p.goals)}`);
  }
  if (p.assists !== null && p.assists !== undefined) {
    statItems.push(`Ast: ${formatMetricValue(p.assists)}`);
  }
  if (p.passes !== null && p.passes !== undefined) {
    statItems.push(`Pass: ${formatMetricValue(p.passes)}`);
  }
  if (p.defense !== null && p.defense !== undefined) {
    statItems.push(`Def: ${formatMetricValue(p.defense)}`);
  }
  if (p.saves !== null && p.saves !== undefined) {
    statItems.push(`Saves: ${formatMetricValue(p.saves)}`);
  }
  if (p.rating !== null && p.rating !== undefined) {
    const r = typeof p.rating === 'number' && p.rating > 10.0 ? p.rating / 10 : Number(p.rating);
    statItems.push(`Rating: ${r.toFixed(1)}`);
  }

  if (statItems.length > 0) {
    parts.push(`(${statItems.join(', ')})`);
  }

  return `  ${parts.join(' ')}`;
}

const RANK_BADGES = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * Formats group standings cleanly for WhatsApp on both mobile and desktop.
 * Uses a mobile-optimized multi-line card layout with full team names,
 * avoiding the 46-character line wrap, phone-number link parsing, and name truncation issues.
 */
export function formatStandingsTable(
  groupCode: string,
  standings: StandingWithTeamName[],
  options?: { showFooter?: boolean }
): string {
  const showFooter = options?.showFooter ?? true;
  const lines: string[] = [];
  lines.push(`📊 *KLASEMEN GRUP ${groupCode.toUpperCase()}*`);

  if (standings.length === 0) {
    lines.push('_Belum ada data klasemen untuk grup ini._');
    return lines.join('\n');
  }

  for (let i = 0; i < standings.length; i++) {
    const s = standings[i];
    const badge = RANK_BADGES[s.rank - 1] || `${s.rank}.`;
    const teamName = s.team_name || s.team_id;
    const gdStr = s.goal_difference > 0 ? `+${s.goal_difference}` : String(s.goal_difference);

    lines.push(`${badge} *${teamName}* — *${s.points} Poin*`);
    lines.push(`   ${s.played} Main | ${s.wins}M ${s.draws}S ${s.losses}K | SG ${gdStr} (${s.goals_for}-${s.goals_against})`);

    // Top 2 qualification divider line
    if (s.rank === 2 && standings.length > 2) {
      lines.push(`   ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ ⬆️ _Top 2 Lolos_`);
    }
  }

  if (showFooter) {
    lines.push(`_Keterangan: Top 2 tim lolos ke Babak Knockout._`);
  }

  return lines.join('\n');
}

export interface DrawRevealStepParams {
  tournamentTitle: string;
  stepIndex: number;
  totalSteps: number;
  teamName: string;
  groupCode: string;
  seedReveal?: string;
  commitmentHash?: string;
}

/**
 * Formats a progressive draw reveal message for WhatsApp.
 */
export function formatDrawRevealStep(params: DrawRevealStepParams): string {
  const {
    tournamentTitle,
    stepIndex,
    totalSteps,
    teamName,
    groupCode,
    seedReveal,
  } = params;

  const lines: string[] = [];
  lines.push(`🎲 *PENGUNDIAN GRUP — ${tournamentTitle.toUpperCase()}*`);
  lines.push(`_Undian ke-${stepIndex} dari ${totalSteps}_`);
  lines.push('');
  lines.push(`➡️ Tim: *${teamName}*`);
  lines.push(`🎯 Masuk ke: *GRUP ${groupCode.toUpperCase()}*`);
  lines.push('');

  if (seedReveal) {
    lines.push(`🔒 _Seed Verifikasi: ${seedReveal.slice(0, 16)}..._`);
  }

  return lines.join('\n');
}

export interface CompletedDrawGroup {
  groupCode: string;
  teams: { teamId: string; teamName: string }[];
}

/**
 * Formats a completed group draw announcement for WhatsApp.
 */
export function formatDrawCompletedSummary(
  tournamentTitle: string,
  groups: CompletedDrawGroup[],
  commitmentHash?: string
): string {
  const lines: string[] = [];
  lines.push(`🎉 *HASIL LENGKAP PENGUNDIAN GRUP*`);
  lines.push(`🏆 *${tournamentTitle}*`);
  lines.push('──────────────────────────────');

  for (const g of groups) {
    lines.push('');
    lines.push(`📌 *GRUP ${g.groupCode.toUpperCase()}*`);
    g.teams.forEach((t, idx) => {
      lines.push(`  ${idx + 1}. ${t.teamName}`);
    });
  }

  lines.push('');
  lines.push('──────────────────────────────');
  if (commitmentHash) {
    lines.push(`🔐 *Commitment Hash:* \`${commitmentHash}\``);
  }
  lines.push('Jadwal pertandingan akan segera diumumkan. Selamat bertanding!');

  return lines.join('\n');
}

/**
 * Formats tournament awards announcement for WhatsApp.
 */
export function formatAwardsAnnouncement(
  tournamentTitle: string,
  awards: TournamentAwardsSummary,
  options?: { suspendGoalkeeper?: boolean }
): string {
  const lines: string[] = [];
  lines.push(`🏆 *PENGHARGAAN INDIVIDU — ${tournamentTitle.toUpperCase()}* 🏆`);
  lines.push('_Berdasarkan hasil resmi pertandingan terkunci_');
  lines.push('──────────────────────────────');
  lines.push('');

  // 1. Golden Boot
  lines.push(formatAwardSection('🥇 *GOLDEN BOOT* (Pencetak Gol Terbanyak)', awards.goldenBoot, 'Gol'));
  lines.push('');

  // 2. Top Assist
  lines.push(formatAwardSection('🎯 *TOP ASSIST* (Pemberi Assist Terbanyak)', awards.topAssist, 'Assist'));
  lines.push('');

  // 3. Best Defender
  lines.push(formatAwardSection('🛡️ *BEST DEFENDER* (Pemain Bertahan Terbaik)', awards.bestDefender, 'Defense'));
  lines.push('');

  // 4. Best Winning Goalkeeper (Team Award representing GK saves)
  // Catatan: Dinonaktifkan/ditangguhkan sementara selama turnamen atas instruksi panitia jika SUSPEND_GOALKEEPER aktif
  const isGkSuspended = options?.suspendGoalkeeper ?? (process.env.SUSPEND_GOALKEEPER === 'true');
  if (isGkSuspended) {
    lines.push('🧤 *BEST WINNING GOALKEEPER* (Kiper Terbaik)');
    lines.push('_(Status: Kategori penghargaan kiper ditangguhkan sementara oleh panitia turnamen)_');
  } else {
    lines.push(
      formatAwardSection(
        '🧤 *BEST WINNING GOALKEEPER* (Pertahanan / Kiper Tim Terbaik)',
        awards.bestWinningGoalkeeper,
        'Saves',
        {
          isTeamAward: true,
          teamAwardNote: 'Penghargaan kiper dianugerahkan kepada Tim mewakili seluruh rotasi kiper',
        }
      )
    );
  }

  lines.push('');
  lines.push('──────────────────────────────');
  lines.push('Selamat kepada para pemenang atas performa luar biasa sepanjang turnamen! 👏⚽');

  return lines.join('\n');
}

interface AwardFormatOptions {
  isTeamAward?: boolean;
  teamAwardNote?: string;
}

function formatAwardSection(
  header: string,
  award: AwardDetail,
  metricUnit: string,
  options?: AwardFormatOptions
): string {
  const lines: string[] = [header];

  if (award.winners.length === 0) {
    lines.push('  _(Belum ada pemenang yang memenuhi syarat)_');
    return lines.join('\n');
  }

  if (options?.isTeamAward) {
    if (award.isTie) {
      lines.push(`  🤝 *Tim Pemenang Bersama (Co-Winners) — ${award.winners[0].metricValue} ${metricUnit}:*`);
      for (const w of award.winners) {
        lines.push(`  • 🛡️ *${w.teamName}* (Kiper: ${w.nicknameRaw}) — ${w.gamesPlayed} laga`);
      }
    } else {
      const w = award.winners[0];
      lines.push(`  👑 Tim: *${w.teamName}*`);
      lines.push(`  🧤 Kiper Utama: *${w.nicknameRaw}*`);
      lines.push(`  Total: *${w.metricValue} ${metricUnit}* (${w.gamesPlayed} laga dimainkan)`);
    }
    if (options.teamAwardNote) {
      lines.push(`  _(${options.teamAwardNote})_`);
    }
  } else {
    if (award.isTie) {
      lines.push(`  🤝 *Pemenang Bersama (Co-Winners) — ${award.winners[0].metricValue} ${metricUnit}:*`);
      for (const w of award.winners) {
        lines.push(`  • *${w.nicknameRaw}* (${w.teamName}) — ${w.gamesPlayed} laga`);
      }
    } else {
      const w = award.winners[0];
      lines.push(`  👑 *${w.nicknameRaw}* (${w.teamName})`);
      lines.push(`  Total: *${w.metricValue} ${metricUnit}* (${w.gamesPlayed} laga dimainkan)`);
    }
  }

  if (award.isOverride) {
    lines.push('  _(Keputusan khusus dari Penyelenggara / Organizer Override)_');
  } else if (award.notes) {
    lines.push(`  _Catatan: ${award.notes}_`);
  }

  return lines.join('\n');
}

export interface FixtureScheduleDisplayItem {
  roundCode: string;
  groupCode?: string;
  teamAName: string;
  teamBName: string;
  leftSideHostName: string;
  teamADelegatePhone?: string | null;
  teamBDelegatePhone?: string | null;
  teamADelegateJid?: string | null;
  teamBDelegateJid?: string | null;
  status?: string | null;
  teamAScore?: number | null;
  teamBScore?: number | null;
  isWalkover?: boolean | number | null;
}

/**
 * Formats fixture kickoff schedule announcement for WhatsApp (Pathway #11).
 */
export function formatFixturesSchedule(
  tournamentTitle: string,
  fixtures: FixtureScheduleDisplayItem[]
): string {
  const lines: string[] = [];
  lines.push(`📅 *JADWAL PERTANDINGAN — ${tournamentTitle.toUpperCase()}*`);
  lines.push('──────────────────────────────');

  // Group by Group Code -> Round Code -> matches
  const byGroup: Record<string, Record<string, FixtureScheduleDisplayItem[]>> = {};

  for (const f of fixtures) {
    const grpKey = f.groupCode ? `GRUP ${f.groupCode.toUpperCase()}` : 'BABAK GRUP';
    const roundKey = f.roundCode
      ? f.roundCode.replace(/^ROUND_(\d+)$/i, 'Ronde $1').replace(/_/g, ' ')
      : 'Pertandingan';

    if (!byGroup[grpKey]) byGroup[grpKey] = {};
    if (!byGroup[grpKey][roundKey]) byGroup[grpKey][roundKey] = [];
    byGroup[grpKey][roundKey].push(f);
  }

  for (const [grp, rounds] of Object.entries(byGroup)) {
    lines.push('');
    lines.push(`📌 *${grp}*`);
    for (const [roundName, items] of Object.entries(rounds)) {
      lines.push('');
      lines.push(`🔹 *${roundName}*`);
      for (const item of items) {
        const isDone =
          (item.status === 'COMPLETED' || item.status === 'WALKOVER') &&
          item.teamAScore !== null &&
          item.teamAScore !== undefined &&
          item.teamBScore !== null &&
          item.teamBScore !== undefined;

        if (isDone) {
          const woSuffix = item.isWalkover ? ' _(WO)_' : '';
          lines.push(`  ✅ *${item.teamAName}*  ${item.teamAScore} - ${item.teamBScore}  *${item.teamBName}*${woSuffix}`);
        } else {
          const hostLabel = item.leftSideHostName ? `(Host: ${item.leftSideHostName})` : '(Host)';
          const tagA = item.teamADelegatePhone ? `@${item.teamADelegatePhone}` : '';
          const tagB = item.teamBDelegatePhone ? `@${item.teamBDelegatePhone}` : '';
          const hasTags = Boolean(tagA || tagB);

          lines.push(`  ⏳ *${item.teamAName}* vs *${item.teamBName}* ${hostLabel}`);
          if (hasTags) {
            lines.push(`     👤 ${tagA || '-'} vs ${tagB || '-'}`);
          }
        }
      }
    }
  }

  lines.push('');
  lines.push('──────────────────────────────');
  lines.push('💡 _Keterangan: ✅ = Selesai, ⏳ = Belum Tanding._');
  lines.push('💡 _Tim kiri bertindak sebagai Host Room di dalam game Flash Peak._');
  lines.push('Selamat bertanding & junjung sportivitas! ⚽🔥');

  return lines.join('\n');
}


// =============================================================================
// Knockout Stage Formatters (FIX2-KO-001)
// =============================================================================

export interface KnockoutBracketFixtureItem {
  fixtureId: string;
  roundCode: string;
  teamAName: string;
  teamBName: string;
  seriesFormat: 'BO3' | 'BO5';
  targetWins: number;
}

function knockoutRoundLabel(roundCode: string): string {
  switch (roundCode) {
    case 'ROUND_OF_16':
      return '16 BESAR';
    case 'QUARTER_FINAL':
      return 'PEREMPAT FINAL';
    case 'SEMI_FINAL':
      return 'SEMI FINAL';
    case 'FINAL':
      return 'GRAND FINAL';
    default:
      return roundCode.replace(/_/g, ' ');
  }
}

/**
 * Formats the knockout bracket announcement after !startknockout (FIX2-KO-001).
 */
export function formatKnockoutBracketAnnouncement(
  tournamentTitle: string,
  qualifiers: { team_name: string; group_code: string; group_rank: 1 | 2 }[],
  bracketFixtures: KnockoutBracketFixtureItem[]
): string {
  const lines: string[] = [];
  lines.push(`⚔️ *FASE KNOCKOUT RESMI DIMULAI — ${tournamentTitle.toUpperCase()}*`);
  lines.push('──────────────────────────────');
  lines.push('📌 *Format:* Best of 3 (BO3, first to 2 wins) • Grand Final: Best of 5 (BO5, first to 3 wins)');
  lines.push('🚫 Tidak ada hasil seri di fase gugur; game seri wajib di-replay pada slot yang sama.');
  lines.push('');
  lines.push('🏅 *TIM YANG LOLOS (Top 2 per Grup):*');
  for (const q of qualifiers) {
    lines.push(`  • *${q.team_name}* (Grup ${q.group_code}, Peringkat ${q.group_rank})`);
  }
  lines.push('');
  lines.push('🎯 *BRACKET PERTANDINGAN:*');
  for (const f of bracketFixtures) {
    lines.push(
      `  ⚔️ *${f.teamAName}* vs *${f.teamBName}* (${knockoutRoundLabel(f.roundCode)}, ${f.seriesFormat})`
    );
  }
  lines.push('');
  lines.push('──────────────────────────────');
  lines.push('💡 _Tim kiri pada tiap pasangan bertindak sebagai Host Room default. Panitia memicu fase berikutnya dengan *!startknockout* setelah semua series selesai._');

  return lines.join('\n');
}

export interface SeriesGameReportMessageParams {
  tournamentName: string;
  roundCode: string;
  seriesFormat: 'BO3' | 'BO5';
  gameNumber: number;
  teamAName: string;
  teamBName: string;
  teamAScore: number;
  teamBScore: number;
  isReplay: boolean;
  isSeriesComplete: boolean;
  seriesScoreA: number;
  seriesScoreB: number;
  winnerTeamName?: string | null;
  nextGameNumber?: number | null;
}

/**
 * Formats an individual knockout series game result confirmation (FIX2-KO-001).
 */
export function formatSeriesGameReportMessage(params: SeriesGameReportMessageParams): string {
  const lines: string[] = [];
  const roundLabel = knockoutRoundLabel(params.roundCode);

  if (params.isReplay) {
    lines.push(`🔁 *HASIL GAME KNOCKOUT (WAJIB REPLAY)*`);
  } else {
    lines.push(`✅ *HASIL GAME KNOCKOUT TERCATAT*`);
  }
  lines.push('──────────────────────────────');
  lines.push(`🏆 *Turnamen:* ${params.tournamentName}`);
  lines.push(`⚔️ *Series:* ${params.teamAName} vs ${params.teamBName} (${roundLabel}, ${params.seriesFormat})`);
  lines.push(`🎮 *Game ke-${params.gameNumber}:* ${params.teamAName} ${params.teamAScore} — ${params.teamBScore} ${params.teamBName}`);
  lines.push('');
  if (params.isReplay) {
    lines.push(`📊 *Skor Series:* ${params.seriesScoreA} — ${params.seriesScoreB}`);
    lines.push('🔁 Game seri wajib di-replay pada slot yang sama (D-028). Hasil replay akan menggantikan hasil ini.');
  } else if (params.isSeriesComplete) {
    lines.push(`📊 *Skor Series Akhir:* ${params.seriesScoreA} — ${params.seriesScoreB}`);
    lines.push(`🏆 *Pemenang Series:* *${params.winnerTeamName || '-'}*`);
    lines.push(`⚔️ Series selesai — pertandingan berstatus COMPLETED.`);
    if (params.nextGameNumber === null) {
      lines.push('💡 _Series ini sudah selesai; tidak ada game lanjutan._');
    }
  } else {
    lines.push(`📊 *Skor Series:* ${params.seriesScoreA} — ${params.seriesScoreB}`);
    lines.push(`➡️ Lanjut ke *game ke-${params.nextGameNumber}*.`);
    if (params.seriesFormat === 'BO3') {
      lines.push('💡 _BO3: tim pertama yang meraih 2 kemenangan game lolos ke babak berikutnya._');
    } else {
      lines.push('💡 _BO5: tim pertama yang meraih 3 kemenangan game menjadi juara turnamen._');
    }
  }
  lines.push('──────────────────────────────');

  return lines.join('\n');
}

export interface KnockoutNextRoundMessageParams {
  tournamentName: string;
  isGrandFinal: boolean;
  isChampionship: boolean;
  nextRoundFixtures: KnockoutBracketFixtureItem[];
  winnerTeamNames: string[];
}

/**
 * Formats the announcement of the next knockout round / tournament completion
 * triggered when all series in the current round are complete (FIX2-KO-001).
 */
export function formatKnockoutNextRoundMessage(params: KnockoutNextRoundMessageParams): string {
  const lines: string[] = [];

  if (params.isChampionship) {
    const champion = params.winnerTeamNames[0] || '-';
    lines.push(`👑 *JUARA TURNAMEN — ${params.tournamentName.toUpperCase()}*`);
    lines.push('──────────────────────────────');
    lines.push(`🏆 Selamat kepada *${champion}* sebagai JUARA Flash Peak! 🎉`);
    lines.push('');
    lines.push('Turnamen resmi berakhir di sini.');
    lines.push('💡 _Ketik *!awards* untuk melihat rekap penghargaan akhir turnamen._');
    return lines.join('\n');
  }

  lines.push(`⚔️ *BABAK KNOCKOUT LANJUTAN RESMI DIMULAI — ${params.tournamentName.toUpperCase()}*`);
  lines.push('──────────────────────────────');
  if (params.isGrandFinal) {
    lines.push('👑 *GRAND FINAL (BO5 — first to 3 wins)*');
  } else {
    lines.push('📌 *Format:* BO3 — first to 2 wins');
  }
  lines.push('');
  lines.push('🎯 *PASANGAN BARU:*');
  for (const f of params.nextRoundFixtures) {
    lines.push(`  ⚔️ *${f.teamAName}* vs *${f.teamBName}* (${knockoutRoundLabel(f.roundCode)}, ${f.seriesFormat})`);
  }
  lines.push('');
  lines.push('──────────────────────────────');
  lines.push('💡 _Tim kiri pada tiap pasangan bertindak sebagai Host Room default._');

  return lines.join('\n');
}
