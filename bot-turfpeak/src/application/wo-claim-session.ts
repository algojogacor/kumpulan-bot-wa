/**
 * Flash Peak TMS - Walkover (WO) Claim Session & Intent Parser
 * 
 * Manages natural language WO claim reporting, validation of reasons,
 * staging pending claims, and requiring organizer confirmation via "!ok"
 * before applying forfeits to the database.
 */

import type { Client } from '@libsql/client';
import { handleSingleForfeit } from '../competition/walkover.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';

export interface PendingWoClaim {
  id: string;
  chatId: string;
  fixtureId: string;
  tournamentId: string;
  tournamentName: string;
  groupId?: string | null;
  stage: string;
  roundCode?: string | null;
  teamAName: string;
  teamBName: string;
  reportingTeamId: string;
  reportingTeamName: string;
  forfeitingTeamId: string;
  forfeitingTeamName: string;
  reason: string;
  reportedByAddress: string;
  reportedByDelegateId?: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface WoIntentResult {
  isWoClaim: boolean;
  isGeneralQuestion: boolean;
  hasReason: boolean;
  extractedReason?: string;
  matchMention?: number;
}

/**
 * Parses natural language message text to detect intent to claim a Walkover (WO).
 * Also verifies whether a concrete reason is provided.
 */
export function parseWoClaimIntent(text: string): WoIntentResult {
  const norm = text.toLowerCase().trim();

  // 1. Check if it's a general question about rules/procedures
  const questionPhrases = [
    'bagaimana cara klaim wo',
    'gimana cara klaim wo',
    'cara klaim wo',
    'cara claim wo',
    'apakah bisa klaim wo',
    'apa bisa klaim wo',
    'syarat klaim wo',
    'aturan wo',
    'regulasi wo',
    'kapan bisa klaim wo',
    'kenapa bisa wo',
    'ketentuan wo',
  ];
  if (questionPhrases.some((qp) => norm.includes(qp)) || (norm.includes('?') && norm.includes('wo'))) {
    return {
      isWoClaim: false,
      isGeneralQuestion: true,
      hasReason: false,
    };
  }

  // 2. Check for WO intent keywords
  const woIntentPatterns = [
    /\b(klaim|claim|ajukan|minta|lapor)\s+(wo|walkover)\b/i,
    /\b(wo|walkover)[ -]?(kan|in)?\b/i,
    /\b(kena|dapat|kasih)\s+(wo|walkover)\b/i,
    /\bmenang\s+(wo|walkover)\b/i,
  ];

  const hasWoKeyword = woIntentPatterns.some((pattern) => pattern.test(norm));
  if (!hasWoKeyword) {
    return {
      isWoClaim: false,
      isGeneralQuestion: false,
      hasReason: false,
    };
  }

  // 3. Extract Match mention if any (e.g. "match 1", "pertandingan 2")
  let matchMention: number | undefined;
  const matchMatch = norm.match(/\b(?:match|pertandingan|partai|m)\s*#?\s*(\d+)\b/i);
  if (matchMatch && matchMatch[1]) {
    matchMention = parseInt(matchMatch[1], 10);
  }

  // 4. Check for Reason (Alasan)
  const reasonCues = [
    'karena',
    'sebab',
    'karna',
    'gegara',
    'gara-gara',
    'alasan',
    'lantaran',
    'tidak hadir',
    'gak hadir',
    'ga hadir',
    'tidak datang',
    'gak datang',
    'ga datang',
    'gak nongol',
    'ga nongol',
    'tidak nongol',
    'tidak ada kabar',
    'gak ada kabar',
    'ga ada kabar',
    'gaada kabar',
    'telat',
    'terlambat',
    'menit',
    'toleransi',
    'lewat waktu',
    'lewat batas',
    'menolak buat room',
    'menolak room',
    'tidak mau buat room',
    'gak mau buat room',
    'ga mau buat room',
    'room card',
    'kartu room',
    'tidak respon',
    'gak respon',
    'ga respon',
    'tidak aktif',
    'gak aktif',
    'ga aktif',
    'tidak online',
    'gak online',
    'ga online',
    'tidak balas',
    'gak balas',
    'ga balas',
    'tidak muncul',
    'gak muncul',
    'ga muncul',
    'tidak dateng',
    'gak dateng',
    'ga dateng',
    'janjian',
    'jadwal',
    'kickoff',
    'kick-off',
    'afk',
    'offline',
    'kurang pemain',
    'pemain kurang',
  ];

  const hasReasonCue = reasonCues.some((cue) => norm.includes(cue));

  let extractedReason: string | undefined;
  if (hasReasonCue) {
    const connectorMatch = norm.match(/(?:karena|sebab|karna|gegara|gara-gara|alasan|lantaran)\s+(.*)/i);
    if (connectorMatch && connectorMatch[1] && connectorMatch[1].trim().length >= 3) {
      extractedReason = connectorMatch[1].trim();
    } else {
      // Check if separated by comma or semicolon, e.g. "kita klaim wo ya, musuh ga aktif sesuai jadwal janjian"
      const commaParts = norm.split(/[,;\n]/);
      if (commaParts.length > 1) {
        const reasonPart = commaParts.find((part) =>
          reasonCues.some((cue) => part.includes(cue) && !part.includes('klaim') && !part.includes('wo'))
        );
        if (reasonPart && reasonPart.trim().length >= 3) {
          extractedReason = reasonPart.trim();
        }
      }

      if (!extractedReason) {
        for (const cue of reasonCues) {
          if (norm.includes(cue) && !['karena', 'sebab', 'karna', 'gegara', 'gara-gara', 'alasan', 'lantaran'].includes(cue)) {
            extractedReason = cue;
            break;
          }
        }
      }

      if (!extractedReason) {
        extractedReason = text.trim();
      }
    }
  }

  return {
    isWoClaim: true,
    isGeneralQuestion: false,
    hasReason: Boolean(hasReasonCue && extractedReason && extractedReason.length >= 3),
    extractedReason: extractedReason ? extractedReason.charAt(0).toUpperCase() + extractedReason.slice(1) : undefined,
    matchMention,
  };
}

/**
 * Resolves fixture and participating teams for a WO claim.
 */
export async function resolveFixtureForWoClaim(
  db: Client,
  reportingDelegateId: string | null,
  text: string,
  intent: WoIntentResult
): Promise<{
  fixture?: any;
  tournamentId?: string;
  tournamentName?: string;
  reportingTeam?: { id: string; name: string };
  forfeitingTeam?: { id: string; name: string };
  error?: string;
}> {
  // 1. Get active tournament
  const tournamentRes = await db.execute(
    "SELECT id, name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1"
  );
  if (tournamentRes.rows.length === 0) {
    return { error: '⚠️ Tidak ada turnamen yang sedang aktif saat ini.' };
  }
  const tournamentId = String(tournamentRes.rows[0].id ?? tournamentRes.rows[0][0]);
  const tournamentName = String(tournamentRes.rows[0].name ?? tournamentRes.rows[0][1]);

  // 2. Resolve by match number if specified
  if (intent.matchMention) {
    const fixtureRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.round_code,
               f.team_a_id, f.team_b_id, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        WHERE f.tournament_id = ? AND (f.round_code LIKE ? OR f.id = ?)
        LIMIT 1
      `,
      args: [tournamentId, `%${intent.matchMention}%`, String(intent.matchMention)],
    });

    if (fixtureRes.rows.length > 0) {
      const fix = fixtureRes.rows[0] as any;
      if (['COMPLETED', 'WALKOVER'].includes(fix.status)) {
        return {
          error: `⚠️ Pertandingan (*${fix.team_a_name}* vs *${fix.team_b_name}*) sudah berstatus *${fix.status}*.`,
        };
      }

      // Check which team is reporting vs forfeiting
      let reportingTeam = { id: fix.team_a_id, name: fix.team_a_name };
      let forfeitingTeam = { id: fix.team_b_id, name: fix.team_b_name };

      const lowerText = text.toLowerCase();
      if (lowerText.includes(fix.team_a_name.toLowerCase())) {
        forfeitingTeam = { id: fix.team_a_id, name: fix.team_a_name };
        reportingTeam = { id: fix.team_b_id, name: fix.team_b_name };
      } else if (lowerText.includes(fix.team_b_name.toLowerCase())) {
        forfeitingTeam = { id: fix.team_b_id, name: fix.team_b_name };
        reportingTeam = { id: fix.team_a_id, name: fix.team_a_name };
      }

      return {
        fixture: fix,
        tournamentId,
        tournamentName,
        reportingTeam,
        forfeitingTeam,
      };
    }
  }

  // 3. Resolve by reporting delegate's registered team
  let delegateTeamId: string | null = null;
  let delegateTeamName: string | null = null;
  if (reportingDelegateId) {
    const delRes = await db.execute({
      sql: 'SELECT t.id, t.team_name as name FROM teams t WHERE t.delegate_id = ?',
      args: [reportingDelegateId],
    });
    if (delRes.rows.length > 0) {
      delegateTeamId = String(delRes.rows[0].id ?? delRes.rows[0][0]);
      delegateTeamName = String(delRes.rows[0].name ?? delRes.rows[0][1]);
    }
  }

  if (delegateTeamId && delegateTeamName) {
    const fixtureRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.round_code,
               f.team_a_id, f.team_b_id, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        WHERE f.tournament_id = ? AND (f.team_a_id = ? OR f.team_b_id = ?)
          AND f.status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
        ORDER BY f.created_at ASC
        LIMIT 1
      `,
      args: [tournamentId, delegateTeamId, delegateTeamId],
    });

    if (fixtureRes.rows.length > 0) {
      const fix = fixtureRes.rows[0] as any;
      const isTeamA = fix.team_a_id === delegateTeamId;
      const reportingTeam = isTeamA
        ? { id: fix.team_a_id, name: fix.team_a_name }
        : { id: fix.team_b_id, name: fix.team_b_name };
      const forfeitingTeam = isTeamA
        ? { id: fix.team_b_id, name: fix.team_b_name }
        : { id: fix.team_a_id, name: fix.team_a_name };

      return {
        fixture: fix,
        tournamentId,
        tournamentName,
        reportingTeam,
        forfeitingTeam,
      };
    }
  }

  // 4. Resolve by team name mentioned in text
  // FIX2-WO-002: this fallback previously let ANY group member stage a WO claim
  // on behalf of an unrelated team. Now the sender must be a verified delegate
  // of the reporting team before the claim is staged; the organizer "!ok" gate
  // remains as a second layer.
  const teamsRes = await db.execute({
    sql: 'SELECT id, team_name as name, delegate_id FROM teams WHERE tournament_id = ?',
    args: [tournamentId],
  });

  const lowerText = text.toLowerCase();
  const matchedTeams = (teamsRes.rows as unknown as { id: string; name: string; delegate_id: string | null }[]).filter(
    (t) => lowerText.includes(t.name.toLowerCase())
  );

  if (matchedTeams.length > 0) {
    const team = matchedTeams[0];

    // Sender must be a verified delegate; which team they belong to is
    // validated below against the reporting side of the resolved fixture.
    if (!reportingDelegateId) {
      return {
        error: [
          '⚠️ *Klaim WO Tidak Dapat Diproses*',
          '',
          'Hanya delegasi resmi tim yang dapat mengajukan klaim walkover atas nama timnya.',
          'Identitas Anda belum terverifikasi sebagai delegasi terdaftar.',
          '',
          '💡 _Jika Anda adalah delegasi resmi, hubungi Panitia untuk verifikasi identitas. Panitia juga dapat mencatat WO langsung via *!claimwo*._',
        ].join('\n'),
      };
    }

    const fixtureRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.round_code,
               f.team_a_id, f.team_b_id, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        WHERE f.tournament_id = ? AND (f.team_a_id = ? OR f.team_b_id = ?)
          AND f.status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
        ORDER BY f.created_at ASC
        LIMIT 1
      `,
      args: [tournamentId, team.id, team.id],
    });

    if (fixtureRes.rows.length > 0) {
      const fix = fixtureRes.rows[0] as any;
      // The mentioned team is usually the one being claimed against (forfeiting)
      const isTeamA = fix.team_a_id === team.id;
      const forfeitingTeam = isTeamA
        ? { id: fix.team_a_id, name: fix.team_a_name }
        : { id: fix.team_b_id, name: fix.team_b_name };
      const reportingTeam = isTeamA
        ? { id: fix.team_b_id, name: fix.team_b_name }
        : { id: fix.team_a_id, name: fix.team_a_name };

      // FIX2-WO-002: the sender must be the verified delegate of the REPORTING
      // team (the team benefiting from the claim), not just any delegate.
      const reportingTeamRes = await db.execute({
        sql: 'SELECT delegate_id FROM teams WHERE id = ?',
        args: [reportingTeam.id],
      });
      const reportingDelegate = reportingTeamRes.rows.length > 0
        ? (reportingTeamRes.rows[0].delegate_id ? String((reportingTeamRes.rows[0] as any).delegate_id) : null)
        : null;

      if (!reportingDelegate || reportingDelegate !== reportingDelegateId) {
        return {
          error: [
            '⚠️ *Klaim WO Tidak Dapat Diproses*',
            '',
            `Anda bukan delegasi resmi dari tim *${reportingTeam.name}* (tim yang mengajukan klaim).`,
            'Klaim walkover hanya dapat diajukan oleh delegasi tim yang terlibat dalam pertandingan ini.',
            '',
            '💡 _Panitia dapat mencatat WO langsung via *!claimwo* bila diperlukan._',
          ].join('\n'),
        };
      }

      return {
        fixture: fix,
        tournamentId,
        tournamentName,
        reportingTeam,
        forfeitingTeam,
      };
    }
  }

  return {
    error: [
      '⚠️ *Pertandingan Tidak Ditemukan*',
      '',
      'Pertandingan untuk klaim WO tidak dapat diidentifikasi secara otomatis.',
      'Mohon sebutkan nama tim lawan atau nomor match yang jelas.',
      'Contoh: _"Min, kami klaim WO untuk Match 1 lawan Garuda FC karena tidak hadir 15 menit."_',
    ].join('\n'),
  };
}

/**
 * Manages pending Walkover (WO) claims waiting for organizer "!ok".
 */
export class WoClaimSessionManager {
  private pendingSessions = new Map<string, PendingWoClaim>();
  private readonly defaultTTLMs = 15 * 60 * 1000; // 15 minutes

  private sessionKey(chatId: string): string {
    return chatId.trim().toLowerCase();
  }

  public stagePendingClaim(claim: PendingWoClaim): void {
    const key = this.sessionKey(claim.chatId);
    this.pendingSessions.set(key, claim);
  }

  public getPending(chatId: string): PendingWoClaim | null {
    const key = this.sessionKey(chatId);
    const pending = this.pendingSessions.get(key);
    if (!pending) return null;

    if (Date.now() > pending.expiresAt) {
      this.pendingSessions.delete(key);
      return null;
    }
    return pending;
  }

  public hasPending(chatId: string): boolean {
    return this.getPending(chatId) !== null;
  }

  public clearPending(chatId: string): void {
    const key = this.sessionKey(chatId);
    this.pendingSessions.delete(key);
  }

  public formatClaimPrompt(claim: PendingWoClaim, organizerPhone?: string): string {
    const roundInfo = claim.roundCode ? ` ${claim.roundCode}` : '';
    const orgTag = organizerPhone ? `@${organizerPhone.replace(/\D/g, '')}` : 'Panitia';

    return [
      `📌 *PENGAJUAN KLAIM WALKOVER (WO)*`,
      `──────────────────────────────`,
      `🏆 *Turnamen:* ${claim.tournamentName}`,
      `⚔️ *Pertandingan:* [${claim.stage}${roundInfo}] *${claim.teamAName}* vs *${claim.teamBName}*`,
      ``,
      `📋 *Tim Pelapor:* *${claim.reportingTeamName}*`,
      `⚠️ *Tim Terlapor (Kalah WO):* *${claim.forfeitingTeamName}*`,
      `📝 *Alasan:* ${claim.reason}`,
      `──────────────────────────────`,
      `⏳ *Menunggu Persetujuan Panitia:*`,
      `Panitia (${orgTag}) mohon periksa bukti klaim ini.`,
      `• Balas *!ok* atau *!confirm* untuk mengesahkan WO (skor 3–0 untuk ${claim.reportingTeamName}).`,
      `• Balas *!batal* atau *!reject* untuk menolak pengajuan ini.`,
    ].join('\n');
  }

  public async confirmPending(
    db: Client,
    chatId: string,
    _organizerId: string
  ): Promise<{
    success: boolean;
    replyText?: string;
    error?: string;
    fixtureId?: string;
    winningTeamName?: string;
    losingTeamName?: string;
  }> {
    const pending = this.getPending(chatId);
    if (!pending) {
      return {
        success: false,
        error: '⚠️ Tidak ada pengajuan klaim WO yang sedang menunggu konfirmasi.',
      };
    }

    try {
      const outcome = await handleSingleForfeit(
        db,
        pending.fixtureId,
        pending.forfeitingTeamId,
        pending.reason
      );

      if (pending.groupId) {
        await recalculateAndPersistGroupStandings(db, pending.tournamentId, pending.groupId);
      }

      this.clearPending(chatId);

      const replyText = [
        `✅ *KLAIM WALKOVER (WO) DISAHKAN OLEH PANITIA*`,
        `──────────────────────────────`,
        `🏆 *Turnamen:* ${pending.tournamentName}`,
        `⚔️ *Pertandingan:* *${pending.teamAName}* vs *${pending.teamBName}*`,
        ``,
        `⚠️ *Tim Forfeit / Kalah WO:* ${pending.forfeitingTeamName} (0 Poin)`,
        `🎉 *Pemenang WO:* *${pending.reportingTeamName}* (*+3 Poin*)`,
        `📊 *Skor Resmi:* ${outcome.score.team_a_score}–${outcome.score.team_b_score}`,
        `📝 *Alasan:* ${pending.reason}`,
        `👤 *Disahkan oleh:* Panitia Turnamen`,
        `──────────────────────────────`,
        `📈 *Klasemen grup telah otomatis diperbarui.*`,
        `💡 Ketik *!standings* untuk melihat klasemen terbaru.`,
      ].join('\n');

      return {
        success: true,
        replyText,
        fixtureId: pending.fixtureId,
        winningTeamName: pending.reportingTeamName,
        losingTeamName: pending.forfeitingTeamName,
      };
    } catch (err) {
      return {
        success: false,
        error: `Gagal memproses klaim WO: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public rejectPending(chatId: string): { success: boolean; replyText: string } {
    const pending = this.getPending(chatId);
    if (!pending) {
      return {
        success: false,
        replyText: '⚠️ Tidak ada pengajuan klaim WO yang sedang menunggu persetujuan.',
      };
    }

    this.clearPending(chatId);

    return {
      success: true,
      replyText: [
        `❌ *PENGAJUAN KLAIM WALKOVER (WO) DITOLAK*`,
        `──────────────────────────────`,
        `Pengajuan klaim WO untuk pertandingan *${pending.teamAName} vs ${pending.teamBName}* telah dibatalkan / ditolak oleh Panitia.`,
        `Pertandingan dapat dilanjutkan atau dijadwalkan ulang sesuai kesepakatan.`,
      ].join('\n'),
    };
  }
}
