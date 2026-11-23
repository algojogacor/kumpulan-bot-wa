/**
 * Flash Peak TMS - Manual Report Session & Confirmation Manager
 * 
 * Manages the two-step confirmation state (FR-FAIL-003, FR-FAIL-004) to ensure
 * fuzzy-matched nickname guesses are never committed directly without explicit
 * organizer review and confirmation.
 */

import type { Client } from '@libsql/client';
import type { Player } from '../shared/types/index.js';
import type { RawPlayerMatchStat } from '../reports/validation.js';
import { handleManualReport } from '../reports/manual.js';
import {
  formatMatchReportSummary,
} from '../whatsapp/formatters.js';
import {
  matchScorerToRoster,
  buildLineupWithScorers,
  parseScorerList,
} from '../reports/manual-parser.js';

export interface MatchedScorerDetail {
  inputName: string;
  matchedNickname: string;
  playerId: string;
  goals: number;
  similarity: number;
}

export interface PendingManualReport {
  fixtureId: string;
  gameId?: string;
  scoreA: number;
  scoreB: number;
  teamAId: string;
  teamBId: string;
  teamAName: string;
  teamBName: string;
  teamAPlayers: RawPlayerMatchStat[];
  teamBPlayers: RawPlayerMatchStat[];
  rosterA: Player[];
  rosterB: Player[];
  matchedDetailsA: MatchedScorerDetail[];
  matchedDetailsB: MatchedScorerDetail[];
  unassignedGoalsA: number;
  unassignedGoalsB: number;
  notes?: string;
  organizerId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
}

export class ManualReportSessionManager {
  private pendingSessions = new Map<string, PendingManualReport>();
  private readonly defaultTTLMs = 15 * 60 * 1000; // 15 minutes

  private sessionKey(chatId: string, organizerId?: string): string {
    const normChat = chatId.trim().toLowerCase();
    // In groups, also partition by organizer address if provided
    if (organizerId && normChat.endsWith('@g.us')) {
      const normSender = organizerId.trim().toLowerCase();
      return `${normChat}::${normSender}`;
    }
    return normChat;
  }

  public stagePendingReport(pending: PendingManualReport): void {
    const key = this.sessionKey(pending.chatId, pending.organizerId);
    this.pendingSessions.set(key, pending);
    // Also set fallback key on chatId alone for easy resolution
    if (pending.chatId.endsWith('@g.us')) {
      this.pendingSessions.set(pending.chatId.toLowerCase(), pending);
    }
  }

  public getPending(chatId: string, organizerId?: string): PendingManualReport | null {
    const keyWithSender = this.sessionKey(chatId, organizerId);
    const session = this.pendingSessions.get(keyWithSender) || this.pendingSessions.get(chatId.toLowerCase());

    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.clearPending(chatId, organizerId);
      return null;
    }

    return session;
  }

  public hasPending(chatId: string, organizerId?: string): boolean {
    return this.getPending(chatId, organizerId) !== null;
  }

  public clearPending(chatId: string, organizerId?: string): void {
    const keyWithSender = this.sessionKey(chatId, organizerId);
    this.pendingSessions.delete(keyWithSender);
    this.pendingSessions.delete(chatId.toLowerCase());
  }

  /**
   * Formats the confirmation prompt for the organizer to review.
   */
  public formatConfirmationPrompt(pending: PendingManualReport): string {
    const lines: string[] = [];

    const isUnassigned = pending.unassignedGoalsA > 0 || pending.unassignedGoalsB > 0;
    const isZeroZero = pending.scoreA === 0 && pending.scoreB === 0;

    if (isZeroZero) {
      lines.push('🔍 *Konfirmasi Draf Laporan Manual (Skor Imbang Tanpa Gol)*');
      lines.push('──────────────────────────────');
      lines.push(`🏆 *Pertandingan:* ${pending.teamAName} vs ${pending.teamBName}`);
      lines.push(`📊 *Skor Akhir:* 0 - 0`);
      lines.push('──────────────────────────────');
      lines.push('⚠️ *Konfirmasi:*');
      lines.push('• Balas *OK* untuk membuat draf laporan pertandingan resmi.');
      lines.push('• Atau ketik ulang skor jika ada kesalahan.');
      return lines.join('\n');
    }

    if (isUnassigned) {
      lines.push('🔍 *Konfirmasi Draf Manual (Tanpa Rincian Pencetak Gol)*');
      lines.push('──────────────────────────────');
      lines.push(`🏆 *Pertandingan:* ${pending.teamAName} vs ${pending.teamBName}`);
      lines.push(`📊 *Skor:* ${pending.teamAName} *${pending.scoreA} - ${pending.scoreB}* ${pending.teamBName}`);
      lines.push('');
      lines.push('⚠️ *Peringatan Status Gol:*');
      if (pending.unassignedGoalsA > 0) {
        lines.push(`• *${pending.teamAName}:* ${pending.unassignedGoalsA} gol dicatat sebagai *TIDAK DIKETAHUI / UNASSIGNED*.`);
      }
      if (pending.unassignedGoalsB > 0) {
        lines.push(`• *${pending.teamBName}:* ${pending.unassignedGoalsB} gol dicatat sebagai *TIDAK DIKETAHUI / UNASSIGNED*.`);
      }
      lines.push('');
      lines.push('_Detail pencetak gol harus dilengkapi melalui koreksi sebelum laporan dapat disetujui (*!approve*) secara resmi._');
      lines.push('──────────────────────────────');
      lines.push('• Balas *OK* untuk melanjutkan pembuatan draf unassigned ini.');
      lines.push('• Atau sebutkan daftar pencetak gol (contoh: `gol A: nama1, nama2 | gol B: nama3`).');
      return lines.join('\n');
    }

    // Explicit scorers case
    lines.push('🔍 *Konfirmasi Pemadanan Nama Pencetak Gol (Manual Report)*');
    lines.push('──────────────────────────────');
    lines.push(`🏆 *Pertandingan:* ${pending.teamAName} vs ${pending.teamBName}`);
    lines.push(`📊 *Skor:* ${pending.teamAName} *${pending.scoreA} - ${pending.scoreB}* ${pending.teamBName}`);
    lines.push('');

    // Team A Scorers
    lines.push(`⚽ *Pencetak Gol ${pending.teamAName} (${pending.scoreA} Gol):*`);
    if (pending.matchedDetailsA.length === 0) {
      lines.push('  _(Tidak ada gol)_');
    } else {
      for (const m of pending.matchedDetailsA) {
        const matchIndicator = m.inputName.toLowerCase() === m.matchedNickname.toLowerCase()
          ? `*${m.matchedNickname}*`
          : `"${m.inputName}" → *${m.matchedNickname}*`;
        lines.push(`• ${matchIndicator} (${m.goals} gol)`);
      }
    }
    lines.push('');

    // Team B Scorers
    lines.push(`⚽ *Pencetak Gol ${pending.teamBName} (${pending.scoreB} Gol):*`);
    if (pending.matchedDetailsB.length === 0) {
      lines.push('  _(Tidak ada gol)_');
    } else {
      for (const m of pending.matchedDetailsB) {
        const matchIndicator = m.inputName.toLowerCase() === m.matchedNickname.toLowerCase()
          ? `*${m.matchedNickname}*`
          : `"${m.inputName}" → *${m.matchedNickname}*`;
        lines.push(`• ${matchIndicator} (${m.goals} gol)`);
      }
    }

    lines.push('');
    lines.push('──────────────────────────────');
    lines.push('⚠️ *Apakah nama pemain di atas sudah benar?*');
    lines.push('• Balas *OK* untuk membuat draf laporan pertandingan.');
    lines.push('• Atau balas dengan koreksi jika ada salah tangkap (contoh: *bukan lkyy tapi ChronosForward*).');

    return lines.join('\n');
  }

  /**
   * Applies an organizer's correction to a pending manual report.
   */
  public applyCorrection(
    chatId: string,
    organizerId: string,
    correctionText: string
  ): { success: boolean; updatedPrompt?: string; error?: string } {
    const pending = this.getPending(chatId, organizerId);
    if (!pending) {
      return {
        success: false,
        error: 'Tidak ada draf laporan manual yang sedang menunggu konfirmasi.',
      };
    }

    const text = correctionText.trim();

    // Check if organizer re-entered scorer lists (e.g. "gol A: ... | gol B: ...")
    const markerA = /(?:^|\n|\||\s)(?:gol\s*a|tim\s*a|team\s*a|\ba)\s*[:=]\s*/i;
    const markerB = /(?:^|\n|\||\s)(?:gol\s*b|tim\s*b|team\s*b|\bb)\s*[:=]\s*/i;

    if (markerA.test(text) || markerB.test(text)) {
      // Re-parse scorers using parseQuickReport logic
      let partA = '';
      let partB = '';

      const matchA = text.match(markerA);
      const matchB = text.match(markerB);

      if (matchA && matchB) {
        if (matchA.index! < matchB.index!) {
          partA = text.slice(matchA.index! + matchA[0].length, matchB.index!).replace(/\|$/, '').trim();
          partB = text.slice(matchB.index! + matchB[0].length).trim();
        } else {
          partB = text.slice(matchB.index! + matchB[0].length, matchA.index!).replace(/\|$/, '').trim();
          partA = text.slice(matchA.index! + matchA[0].length).trim();
        }
      } else if (matchA) {
        partA = text.slice(matchA.index! + matchA[0].length).trim();
      } else if (matchB) {
        partB = text.slice(matchB.index! + matchB[0].length).trim();
      }

      if (partA) {
        const rawScorersA = parseScorerList(partA);
        const totalA = rawScorersA.reduce((sum, s) => sum + s.goals, 0);
        if (totalA !== pending.scoreA) {
          return {
            success: false,
            error: `⚠️ Jumlah gol di daftar pencetak ${pending.teamAName} (${totalA}) tidak cocok dengan skor (${pending.scoreA}).`,
          };
        }
        const matchedA: MatchedScorerDetail[] = [];
        for (const item of rawScorersA) {
          const matchRes = matchScorerToRoster(item.name, pending.rosterA);
          if (!matchRes.player) {
            return { success: false, error: matchRes.error || `Pemain "${item.name}" tidak ditemukan di ${pending.teamAName}.` };
          }
          matchedA.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }
        pending.matchedDetailsA = matchedA;
        const lineupA = buildLineupWithScorers(pending.rosterA, matchedA, pending.scoreB, false);
        if (lineupA.error) return { success: false, error: lineupA.error };
        pending.teamAPlayers = lineupA.lineup;
        pending.unassignedGoalsA = 0;
      }

      if (partB) {
        const rawScorersB = parseScorerList(partB);
        const totalB = rawScorersB.reduce((sum, s) => sum + s.goals, 0);
        if (totalB !== pending.scoreB) {
          return {
            success: false,
            error: `⚠️ Jumlah gol di daftar pencetak ${pending.teamBName} (${totalB}) tidak cocok dengan skor (${pending.scoreB}).`,
          };
        }
        const matchedB: MatchedScorerDetail[] = [];
        for (const item of rawScorersB) {
          const matchRes = matchScorerToRoster(item.name, pending.rosterB);
          if (!matchRes.player) {
            return { success: false, error: matchRes.error || `Pemain "${item.name}" tidak ditemukan di ${pending.teamBName}.` };
          }
          matchedB.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }
        pending.matchedDetailsB = matchedB;
        const lineupB = buildLineupWithScorers(pending.rosterB, matchedB, pending.scoreA, false);
        if (lineupB.error) return { success: false, error: lineupB.error };
        pending.teamBPlayers = lineupB.lineup;
        pending.unassignedGoalsB = 0;
      }

      this.stagePendingReport(pending);
      return { success: true, updatedPrompt: this.formatConfirmationPrompt(pending) };
    }

    // Pattern: "bukan X tapi Y" or "koreksi X jadi Y" or "ganti X dengan Y"
    const replacePattern = /(?:bukan|koreksi|ganti)\s+(.+?)\s+(?:tapi|jadi|menjadi|dengan)\s+(.+)$/i;
    const matchReplace = text.match(replacePattern);

    if (matchReplace) {
      const oldName = matchReplace[1].trim();
      const newName = matchReplace[2].trim();

      // Find in Team A or Team B
      const idxA = pending.matchedDetailsA.findIndex(
        (m) =>
          m.inputName.toLowerCase() === oldName.toLowerCase() ||
          m.matchedNickname.toLowerCase().includes(oldName.toLowerCase())
      );
      const idxB = pending.matchedDetailsB.findIndex(
        (m) =>
          m.inputName.toLowerCase() === oldName.toLowerCase() ||
          m.matchedNickname.toLowerCase().includes(oldName.toLowerCase())
      );

      if (idxA !== -1) {
        const matchRes = matchScorerToRoster(newName, pending.rosterA);
        if (!matchRes.player) {
          return { success: false, error: matchRes.error || `Pemain "${newName}" tidak ditemukan di ${pending.teamAName}.` };
        }
        const existingGoals = pending.matchedDetailsA[idxA].goals;
        pending.matchedDetailsA[idxA] = {
          inputName: newName,
          matchedNickname: matchRes.player.nickname_raw,
          playerId: matchRes.player.id,
          goals: existingGoals,
          similarity: matchRes.similarity,
        };
        const lineupA = buildLineupWithScorers(pending.rosterA, pending.matchedDetailsA, pending.scoreB, false);
        if (lineupA.error) return { success: false, error: lineupA.error };
        pending.teamAPlayers = lineupA.lineup;
      } else if (idxB !== -1) {
        const matchRes = matchScorerToRoster(newName, pending.rosterB);
        if (!matchRes.player) {
          return { success: false, error: matchRes.error || `Pemain "${newName}" tidak ditemukan di ${pending.teamBName}.` };
        }
        const existingGoals = pending.matchedDetailsB[idxB].goals;
        pending.matchedDetailsB[idxB] = {
          inputName: newName,
          matchedNickname: matchRes.player.nickname_raw,
          playerId: matchRes.player.id,
          goals: existingGoals,
          similarity: matchRes.similarity,
        };
        const lineupB = buildLineupWithScorers(pending.rosterB, pending.matchedDetailsB, pending.scoreA, false);
        if (lineupB.error) return { success: false, error: lineupB.error };
        pending.teamBPlayers = lineupB.lineup;
      } else {
        return {
          success: false,
          error: `⚠️ Nama "${oldName}" tidak ditemukan di daftar tebakan pencetak gol sebelumnya.`,
        };
      }

      this.stagePendingReport(pending);
      return { success: true, updatedPrompt: this.formatConfirmationPrompt(pending) };
    }

    return {
      success: false,
      error: '⚠️ Format koreksi tidak dikenali. Gunakan contoh: `bukan lkyy tapi ChronosForward` atau sebutkan daftar pencetak baru: `gol A: ... | gol B: ...`.',
    };
  }

  /**
   * Confirms a pending manual report and creates the draft report version in the database.
   */
  public async confirmPending(
    db: Client,
    chatId: string,
    organizerId: string
  ): Promise<{ success: boolean; replyText?: string; error?: string }> {
    const pending = this.getPending(chatId, organizerId);
    if (!pending) {
      return {
        success: false,
        error: '⚠️ Tidak ada draf laporan manual yang sedang menunggu konfirmasi.',
      };
    }

    const allowUnassigned = pending.unassignedGoalsA > 0 || pending.unassignedGoalsB > 0;

    try {
      const res = await handleManualReport(db, {
        organizer_id: pending.organizerId,
        is_organizer: true,
        fixture_id: pending.fixtureId,
        game_id: pending.gameId,
        team_a_score: pending.scoreA,
        team_b_score: pending.scoreB,
        team_a_players: pending.teamAPlayers,
        team_b_players: pending.teamBPlayers,
        notes: pending.notes,
        allow_unassigned_goals: allowUnassigned,
      });

      if (!res.success || !res.version) {
        return {
          success: false,
          error: `⚠️ Gagal membuat draf laporan manual:\n${(res.errors || []).join('\n')}`,
        };
      }

      // Clear pending session once draft is created
      this.clearPending(chatId, organizerId);

      const uncertainties: string[] = [];
      if (pending.unassignedGoalsA > 0) {
        uncertainties.push(
          `⚠️ Terdapat ${pending.unassignedGoalsA} gol ${pending.teamAName} belum ditugaskan ke pencetak gol terdata.`
        );
      }
      if (pending.unassignedGoalsB > 0) {
        uncertainties.push(
          `⚠️ Terdapat ${pending.unassignedGoalsB} gol ${pending.teamBName} belum ditugaskan ke pencetak gol terdata.`
        );
      }

      const summaryText = formatMatchReportSummary({
        status: 'PENDING_APPROVAL',
        versionNumber: res.version.version_number,
        fixtureCode: pending.fixtureId,
        teamAName: pending.teamAName,
        teamBName: pending.teamBName,
        teamAScore: pending.scoreA,
        teamBScore: pending.scoreB,
        teamAPlayers: pending.teamAPlayers.map((p, idx) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          rating: p.rating,
          goals: p.goals ?? 0,
          assists: p.assists ?? 0,
          passes: p.passes,
          defense: p.defense_raw,
          saves: p.goalkeeper_saves,
        })),
        teamBPlayers: pending.teamBPlayers.map((p, idx) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          rating: p.rating,
          goals: p.goals ?? 0,
          assists: p.assists ?? 0,
          passes: p.passes,
          defense: p.defense_raw,
          saves: p.goalkeeper_saves,
        })),
        uncertainties: uncertainties.length > 0 ? uncertainties : undefined,
        pendingApprovers:
          pending.scoreA > pending.scoreB
            ? ['TEAM_A', 'ORGANIZER']
            : pending.scoreB > pending.scoreA
            ? ['TEAM_B', 'ORGANIZER']
            : ['TEAM_A', 'TEAM_B', 'ORGANIZER'],
      });

      return {
        success: true,
        replyText: summaryText,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `⚠️ Terjadi kesalahan saat memproses laporan manual: ${err.message}`,
      };
    }
  }
}
