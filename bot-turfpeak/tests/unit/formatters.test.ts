import { describe, it, expect } from 'vitest';
import {
  formatMatchReportSummary,
  formatStandingsTable,
  formatDrawRevealStep,
  formatDrawCompletedSummary,
  formatAwardsAnnouncement,
  formatFixturesSchedule,
} from '../../src/whatsapp/formatters.js';
import {
  formatAIFailureMessage,
  formatGoalkeeperSuspendedMessage,
  STANDARD_FAILURE_TEXT_EN,
  STANDARD_FAILURE_TEXT_ID,
} from '../../src/whatsapp/failure.js';
import type { StandingWithTeamName } from '../../src/competition/standings.js';
import type { TournamentAwardsSummary } from '../../src/stats/awards.js';

describe('Fase 6: WhatsApp Message Formatters & Failure Handlers', () => {
  describe('formatMatchReportSummary', () => {
    it('formats a [DRAFT] summary with "Perlu konfirmasi" for uncertain values and correction guidance', () => {
      const summary = formatMatchReportSummary({
        status: 'DRAFT',
        versionNumber: 1,
        teamAName: 'Astra Lumina',
        teamBName: 'Celestial FC',
        teamAScore: 3,
        teamBScore: null, // Uncertain score
        teamAPlayers: [
          { ordinal: 1, nickname: 'FlashStriker', goals: 2, assists: 1, defense: 3 },
          { ordinal: 2, nickname: 'SpeedyWing', goals: 1, assists: 'Perlu konfirmasi', defense: 2 },
        ],
        teamBPlayers: [
          { ordinal: 1, nickname: 'ShadowKeeper', goals: 0, assists: 0, saves: 'Perlu konfirmasi' },
        ],
        uncertainties: ['Skor tim B tidak terbaca jelas pada screenshot'],
      });

      expect(summary).toContain('⚽ *LAPORAN PERTANDINGAN* [DRAFT]');
      expect(summary).toContain('_Versi 1_');
      expect(summary).toContain('*Astra Lumina*  3 - Perlu konfirmasi  *Celestial FC*');
      expect(summary).toContain('1. *FlashStriker* (Gol: 2, Ast: 1, Def: 3)');
      expect(summary).toContain('2. *SpeedyWing* (Gol: 1, Ast: Perlu konfirmasi, Def: 2)');
      expect(summary).toContain('1. *ShadowKeeper* (Gol: 0, Ast: 0, Saves: Perlu konfirmasi)');
      expect(summary).toContain('⚠️ *Perhatian / Perlu Konfirmasi:*');
      expect(summary).toContain('💬 *Aksi Koreksi:*');
      expect(summary).not.toContain('OFFICIAL');
    });

    it('formats a [PENDING_APPROVAL] summary with missing approvers list', () => {
      const summary = formatMatchReportSummary({
        status: 'PENDING_APPROVAL',
        versionNumber: 2,
        teamAName: 'Alpha',
        teamBName: 'Beta',
        teamAScore: 2,
        teamBScore: 1,
        teamAPlayers: [{ ordinal: 1, nickname: 'P1', goals: 2, assists: 0 }],
        teamBPlayers: [{ ordinal: 1, nickname: 'P2', goals: 1, assists: 0 }],
        pendingApprovers: ['TEAM_A', 'TEAM_B', 'ORGANIZER'],
      });

      expect(summary).toContain('[PENDING APPROVAL]');
      expect(summary).toContain('✍️ *Menunggu Persetujuan:*');
      expect(summary).toContain('Menunggu: *Delegasi Alpha, Delegasi Beta, Organizer*');
      expect(summary).toContain('Ketik *!approve* untuk menyetujui');
    });

    it('formats an [OFFICIAL] locked report summary', () => {
      const summary = formatMatchReportSummary({
        status: 'OFFICIAL',
        versionNumber: 2,
        teamAName: 'Team X',
        teamBName: 'Team Y',
        teamAScore: 4,
        teamBScore: 2,
        teamAPlayers: [{ ordinal: 1, nickname: 'PX', goals: 4, assists: 0 }],
        teamBPlayers: [{ ordinal: 1, nickname: 'PY', goals: 2, assists: 0 }],
      });

      expect(summary).toContain('[OFFICIAL]');
      expect(summary).toContain('🔒 *Hasil Resmi Terkunci (OFFICIAL)*');
      expect(summary).toContain('Statistik dan klasemen telah diperbarui.');
    });
  });

  describe('formatStandingsTable', () => {
    it('formats monospace standings table with properly aligned columns', () => {
      const mockStandings: StandingWithTeamName[] = [
        {
          tournament_id: 't-1',
          group_id: 'g-1',
          team_id: 'team-1',
          team_name: 'Astra Lumina',
          rank: 1,
          played: 4,
          wins: 3,
          draws: 1,
          losses: 0,
          goals_for: 9,
          goals_against: 2,
          goal_difference: 7,
          points: 10,
          head_to_head_points: 0,
          computed_at: new Date().toISOString(),
          source_revision: 'rev-1',
        },
        {
          tournament_id: 't-1',
          group_id: 'g-1',
          team_id: 'team-2',
          team_name: 'Blaze Titans',
          rank: 2,
          played: 4,
          wins: 2,
          draws: 1,
          losses: 1,
          goals_for: 6,
          goals_against: 4,
          goal_difference: 2,
          points: 7,
          head_to_head_points: 0,
          computed_at: new Date().toISOString(),
          source_revision: 'rev-1',
        },
      ];

      const formatted = formatStandingsTable('A', mockStandings);

      expect(formatted).toContain('📊 *KLASEMEN GRUP A*');
      expect(formatted).toContain('1️⃣ *Astra Lumina* — *10 Poin*');
      expect(formatted).toContain('4 Main | 3M 1S 0K | SG +7 (9-2)');
      expect(formatted).toContain('2️⃣ *Blaze Titans* — *7 Poin*');
      expect(formatted).toContain('4 Main | 2M 1S 1K | SG +2 (6-4)');
      expect(formatted).toContain('Top 2 tim lolos');
    });
  });

  describe('formatDrawRevealStep & formatDrawCompletedSummary', () => {
    it('formats draw reveal step with seed verification', () => {
      const revealMsg = formatDrawRevealStep({
        tournamentTitle: 'Flash Peak Tour Season 1',
        stepIndex: 3,
        totalSteps: 10,
        teamName: 'Cyber Phoenix',
        groupCode: 'B',
        seedReveal: 'abcdef1234567890abcdef1234567890',
      });

      expect(revealMsg).toContain('🎲 *PENGUNDIAN GRUP — FLASH PEAK TOUR SEASON 1*');
      expect(revealMsg).toContain('Undian ke-3 dari 10');
      expect(revealMsg).toContain('Tim: *Cyber Phoenix*');
      expect(revealMsg).toContain('Masuk ke: *GRUP B*');
      expect(revealMsg).toContain('Seed Verifikasi: abcdef1234567890');
    });

    it('formats completed draw summary with commitment hash', () => {
      const completed = formatDrawCompletedSummary(
        'Flash Peak Tour Season 1',
        [
          { groupCode: 'A', teams: [{ teamId: '1', teamName: 'Team 1' }, { teamId: '2', teamName: 'Team 2' }] },
          { groupCode: 'B', teams: [{ teamId: '3', teamName: 'Team 3' }, { teamId: '4', teamName: 'Team 4' }] },
        ],
        'sha256-hash-commitment-xyz'
      );

      expect(completed).toContain('🎉 *HASIL LENGKAP PENGUNDIAN GRUP*');
      expect(completed).toContain('📌 *GRUP A*');
      expect(completed).toContain('1. Team 1');
      expect(completed).toContain('📌 *GRUP B*');
      expect(completed).toContain('*Commitment Hash:* `sha256-hash-commitment-xyz`');
    });
  });

  describe('formatAwardsAnnouncement', () => {
    it('formats awards announcement with co-winners and defining metrics', () => {
      const mockAwards: TournamentAwardsSummary = {
        tournamentId: 't-awards',
        goldenBoot: {
          awardKey: 'GOLDEN_BOOT',
          title: 'Golden Boot',
          definingMetric: 'total_goals',
          winners: [
            { playerId: 'p1', nicknameRaw: 'Ace', teamId: 't1', teamName: 'Team 1', metricValue: 8, gamesPlayed: 4 },
            { playerId: 'p2', nicknameRaw: 'Blade', teamId: 't2', teamName: 'Team 2', metricValue: 8, gamesPlayed: 4 },
          ],
          isTie: true,
          isOverride: false,
        },
        topAssist: {
          awardKey: 'TOP_ASSIST',
          title: 'Top Assist',
          definingMetric: 'total_assists',
          winners: [
            { playerId: 'p3', nicknameRaw: 'PassMaster', teamId: 't1', teamName: 'Team 1', metricValue: 6, gamesPlayed: 4 },
          ],
          isTie: false,
          isOverride: false,
        },
        bestDefender: {
          awardKey: 'BEST_DEFENDER',
          title: 'Best Defender',
          definingMetric: 'total_defense_raw',
          winners: [
            { playerId: 'p4', nicknameRaw: 'Shield', teamId: 't2', teamName: 'Team 2', metricValue: 15, gamesPlayed: 4 },
          ],
          isTie: false,
          isOverride: false,
        },
        bestWinningGoalkeeper: {
          awardKey: 'BEST_WINNING_GOALKEEPER',
          title: 'Best Winning Goalkeeper',
          definingMetric: 'award_eligible_saves',
          winners: [
            { playerId: 'p5', nicknameRaw: 'Wall', teamId: 't1', teamName: 'Team 1', metricValue: 12, gamesPlayed: 4 },
          ],
          isTie: false,
          isOverride: false,
        },
        computedAt: new Date().toISOString(),
      };

      const announcement = formatAwardsAnnouncement('Flash Peak Cup', mockAwards);

      expect(announcement).toContain('🏆 *PENGHARGAAN INDIVIDU — FLASH PEAK CUP* 🏆');
      expect(announcement).toContain('🥇 *GOLDEN BOOT* (Pencetak Gol Terbanyak)');
      expect(announcement).toContain('🤝 *Pemenang Bersama (Co-Winners) — 8 Gol:*');
      expect(announcement).toContain('• *Ace* (Team 1)');
      expect(announcement).toContain('• *Blade* (Team 2)');
      expect(announcement).toContain('🎯 *TOP ASSIST* (Pemberi Assist Terbanyak)');
      expect(announcement).toContain('👑 *PassMaster* (Team 1)');
      expect(announcement).toContain('Total: *6 Assist*');
      expect(announcement).toContain('🛡️ *BEST DEFENDER*');
      expect(announcement).toContain('🧤 *BEST WINNING GOALKEEPER* (Pertahanan / Kiper Tim Terbaik)');
      expect(announcement).toContain('👑 Tim: *Team 1*');
      expect(announcement).toContain('🧤 Kiper Utama: *Wall*');
      expect(announcement).toContain('Penghargaan kiper dianugerahkan kepada Tim mewakili seluruh rotasi kiper');
    });
  });

  describe('formatAIFailureMessage (FR-FAIL-002 & PROMPT_CATALOG.md §9)', () => {
    it('formats AI failure message adhering to PROMPT_CATALOG.md §9 rules', () => {
      const msgEn = formatAIFailureMessage({ language: 'en', fixtureCode: 'FIX-01' });
      expect(msgEn).toContain('Automated screenshot processing is temporarily unavailable.');
      expect(msgEn).toContain('The report has not been confirmed or changed.');
      expect(msgEn).toContain('Please contact the tournament organizer for manual verification.');
      // Must NOT claim accepted, rejected, or official
      expect(msgEn).not.toContain('accepted');
      expect(msgEn).not.toContain('rejected');
      expect(msgEn).not.toContain('official');

      const msgId = formatAIFailureMessage({ language: 'id', sessionId: 'sess-12345678' });
      expect(msgId).toContain('Pemrosesan Tangkapan Layar Otomatis Sementara Tidak Tersedia');
      expect(msgId).toContain('Laporan pertandingan belum dikonfirmasi atau diubah.');
      expect(msgId).toContain('Status pertandingan TIDAK resmi, TIDAK diterima, dan TIDAK ditolak.');
      expect(msgId).toContain('Silakan hubungi penyelenggara turnamen');
      expect(msgId).toContain('`sess-123`');
    });

    it('includes admin command hint when requested', () => {
      const msgWithHint = formatAIFailureMessage({
        includeAdminCommandHint: true,
        organizerPhone: '+6281234567890',
      });
      expect(msgWithHint).toContain('!manualreport');
      expect(msgWithHint).toContain('wa.me/6281234567890');
    });
  });

  describe('formatFixturesSchedule (Pathway #11)', () => {
    it('formats group fixture kickoff schedule cleanly', () => {
      const schedule = formatFixturesSchedule('Flash Peak Season 1', [
        {
          roundCode: 'ROUND_1',
          groupCode: 'A',
          teamAName: 'Garuda FC',
          teamBName: 'Harimau FC',
          leftSideHostName: 'Garuda FC',
        },
        {
          roundCode: 'ROUND_1',
          groupCode: 'B',
          teamAName: 'Elang FC',
          teamBName: 'Badak FC',
          leftSideHostName: 'Elang FC',
        },
      ]);

      expect(schedule).toContain('JADWAL PERTANDINGAN — FLASH PEAK SEASON 1');
      expect(schedule).toContain('GRUP A');
      expect(schedule).toContain('Garuda FC* vs *Harimau FC* (Host: Garuda FC)');
      expect(schedule).toContain('GRUP B');
      expect(schedule).toContain('Elang FC* vs *Badak FC* (Host: Elang FC)');
      expect(schedule).toContain('Tim kiri bertindak sebagai Host Room');
    });

    it('formats completed and walkover matches with checkmarks and scores', () => {
      const schedule = formatFixturesSchedule('Flash Peak Season 1', [
        {
          roundCode: 'ROUND_1',
          groupCode: 'A',
          teamAName: 'Garuda FC',
          teamBName: 'Harimau FC',
          leftSideHostName: 'Garuda FC',
          status: 'COMPLETED',
          teamAScore: 6,
          teamBScore: 2,
        },
        {
          roundCode: 'ROUND_1',
          groupCode: 'A',
          teamAName: 'Singa FC',
          teamBName: 'Kucing FC',
          leftSideHostName: 'Singa FC',
          status: 'WALKOVER',
          teamAScore: 3,
          teamBScore: 0,
          isWalkover: true,
        },
        {
          roundCode: 'ROUND_2',
          groupCode: 'A',
          teamAName: 'Harimau FC',
          teamBName: 'Singa FC',
          leftSideHostName: 'Harimau FC',
          status: 'SCHEDULED',
          teamADelegatePhone: '62812345678',
          teamBDelegatePhone: '62898765432',
        },
      ]);

      expect(schedule).toContain('✅ *Garuda FC*  6 - 2  *Harimau FC*');
      expect(schedule).toContain('✅ *Singa FC*  3 - 0  *Kucing FC* _(WO)_');
      expect(schedule).toContain('⏳ *Harimau FC* vs *Singa FC* (Host: Harimau FC)');
      expect(schedule).toContain('👤 @62812345678 vs @62898765432');
    });
  });

  describe('formatGoalkeeperSuspendedMessage', () => {
    it('formats a polite notification that goalkeeper statistics are suspended and not unreadable', () => {
      const msg = formatGoalkeeperSuspendedMessage({
        sessionId: 'a58f11e0-8364-43c7-b6d7-f4e09ac5b205',
        fixtureCode: 'ROUND_1 - GRUP A',
      });

      expect(msg).toContain('🧤 *Statistik Kiper Tidak Perlu Dikirim (Ditangguhkan)*');
      expect(msg).toContain('DITANGGUHKAN');
      expect(msg).toContain('tidak perlu dikirimkan lagi');
      expect(msg).toContain('!approve');
      expect(msg).toContain('Sesi: `a58f11e0`');
      expect(msg).not.toContain('Tidak Dapat Dibaca');
    });
  });
});
