/**
 * Flash Peak TMS - Guided Sequential Onboarding State Machine
 * 
 * Implements team-by-team sequential onboarding (FR-ON-001 - FR-ON-007),
 * reply binding to bot prompts, and duplicate delegate prevention.
 */

import type { Client } from '@libsql/client';
import { getDb } from '../db/client.js';
import type { IdentityResolver } from './resolver.js';
import type {
  NormalizedMessage,
} from '../whatsapp/types.js';
import type {
  Team,
  Delegate,
  UUID,
} from '../shared/types/index.js';

export interface OnboardingPromptResult {
  status: 'PROMPT_READY' | 'COMPLETED' | 'NO_TEAMS' | 'ERROR';
  team?: Team;
  promptText?: string;
  pendingCount: number;
  verifiedCount: number;
  totalTeams: number;
  message?: string;
}

export interface OnboardingReplyResult {
  status:
    | 'SUCCESS'
    | 'INVALID_REPLY_CONTEXT'
    | 'ALREADY_BOUND_ANOTHER_TEAM'
    | 'NO_ACTIVE_PROMPT'
    | 'ERROR';
  responseText: string;
  verifiedTeam?: Team;
  delegate?: Delegate;
  nextPrompt?: OnboardingPromptResult;
  isComplete?: boolean;
}

export class OnboardingService {
  private db: Client;
  private identityResolver: IdentityResolver;
  // In-memory tracking of active prompt per tournament (survives within process, reconstructible from DB)
  private activePrompts = new Map<
    string,
    {
      teamId: string;
      promptMessageKey: string;
      promptSentAt: string;
    }
  >();

  constructor(identityResolver: IdentityResolver, db?: Client) {
    this.identityResolver = identityResolver;
    this.db = db || getDb();
  }

  /**
   * Sets the active prompt key for a tournament's current pending team.
   */
  public setActivePrompt(tournamentId: UUID, teamId: UUID, promptMessageKey: string): void {
    this.activePrompts.set(tournamentId, {
      teamId,
      promptMessageKey,
      promptSentAt: new Date().toISOString(),
    });
  }

  /**
   * Returns current active prompt info.
   */
  public getActivePrompt(tournamentId: UUID) {
    return this.activePrompts.get(tournamentId) || null;
  }

  /**
   * Clears the active prompt for a tournament.
   */
  public clearActivePrompt(tournamentId: UUID): void {
    this.activePrompts.delete(tournamentId);
  }

  /**
   * Initiates or resumes sequential onboarding for a tournament.
   * Prompts team-by-team from the pre-registered list.
   */
  public async getNextOnboardingPrompt(tournamentId: UUID): Promise<OnboardingPromptResult> {
    // 1. Fetch all teams in tournament
    const allTeamsResult = await this.db.execute({
      sql: `SELECT id, tournament_id, organization_name, division_name, team_name, team_code, delegate_id, registration_status, created_at, updated_at
            FROM teams
            WHERE tournament_id = ?
            ORDER BY team_name ASC`,
      args: [tournamentId],
    });

    const teams: Team[] = allTeamsResult.rows.map((r) => ({
      id: String(r[0]),
      tournament_id: String(r[1]),
      organization_name: r[2] ? String(r[2]) : null,
      division_name: r[3] ? String(r[3]) : null,
      team_name: String(r[4]),
      team_code: r[5] ? String(r[5]) : null,
      delegate_id: r[6] ? String(r[6]) : null,
      registration_status: String(r[7]) as Team['registration_status'],
      created_at: String(r[8]),
      updated_at: String(r[9]),
    }));

    if (teams.length === 0) {
      return {
        status: 'NO_TEAMS',
        pendingCount: 0,
        verifiedCount: 0,
        totalTeams: 0,
        message: '⚠️ Belum ada tim yang terdaftar di database untuk turnamen ini.',
      };
    }

    const verifiedTeams = teams.filter((t) => t.registration_status === 'VERIFIED' && t.delegate_id);
    const pendingTeams = teams.filter((t) => t.registration_status === 'PENDING' || !t.delegate_id);

    if (pendingTeams.length === 0) {
      // Update tournament status to DRAW_READY
      await this.db.execute({
        sql: `UPDATE tournaments SET status = 'DRAW_READY', updated_at = ? WHERE id = ? AND status IN ('DRAFT', 'REGISTRATION', 'ONBOARDING')`,
        args: [new Date().toISOString(), tournamentId],
      });

      this.clearActivePrompt(tournamentId);

      return {
        status: 'COMPLETED',
        pendingCount: 0,
        verifiedCount: verifiedTeams.length,
        totalTeams: teams.length,
        message: `✅ *Onboarding Selesai!*\n\nSeluruh ${teams.length} tim telah memiliki delegate terverifikasi. Turnamen siap untuk tahap *!draw*.`,
      };
    }

    // Pick first pending team
    const nextTeam = pendingTeams[0];
    if (!nextTeam) {
      return {
        status: 'COMPLETED',
        pendingCount: 0,
        verifiedCount: verifiedTeams.length,
        totalTeams: teams.length,
      };
    }

    const divisionLabel = nextTeam.division_name ? ` (Divisi ${nextTeam.division_name})` : '';
    const orgLabel = nextTeam.organization_name ? `\n🏢 Organisasi: *${nextTeam.organization_name}*` : '';

    const promptText =
      `📋 *[ONBOARDING DELEGATE RESMI - FLASH PEAK TMS]*\n\n` +
      `⚽ Tim: *${nextTeam.team_name}*${divisionLabel}${orgLabel}\n` +
      `📊 Progres: *${verifiedTeams.length + 1} / ${teams.length} tim*\n\n` +
      `Kepada perwakilan/official delegate dari tim *${nextTeam.team_name}*, silakan *REPLY / BALAS* pesan ini sekarang untuk mengonfirmasi nomor WhatsApp Anda sebagai delegate resmi.\n\n` +
      `⚠️ *Penting:* Harus menggunakan fitur *Reply/Kutip* pesan ini secara langsung.`;

    return {
      status: 'PROMPT_READY',
      team: nextTeam,
      promptText,
      pendingCount: pendingTeams.length,
      verifiedCount: verifiedTeams.length,
      totalTeams: teams.length,
    };
  }

  /**
   * Processes an incoming message that may be a reply to an active onboarding prompt.
   */
  public async handleOnboardingReply(
    tournamentId: UUID,
    message: NormalizedMessage
  ): Promise<OnboardingReplyResult> {
    const active = this.getActivePrompt(tournamentId);
    if (!active) {
      return {
        status: 'NO_ACTIVE_PROMPT',
        responseText: 'Tidak ada sesi prompt onboarding yang sedang aktif.',
      };
    }

    // 1. Verify reply binding context (FR-ON-004)
    if (!message.reply_to_key || message.reply_to_key !== active.promptMessageKey) {
      return {
        status: 'INVALID_REPLY_CONTEXT',
        responseText:
          '⚠️ Pesan Anda bukan merupakan reply (balasan) dari pesan prompt resmi bot.\n' +
          'Silakan *REPLY/KUTIP* langsung pesan prompt onboarding di atas.',
      };
    }

    // Fetch team being prompted
    const teamRes = await this.db.execute({
      sql: `SELECT id, tournament_id, organization_name, division_name, team_name, team_code, delegate_id, registration_status, created_at, updated_at
            FROM teams WHERE id = ?`,
      args: [active.teamId],
    });

    if (teamRes.rows.length === 0 || !teamRes.rows[0]) {
      return {
        status: 'ERROR',
        responseText: 'Tim target untuk prompt ini tidak ditemukan di database.',
      };
    }

    const tRow = teamRes.rows[0];
    const team: Team = {
      id: String(tRow[0]),
      tournament_id: String(tRow[1]),
      organization_name: tRow[2] ? String(tRow[2]) : null,
      division_name: tRow[3] ? String(tRow[3]) : null,
      team_name: String(tRow[4]),
      team_code: tRow[5] ? String(tRow[5]) : null,
      delegate_id: tRow[6] ? String(tRow[6]) : null,
      registration_status: String(tRow[7]) as Team['registration_status'],
      created_at: String(tRow[8]),
      updated_at: String(tRow[9]),
    };

    // 2. Resolve or check sender identity
    const senderAddress = message.sender_raw_address;
    const addressType = message.address_type;
    const displayName = message.push_name || `Delegate ${team.team_name}`;

    const resolution = await this.identityResolver.resolveIdentity(senderAddress, message.chat_id);

    let delegate: Delegate;

    if (resolution.status === 'VERIFIED' && resolution.delegate) {
      delegate = resolution.delegate;

      // Duplicate prevention: check if this delegate is already assigned to ANOTHER team in this tournament
      if (resolution.team && resolution.team.id !== team.id && resolution.team.tournament_id === tournamentId) {
        return {
          status: 'ALREADY_BOUND_ANOTHER_TEAM',
          responseText:
            `⛔ Anda sudah terdaftar sebagai delegate resmi untuk tim *${resolution.team.team_name}*.\n` +
            `Satu delegate hanya boleh mewakili satu tim dalam satu turnamen (FR-ID-002).`,
        };
      }
    } else {
      // Create new delegate and link observed identity
      const created = await this.identityResolver.createDelegateWithIdentity(
        displayName,
        senderAddress,
        addressType,
        {
          sourceChatId: message.chat_id,
          isPrimary: true,
        }
      );
      delegate = created.delegate;
    }

    // If sender came in via a linked device (LID) and has a JID, ensure alias is linked
    if (message.participant && message.participant !== senderAddress) {
      try {
        await this.identityResolver.linkIdentity(
          delegate.id,
          message.participant,
          message.address_type,
          { sourceChatId: message.chat_id }
        );
      } catch {
        // Silently continue if already linked
      }
    }

    // 3. Bind delegate to team
    await this.identityResolver.bindDelegateToTeam(team.id, delegate.id);

    // 4. Update team record
    team.delegate_id = delegate.id;
    team.registration_status = 'VERIFIED';

    // Clear active prompt since it was successfully fulfilled
    this.clearActivePrompt(tournamentId);

    // 5. Check if there are further pending teams
    const nextPrompt = await this.getNextOnboardingPrompt(tournamentId);
    const isComplete = nextPrompt.status === 'COMPLETED';

    const confirmationText =
      `✅ *Konfirmasi Berhasil!*\n\n` +
      `Delegate: *${delegate.display_name}*\n` +
      `Tim: *${team.team_name}* ${team.division_name ? `(${team.division_name})` : ''}\n` +
      `Status: *TERVERIFIKASI*\n\n` +
      (isComplete
        ? `🎉 *Seluruh tim telah terverifikasi! Onboarding selesai.*`
        : `Melanjutkan ke tim berikutnya...`);

    return {
      status: 'SUCCESS',
      responseText: confirmationText,
      verifiedTeam: team,
      delegate,
      nextPrompt,
      isComplete,
    };
  }

  /**
   * Retrieves overall onboarding status for a tournament.
   */
  public async getOnboardingStatus(tournamentId: UUID): Promise<{
    totalTeams: number;
    verifiedCount: number;
    pendingCount: number;
    isComplete: boolean;
    pendingTeams: Team[];
    verifiedTeams: Team[];
  }> {
    const res = await this.db.execute({
      sql: `SELECT id, tournament_id, organization_name, division_name, team_name, team_code, delegate_id, registration_status, created_at, updated_at
            FROM teams
            WHERE tournament_id = ?
            ORDER BY team_name ASC`,
      args: [tournamentId],
    });

    const teams: Team[] = res.rows.map((r) => ({
      id: String(r[0]),
      tournament_id: String(r[1]),
      organization_name: r[2] ? String(r[2]) : null,
      division_name: r[3] ? String(r[3]) : null,
      team_name: String(r[4]),
      team_code: r[5] ? String(r[5]) : null,
      delegate_id: r[6] ? String(r[6]) : null,
      registration_status: String(r[7]) as Team['registration_status'],
      created_at: String(r[8]),
      updated_at: String(r[9]),
    }));

    const verifiedTeams = teams.filter((t) => t.registration_status === 'VERIFIED' && t.delegate_id);
    const pendingTeams = teams.filter((t) => t.registration_status === 'PENDING' || !t.delegate_id);

    return {
      totalTeams: teams.length,
      verifiedCount: verifiedTeams.length,
      pendingCount: pendingTeams.length,
      isComplete: teams.length > 0 && pendingTeams.length === 0,
      pendingTeams,
      verifiedTeams,
    };
  }
}
