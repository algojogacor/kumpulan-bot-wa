/**
 * Flash Peak TMS - WhatsApp Command Router & Authorizer
 * 
 * Handles command parsing, group scope enforcement (FR-ID-005), and role authorization.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type {
  NormalizedMessage,
  CommandContext,
  CommandResult,
  CommandDefinition,
  UserRole,
} from './types.js';
import type { IdentityResolver } from '../identity/resolver.js';
import pino from 'pino';

export interface CommandRouterConfig {
  centralGroupJid?: string;
  organizerJid?: string;
  organizerPhone?: string;
  identityResolver: IdentityResolver;
  logLevel?: pino.LevelWithSilent;
  onCentralGroupJidChange?: (jid: string) => void;
}

export class CommandRouter {
  private centralGroupJid: string;
  private organizerJid: string;
  private organizerPhone: string;
  private identityResolver: IdentityResolver;
  private commands: Map<string, CommandDefinition> = new Map();
  private logger: pino.Logger;
  private onCentralGroupJidChange?: (jid: string) => void;

  constructor(config: CommandRouterConfig) {
    this.centralGroupJid = jidNormalizedUser(
      config.centralGroupJid || process.env.WA_CENTRAL_GROUP_JID || ''
    );
    this.organizerJid = (config.organizerJid || process.env.WA_ORGANIZER_JID || '').trim();
    this.organizerPhone = (config.organizerPhone || process.env.WA_ORGANIZER_PHONE || '').replace(/\D/g, '');
    this.identityResolver = config.identityResolver;
    this.logger = pino({ level: config.logLevel || 'silent' });
    this.onCentralGroupJidChange = config.onCentralGroupJidChange;

    // Register built-in utility commands
    this.registerDefaultCommands();
  }

  public onGroupJidChanged(listener: (jid: string) => void): void {
    this.onCentralGroupJidChange = listener;
  }

  /**
   * FIX2-APR-003 (audit temuan 3.3): configured organizer identities as a
   * normalized list — normalized JIDs (comma-separated WA_ORGANIZER_JID) and
   * the raw phone digits (WA_ORGANIZER_PHONE). Used by the approval engine to
   * verify ORGANIZER-type authority against configuration instead of loose
   * string patterns on the approver id.
   *
   * AUDIT-VERIFY-T3 (21 Nov 2026): each phone-only identity is now expanded
   * with its canonical JID form (<digits>@s.whatsapp.net) and each JID with
   * its bare digits, so a deployment configured only via WA_ORGANIZER_PHONE
   * still matches the approver id (!approve passes the sender's full
   * normalized JID). Before this, phone-only configs rejected every
   * organizer approval because '628xxx@s.whatsapp.net' never equals '628xxx'.
   */
  public getOrganizerIdentities(): string[] {
    const ids: string[] = [];
    const pushUnique = (value: string) => {
      const v = value.trim().toLowerCase();
      if (v && !ids.includes(v)) ids.push(v);
    };
    for (const part of (this.organizerJid || '').split(',')) {
      const jid = part.trim().toLowerCase();
      if (jid) {
        pushUnique(jid);
        const digits = jid.split('@')[0]?.replace(/\D/g, '');
        if (digits) {
          pushUnique(digits);
          pushUnique(`${digits}@s.whatsapp.net`);
        }
      }
    }
    if (this.organizerPhone) {
      pushUnique(this.organizerPhone);
      pushUnique(`${this.organizerPhone}@s.whatsapp.net`);
    }
    return ids;
  }

  /**
   * Registers a command definition.
   */
  public registerCommand(definition: CommandDefinition): void {
    const cmd = definition.command.toLowerCase().trim().replace(/^!/, '');
    this.commands.set(cmd, {
      ...definition,
      command: cmd,
      allowedInDm: definition.allowedInDm ?? (definition.requiredRole === 'ORGANIZER'),
      allowedInGroup: definition.allowedInGroup ?? true,
    });
  }

  public setCentralGroupJid(jid: string): void {
    const normalized = jidNormalizedUser(jid);
    const changed = this.centralGroupJid !== normalized;
    this.centralGroupJid = normalized;
    if (changed && this.onCentralGroupJidChange) {
      this.onCentralGroupJidChange(normalized);
    }
  }

  public getCentralGroupJid(): string {
    return this.centralGroupJid;
  }

  /**
   * Checks whether a command name is registered.
   */
  public hasCommand(command: string): boolean {
    const cmd = command.toLowerCase().trim().replace(/^!/, '');
    return this.commands.has(cmd);
  }

  /**
   * Checks if an incoming message is a command (starts with '!').
   */
  public isCommand(message: NormalizedMessage): boolean {
    const text = (message.text_body || message.caption || '').trim();
    return text.startsWith('!') && text.length > 1;
  }

  /**
   * Parses command name and argument strings from message text.
   */
  public parseCommand(message: NormalizedMessage): { command: string; args: string[]; rawArgs: string } | null {
    const text = (message.text_body || message.caption || '').trim();
    if (!text.startsWith('!')) return null;

    const parts = text.slice(1).trim().split(/\s+/);
    const command = (parts[0] || '').toLowerCase();
    if (!command) return null;

    const args = parts.slice(1);
    const rawArgs = text.slice(1 + command.length).trim();

    return { command, args, rawArgs };
  }

  /**
   * Checks whether the message sender matches configured Organizer identities.
   */
  public isSenderOrganizer(message: NormalizedMessage): boolean {
    // BUGFIX-TS-002: sender_id never existed on NormalizedMessage (legacy
    // field name). sender_raw_address is required and guaranteed non-empty by
    // the normalizer (participant || remoteJid; messages without remoteJid are
    // dropped), so the fallback was dead code removed for type safety.
    const rawSender = message.sender_raw_address;
    const normalizedSender = (message.sender_normalized_address || jidNormalizedUser(rawSender) || '').toLowerCase();
    const organizerList = (this.organizerJid || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (
      organizerList.some(
        (target) =>
          normalizedSender === target ||
          (rawSender && rawSender.toLowerCase() === target) ||
          (rawSender && jidNormalizedUser(rawSender).toLowerCase() === target)
      )
    ) {
      return true;
    }

    if (this.organizerPhone) {
      const senderDigits = normalizedSender.split('@')[0]?.replace(/\D/g, '');
      // BUGFIX-TS-002: sender_id fallback removed (field never existed on
      // NormalizedMessage; see isSenderOrganizer note above).
      const rawDigits = message.sender_raw_address.split('@')[0]?.replace(/\D/g, '');
      if (
        (senderDigits && senderDigits === this.organizerPhone) ||
        (rawDigits && rawDigits === this.organizerPhone)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates message authorization, verifies group scope, and dispatches command.
   */
  public async handleMessage(message: NormalizedMessage): Promise<CommandResult | null> {
    const parsed = this.parseCommand(message);
    if (!parsed) {
      return null;
    }

    const { command, args, rawArgs } = parsed;
    const normalizedChatId = jidNormalizedUser(message.chat_id);

    // 1. Role Resolution & Authorization
    let role: UserRole = 'UNKNOWN';
    const isOrganizer = this.isSenderOrganizer(message);

    let delegateId: string | null = null;
    let teamId: string | null = null;

    if (isOrganizer) {
      role = 'ORGANIZER';
    } else {
      // Resolve delegate from database
      // BUGFIX-TS-002: sender_id fallback removed (field never existed on
      // NormalizedMessage; see isSenderOrganizer note above).
      const rawAddress = message.sender_raw_address;
      const resolution = await this.identityResolver.resolveIdentity(
        rawAddress,
        message.chat_id
      );

      if (resolution.status === 'VERIFIED' && resolution.delegate) {
        role = 'DELEGATE';
        delegateId = resolution.delegate.id;
        teamId = resolution.team?.id || null;
      }
    }

    // 2. Command Definition Lookup
    const definition = this.commands.get(command);
    if (!definition) {
      return {
        success: false,
        error: 'UNKNOWN_COMMAND',
        responseText: `Perintah *!${command}* tidak dikenali. Ketik *!help* untuk melihat daftar perintah.`,
      };
    }

    // 3. Role-based Access Control
    if (definition.requiredRole === 'ORGANIZER' && role !== 'ORGANIZER') {
      return {
        success: false,
        error: 'FORBIDDEN_ORGANIZER_ONLY',
        responseText: '⛔ Perintah ini hanya memiliki izin untuk dijalankan oleh Organizer turnamen.',
      };
    }

    if (definition.requiredRole === 'DELEGATE' && role === 'UNKNOWN') {
      return {
        success: false,
        error: 'UNAUTHORIZED_DELEGATE',
        responseText: '⛔ Identitas Anda belum terdaftar sebagai delegate resmi turnamen.',
      };
    }

    // 4. Validate DM vs Group Context
    const isGroup = normalizedChatId.endsWith('@g.us');
    const isAdminChat = !isGroup && isOrganizer;
    if (!isGroup && !definition.allowedInDm) {
      return {
        success: false,
        error: 'GROUP_ONLY',
        responseText: '⚠️ Perintah ini hanya dapat dijalankan di dalam grup turnamen.',
      };
    }

    if (isGroup && !definition.allowedInGroup) {
      return {
        success: false,
        error: 'DM_ONLY',
        responseText: '⚠️ Perintah ini hanya dapat dijalankan melalui pesan pribadi dengan bot.',
      };
    }

    // 5. Group Scope Validation (FR-ID-005)
    // Commands and match reports must be accepted only in the configured central tournament group,
    // unless it is an explicitly allowed private DM with the organizer or an organizer administrative flow.
    let isCentralGroup = Boolean(this.centralGroupJid && normalizedChatId === this.centralGroupJid);

    if (isGroup && !isCentralGroup && !definition.allowOutsideCentralGroup) {
      // FIX2-GROUP-001: no silent auto-adoption of a new official group from
      // arbitrary admin commands. Only !setgroup may establish/switch the
      // official group, plus the initial bootstrap case where no official group
      // has been configured at all yet (first-run onboarding).
      const isExplicitSetGroup = command === 'setgroup';
      const isInitialBootstrap = !this.centralGroupJid;

      if (isOrganizer && (isExplicitSetGroup || isInitialBootstrap)) {
        this.setCentralGroupJid(normalizedChatId);
        isCentralGroup = true;
        this.logger.info(
          { newCentralGroup: normalizedChatId, command, bootstrap: isInitialBootstrap },
          'Central tournament group established by organizer'
        );
      } else {
        this.logger.warn(
          { chatId: normalizedChatId, centralGroup: this.centralGroupJid, command },
          'Command rejected: outside central tournament group scope'
        );
        return {
          success: false,
          error: 'UNAUTHORIZED_GROUP',
          responseText: isOrganizer
            ? '⚠️ Perintah hanya dapat diproses di dalam grup turnamen resmi. Jalankan *!setgroup* di grup resmi terlebih dahulu untuk menetapkan grup ini.'
            : '⚠️ Perintah hanya dapat diproses di dalam grup turnamen resmi.',
        };
      }
    }

    // 6. Execute Handler
    const ctx: CommandContext = {
      message,
      command,
      args,
      rawArgs,
      role,
      delegateId,
      teamId,
      isOrganizer,
      isCentralGroup,
      isAdminChat,
    };

    try {
      return await definition.handler(ctx);
    } catch (err: any) {
      this.logger.error({ err, command }, 'Error executing command handler');
      return {
        success: false,
        error: 'HANDLER_ERROR',
        responseText: `Terjadi kesalahan saat memproses perintah *!${command}*: ${err?.message || 'Internal error'}`,
      };
    }
  }

  private registerDefaultCommands(): void {
    // !ping
    this.registerCommand({
      command: 'ping',
      requiredRole: 'ANY',
      description: 'Cek koneksi dan kecepatan respon bot',
      allowedInDm: true,
      allowedInGroup: true,
      handler: (ctx) => {
        const receivedAt = ctx.message?.received_at
          ? new Date(ctx.message.received_at).getTime()
          : Date.now();
        const latencyMs = Math.max(1, Date.now() - receivedAt);
        return {
          success: true,
          responseText: `🏓 Pong! (*${latencyMs} ms*)\nBot Flash Peak TMS aktif.`,
        };
      },
    });

    // !help
    this.registerCommand({
      command: 'help',
      requiredRole: 'ANY',
      description: 'Menampilkan daftar perintah yang tersedia',
      allowedInDm: true,
      allowedInGroup: true,
      handler: (ctx) => {
        const available: string[] = [];
        for (const [cmd, def] of this.commands.entries()) {
          if (def.requiredRole === 'ORGANIZER' && ctx.role !== 'ORGANIZER') {
            continue;
          }
          if (def.requiredRole === 'DELEGATE' && ctx.role === 'UNKNOWN') {
            continue;
          }
          available.push(`*!${cmd}* - ${def.description || 'Tidak ada deskripsi'}`);
        }

        return {
          success: true,
          responseText: `📋 *Daftar Perintah Flash Peak TMS:*\n\n${available.join('\n')}`,
        };
      },
    });

    // !setgroup
    this.registerCommand({
      command: 'setgroup',
      requiredRole: 'ORGANIZER',
      description: 'Menetapkan grup ini sebagai grup turnamen resmi (Admin only)',
      allowedInDm: false,
      allowedInGroup: true,
      handler: (ctx) => {
        this.setCentralGroupJid(ctx.message.chat_id);
        return {
          success: true,
          responseText: '✅ Grup ini telah berhasil ditetapkan sebagai Grup Resmi Turnamen Flash Peak TMS.',
        };
      },
    });

    // !id & !myid
    const idHandler = async (ctx: CommandContext): Promise<CommandResult> => {
      const sender = ctx.message.sender_raw_address || ctx.message.sender_normalized_address;
      const chatId = ctx.message.chat_id;
      const isGroup = chatId.endsWith('@g.us');
      const isOrg = ctx.isOrganizer;

      let groupStatus = 'Bukan Grup Resmi';
      if (ctx.isCentralGroup) {
        groupStatus = '✅ *Grup Resmi Turnamen*';
      } else if (!this.centralGroupJid) {
        groupStatus = 'Belum Ditetapkan (Kirim *!setgroup* untuk menetapkan)';
      }

      const lines = [
        '🆔 *Informasi Identitas & Grup (Flash Peak TMS)*',
        '',
        `👤 *ID WhatsApp Anda (Sender):* \`${sender}\``,
        `• Tipe Alamat: ${sender.includes('@lid') ? 'WhatsApp LID (Privacy ID)' : 'Phone JID'}`,
        `• Role di Sistem: *${ctx.role}*`,
      ];

      // UX-ID-001 (22 Nov 2026): a bare "Role: DELEGATE" line left registered
      // delegates unsure whether their identity was actually in the database,
      // and never said WHICH team they were bound to. Re-resolve the full
      // delegate/team record so !myid answers "delegate tim mana" directly.
      if (ctx.role === 'DELEGATE') {
        lines.push('• Status Registrasi: ✅ *Terdaftar & Terverifikasi*');
        try {
          const resolution = await this.identityResolver.resolveIdentity(sender, chatId);
          if (resolution.delegate) {
            lines.push(`• Nama Delegate: *${resolution.delegate.display_name}*`);
          }
          if (resolution.team) {
            const teamLabel = [resolution.team.team_name, resolution.team.division_name]
              .filter(Boolean)
              .join(' — ');
            lines.push(`• Tim Anda: *${teamLabel}*`);
            if (resolution.tournament_name) {
              lines.push(`• Turnamen: ${resolution.tournament_name}`);
            }
            lines.push(`• Status Tim: ${resolution.team.registration_status}`);
          } else {
            lines.push('• Tim Anda: ⚠️ _Belum terikat ke tim mana pun — hubungi Organizer untuk binding tim._');
          }
        } catch {
          lines.push('• Tim Anda: ⚠️ _Gagal memuat detail tim (database error)._');
        }
      } else if (ctx.role === 'UNKNOWN') {
        lines.push('• Status Registrasi: ❌ _Belum terdaftar sebagai Delegate_');
      }

      lines.push(
        `• Status Organizer: ${isOrg ? '✅ *Terdaftar sebagai Organizer (Full Access)*' : '❌ *Bukan Organizer*'}`,
        '',
        `👥 *ID Chat / Grup Ini:* \`${chatId}\``,
        `• Tipe Chat: ${isGroup ? 'Grup WhatsApp' : 'Direct Message (DM)'}`,
        `• Status Grup: ${groupStatus}`,
      );

      if (isOrg) {
        lines.push('', '💡 _Anda memiliki hak penuh Organizer (bisa !setgroup, !createtournament, dll)._');
      } else if (ctx.role === 'DELEGATE') {
        lines.push(
          '',
          '💡 _Identitas Anda sudah terverifikasi sebagai Delegate resmi — perintah delegate (mis. *!report*) siap digunakan._'
        );
      } else {
        lines.push(
          '',
          '💡 _Anda belum terdaftar sebagai Delegate. Hubungi Organizer untuk didaftarkan. ' +
            'Jika Anda Organizer dengan ID @lid, daftarkan nilai ID Anda di atas ke konfigurasi WA_ORGANIZER_JID di .env bot._'
        );
      }

      return {
        success: true,
        responseText: lines.join('\n'),
      };
    };

    this.registerCommand({
      command: 'id',
      requiredRole: 'ANY',
      description: 'Menampilkan ID WhatsApp Anda dan ID chat/grup saat ini',
      allowedInDm: true,
      allowedInGroup: true,
      allowOutsideCentralGroup: true,
      handler: idHandler,
    });

    this.registerCommand({
      command: 'myid',
      requiredRole: 'ANY',
      description: 'Alias dari !id',
      allowedInDm: true,
      allowedInGroup: true,
      allowOutsideCentralGroup: true,
      handler: idHandler,
    });
  }
}
