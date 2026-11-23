/**
 * Flash Peak TMS - Central Application Orchestrator & Factory (Task 6.5)
 * 
 * Central coordinator connecting all tournament management subsystems:
 * - WhatsApp connection, event capture & message normalizer
 * - Identity resolution & guided sequential onboarding
 * - Evidence ingestion, media client & 5-second sliding debounce
 * - AI multi-provider pipeline, vision classification & extraction
 * - Backend validation & deterministic business rules
 * - Report versioning (immutable drafts v1, v2...)
 * - Natural language corrections & 3-party approvals
 * - Report locking, authoritative player stats writeback & standings updates
 * - Cumulative statistics & tournament awards calculations
 * - WhatsApp response formatters & AI failure handling
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import pino from 'pino';
import type {
  NormalizedMessage,
  CommandResult,
} from './whatsapp/types.js';
import { CommandRouter } from './whatsapp/router.js';
import { WhatsAppSender } from './whatsapp/sender.js';
import { IdentityResolver } from './identity/resolver.js';
import { OnboardingService } from './identity/onboarding.js';
import { FlashPeakMediaClient } from './media/client.js';
import { captureInboundMessage } from './ingestion/capture.js';
import {
  findOrCreateReportSession,
} from './ingestion/session.js';
import {
  resetSessionDebounce,
  claimDebounceBatch,
  recoverOrphanedLeases,
} from './ingestion/debounce.js';
import { ProviderRouter } from './ai/router.js';
import { ImageClassifier } from './ai/classifier.js';
import { MatchSummaryExtractor } from './ai/extractors/match.js';
import { GoalkeeperDetailExtractor } from './ai/extractors/goalkeeper.js';
import { RosterExtractor } from './ai/extractors/roster.js';
import { CorrectionParser } from './ai/correction-parser.js';
import {
  getReportVersion,
} from './reports/versioning.js';
import type { CorrectionResult } from './reports/corrections.js';
import {
  submitReportApproval,
  type ApprovalOutcome,
} from './reports/approval.js';
import {
  handleManualReport,
  type ManualReportInput,
  type ManualReportResult,
} from './reports/manual.js';
import { ManualReportSessionManager } from './application/manual-report-session.js';
import {
  WoClaimSessionManager,
  parseWoClaimIntent,
  resolveFixtureForWoClaim,
  type PendingWoClaim,
} from './application/wo-claim-session.js';
import {
  applyKoGameEvidence,
  getKoSeriesContext,
  deriveOpenGameSlot,
} from './application/ko-evidence-pipeline.js';
import {
  calculateTournamentAwards,
  type TournamentAwardsSummary,
  type AwardsCalculationOptions,
} from './stats/awards.js';
import { registerTournamentCommands } from './application/tournament-commands.js';
import { registerAiNativeCommands } from './application/ai-native-commands.js';
import type { EngagementService } from './application/engagement.js';
import type { AgentPlannerService } from './application/agent-planner.js';
import type { OmakPeakService } from './application/omak-peak.js';
import type { QnaService } from './application/qna.js';
import type { TriviaService } from './application/trivia.js';
import type { QuizSessionManager } from './application/quiz-session.js';
import { MatchdayService } from './application/matchday-service.js';
import { resolveFixtureForMessage } from './application/fixture-resolver.js';
import { handleReportCorrection } from './application/report-correction-coordinator.js';
import {
  processClaimedBatch,
  type ProcessedBatchResult,
} from './application/evidence-batch-processor.js';
import {
  formatStandingsTable,
  formatAwardsAnnouncement,
} from './whatsapp/formatters.js';
import { recalculateAndPersistGroupStandings } from './competition/standings.js';
import type {
  UUID,
  ApproverType,
  ApprovalDecision,
  ReportVersion,
  ReportSession,
} from './shared/types/index.js';

export interface FlashPeakAppConfig {
  db: Client;
  mediaClient?: FlashPeakMediaClient;
  providerRouter?: ProviderRouter;
  rosterExtractor?: RosterExtractor;
  sender?: WhatsAppSender;
  centralGroupJid?: string;
  organizerJid?: string;
  organizerPhone?: string;
  quietWindowMs?: number; // Default: 5000ms
  leaseDurationMs?: number; // Default: 30000ms
  workerId?: string;
  pollIntervalMs?: number; // Default: 1000ms for debounce poll loop
  /** Max automatic AI retries per session after AllProvidersFailedError (default 3). */
  aiMaxRetries?: number;
  /** Delay before each automatic AI retry attempt (default 60000ms, aligned with router circuit-breaker cooldown). */
  aiRetryDelayMs?: number;
}

export interface InboundHandlingResult {
  handled: boolean;
  type: 'COMMAND' | 'ONBOARDING' | 'CORRECTION' | 'EVIDENCE' | 'WO_CLAIM' | 'UNKNOWN';
  commandResult?: CommandResult;
  session?: ReportSession;
  draftVersion?: ReportVersion;
  replyText?: string;
  error?: string;
  mentions?: string[];
}

export type { ProcessedBatchResult };

export class FlashPeakApp {
  public readonly db: Client;
  public readonly identityResolver: IdentityResolver;
  public readonly onboardingService: OnboardingService;
  public readonly commandRouter: CommandRouter;
  public readonly mediaClient?: FlashPeakMediaClient;
  public readonly providerRouter?: ProviderRouter;
  public readonly classifier?: ImageClassifier;
  public readonly matchExtractor?: MatchSummaryExtractor;
  public readonly gkExtractor?: GoalkeeperDetailExtractor;
  public readonly rosterExtractor?: RosterExtractor;
  public readonly correctionParser?: CorrectionParser;
  public readonly manualReportSession: ManualReportSessionManager;
  public readonly woClaimSession: WoClaimSessionManager;
  public readonly matchdayService: MatchdayService;
  // AI-native services — assigned in registerAppCommands() (called from
  // constructor); semantically set-once, but not declared `readonly` because
  // TS forbids readonly assignment outside the constructor body itself.
  public omakPeak?: OmakPeakService;
  public agent?: AgentPlannerService;
  public qna?: QnaService;
  public engagement?: EngagementService;
  public trivia?: TriviaService;
  public quizSessionManager?: QuizSessionManager;
  public centralGroupJid?: string;
  public sender?: WhatsAppSender;

  private quietWindowMs: number;
  private leaseDurationMs: number;
  private workerId: string;
  private pollIntervalMs: number;
  private aiMaxRetries: number;
  private aiRetryDelayMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private lastMatchdayCheck = 0;
  private logger: pino.Logger;

  constructor(config: FlashPeakAppConfig) {
    this.db = config.db;
    this.logger = pino({ level: (process.env.LOG_LEVEL as pino.LevelWithSilent) || 'silent' });
    this.centralGroupJid = config.centralGroupJid;
    this.sender = config.sender;
    this.quietWindowMs = config.quietWindowMs ?? 5000;
    this.leaseDurationMs = config.leaseDurationMs ?? 30000;
    this.workerId = config.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.aiMaxRetries = config.aiMaxRetries ?? 3;
    this.aiRetryDelayMs = config.aiRetryDelayMs ?? 60_000;

    // Subsystems
    this.identityResolver = new IdentityResolver(this.db);
    this.onboardingService = new OnboardingService(this.identityResolver, this.db);
    this.manualReportSession = new ManualReportSessionManager();
    this.woClaimSession = new WoClaimSessionManager();
    this.matchdayService = new MatchdayService({
      db: this.db,
      sender: this.sender,
      centralGroupJid: this.centralGroupJid,
    });
    this.commandRouter = new CommandRouter({
      centralGroupJid: config.centralGroupJid,
      organizerJid: config.organizerJid,
      organizerPhone: config.organizerPhone,
      identityResolver: this.identityResolver,
    });

    this.mediaClient = config.mediaClient;
    this.providerRouter = config.providerRouter;
    this.rosterExtractor = config.rosterExtractor;
    if (this.providerRouter) {
      this.classifier = new ImageClassifier(this.providerRouter);
      this.matchExtractor = new MatchSummaryExtractor(this.providerRouter);
      this.gkExtractor = new GoalkeeperDetailExtractor(this.providerRouter);
      this.correctionParser = new CorrectionParser(this.providerRouter);
      if (!this.rosterExtractor) {
        this.rosterExtractor = new RosterExtractor(this.providerRouter);
      }
    }

    // Synchronize centralGroupJid when updated dynamically via router commands (!setgroup, !createtournament)
    this.commandRouter.onGroupJidChanged((newJid) => {
      this.centralGroupJid = newJid;
      this.matchdayService.setCentralGroupJid(newJid);
      this.logger.info({ newJid }, 'Central group JID synchronized across CommandRouter, MatchdayService, and FlashPeakApp');
    });

    this.registerAppCommands();
  }

  public setCentralGroupJid(jid: string): void {
    const normalized = jidNormalizedUser(jid);
    this.centralGroupJid = normalized;
    if (this.commandRouter.getCentralGroupJid() !== normalized) {
      this.commandRouter.setCentralGroupJid(normalized);
    }
    this.matchdayService.setCentralGroupJid(normalized);
  }

  public getCentralGroupJid(): string | undefined {
    return this.centralGroupJid;
  }

  public setSender(sender: WhatsAppSender): void {
    this.sender = sender;
    this.matchdayService.setSender(sender);
  }

  /**
   * Registers default tournament commands to the CommandRouter.
   */
  private registerAppCommands(): void {
    const self = this;
    registerTournamentCommands(this.commandRouter, {
      db: this.db,
      identityResolver: this.identityResolver,
      onboardingService: this.onboardingService,
      manualReportSession: this.manualReportSession,
      woClaimSession: this.woClaimSession,
      matchdayService: this.matchdayService,
      rosterExtractor: this.rosterExtractor,
      get sender() {
        return self.sender;
      },
      get providerRouter() {
        return self.providerRouter;
      },
      get classifier() {
        return self.classifier;
      },
      get matchExtractor() {
        return self.matchExtractor;
      },
      get mediaClient() {
        return self.mediaClient;
      },
      getStandingsTable: this.getStandingsTable.bind(this),
      submitApproval: this.submitApproval.bind(this),
      findVersionByMessageKey: this.findVersionByMessageKey.bind(this),
    });

    // AI-native commands (!ai/Omak Peak, !agent/!agentconfirm/!agentcancel,
    // !qna/!saveqna, !trivia/!quiz, !pantun). Kept in a dedicated module so
    // tournament-commands.ts does not grow further. The returned services
    // (engagement, agent) are wired into lifecycle hooks below.
    const aiNative = registerAiNativeCommands(this.commandRouter, {
      db: this.db,
      providerRouter: this.providerRouter,
      get sender() { return self.sender; },
      get centralGroupJid() { return self.centralGroupJid; },
    });
    this.omakPeak = aiNative.omakPeak;
    this.agent = aiNative.agent;
    this.qna = aiNative.qna;
    this.engagement = aiNative.engagement;
    this.trivia = aiNative.trivia;
    this.quizSessionManager = aiNative.quizSessionManager;
  }

  /**
   * Main incoming message handler.
   */
  public async handleInboundMessage(
    message: NormalizedMessage,
    mediaBuffer?: Buffer | null
  ): Promise<InboundHandlingResult> {
    const rawMsgText = (message.text_body || message.caption || '').trim();

    // AUDIT-VERIFY-T13 (21 Nov 2026): group-scope enforcement (FR-ID-005) for
    // ALL non-command paths. The CommandRouter already enforces the central
    // group for registered commands, but NL intents ('!klaim WO ...', '!lihat
    // klasemen', ...), photos/evidence, corrections, and the KO pipeline used
    // to reply and mutate state from ANY group. Groups other than the central
    // tournament group are now ignored entirely; the organizer's DM (admin
    // chat) and the central group remain allowed. First-run bootstrap (no
    // central group configured yet) is still permitted so !setgroup can be
    // executed via the router path below.
    const chatIsGroup = message.chat_id.endsWith('@g.us');
    const centralGroup = this.centralGroupJid || this.commandRouter.getCentralGroupJid();
    if (chatIsGroup && centralGroup && message.chat_id !== centralGroup) {
      return { handled: false, type: 'UNKNOWN' };
    }

    // AI-NATIVE-001 (22 Nov 2026): broad capture of TEXT messages in the central
    // tournament group ONLY into inbound_messages, with no session attachment.
    // Purpose: enable !saveqna (needs last-N central-group messages to extract
    // Q&A pairs from chat history) and provide a durable WA log for future audit
    // (task #3 of the AI-native expansion brief). DMs (organizer or participant)
    // are deliberately NOT captured: any DM to the bot may be private chat
    // (e.g. !ai questions), and no current feature reads DM history — !saveqna
    // queries inbound_messages by the central group's chat_id, so DM capture
    // would add no consumer while widening capture into private conversations.
    // Idempotent via the existing provider_message_key UNIQUE constraint
    // (captureInboundMessage returns isDuplicate=true on the second call).
    // IMAGE/VIDEO/AUDIO/DOCUMENT messages are NOT captured here — they
    // continue to flow through the evidence path below, which captures them
    // with the correct report_session_id. Text commands (!ai, !standings, ...)
    // are captured too: they are real group messages and !saveqna benefits
    // from seeing the full conversation context.
    if (
      centralGroup &&
      message.chat_id === centralGroup &&
      message.message_type === 'TEXT'
    ) {
      try {
        await captureInboundMessage(this.db, {
          provider_message_key: message.provider_message_key,
          chat_id: message.chat_id,
          sender_raw_address: message.sender_raw_address,
          delegate_id: null,
          message_timestamp: message.message_timestamp,
          message_type: message.message_type,
          text_body: message.text_body,
          caption: message.caption,
          reply_to_key: message.reply_to_key,
          report_session_id: null,
        });
      } catch (capErr) {
        // Capture is best-effort for logging; never let it block command handling.
        this.logger.warn({ err: capErr }, 'Broad text capture failed (non-blocking)');
      }
    }

    // 0. Interactive knockout per-game evidence (FIX2-KO-002):
    // a photo captioned "!kogame" runs the dedicated KO pipeline and never
    // enters the BO1 group-stage debounce/evidence flow.
    // AUDIT-VERIFY-T9: TEXT-ONLY '!kogame ...' messages (no media) now fall
    // through to the command router, whose registered 'kogame' handler
    // implements the documented status lookup ('!kogame <fixture_id>').
    // Previously every '!kogame' text got the canned "send it as a photo"
    // reply and the status feature was unreachable.
    const isKoGameCaption = rawMsgText.toLowerCase().startsWith('!kogame');
    const hasPhoto = Boolean(mediaBuffer);
    if (isKoGameCaption && hasPhoto) {
      const fixtureArg = rawMsgText.slice('!kogame'.length).trim().split(/\s+/)[0] || '';
      const koRes = await this.handleKoGameEvidenceMessage(message, mediaBuffer, fixtureArg);
      if (koRes.handled) {
        return {
          handled: true,
          type: 'COMMAND',
          replyText: koRes.replyText,
          mentions: koRes.mentions,
        };
      }
    }

    // 1. Command Router & Prefix '!' Handler
    // In group chats, any user-intended bot interaction MUST start with '!'
    if (this.commandRouter.isCommand(message)) {
      const parsed = this.commandRouter.parseCommand(message);

      // If registered command keyword (e.g. !help, !ping, !schedule, !standings, !ok, !batal, !claimwo, !roster), execute via router
      if (parsed && this.commandRouter.hasCommand(parsed.command)) {
        const commandResult = await this.commandRouter.handleMessage(message);
        return {
          handled: true,
          type: 'COMMAND',
          commandResult: commandResult || undefined,
          replyText: commandResult?.responseText,
        };
      }

      // If not a registered command keyword, check for Natural Language intents prefixed with '!'
      // e.g. "!kita klaim wo ya, musuh ga aktif sesuai jadwal janjian"
      // or "!jadwal hari ini apa", "!kapan batas main", "!siapa topskor"
      const textAfterPrefix = rawMsgText.slice(1).trim();
      const normQuery = textAfterPrefix.toLowerCase();

      // 1. Walkover (WO) Claim or WO Questions (Must evaluate first to avoid WO reasons matching generic keywords like 'jadwal')
      const woIntent = parseWoClaimIntent(textAfterPrefix);

      if (woIntent.isGeneralQuestion) {
        return {
          handled: true,
          type: 'WO_CLAIM',
          replyText: [
            'ℹ️ *KETENTUAN KLAIM WALKOVER (WO):*',
            '• Klaim WO diajukan dengan awalan tanda seru (*!*), contoh: _"!klaim WO untuk Match 1 karena lawan tidak hadir 15 menit"_',
            '• Sertakan alasan yang jelas saat melapor.',
            '• Setiap klaim WO akan diverifikasi dan wajib disahkan oleh Panitia turnamen via *!ok*.',
            '• Tim pemenang WO memperoleh skor 3–0 (+3 poin).',
            '💡 Ketik *!rule* untuk melihat regulasi lengkap turnamen.',
          ].join('\n'),
        };
      }

      if (woIntent.isWoClaim) {
        // Validation: Must include a clear reason
        if (!woIntent.hasReason) {
          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: [
              '⚠️ *PENGAJUAN KLAIM WALKOVER (WO)*',
              '',
              'Mohon sertakan alasan klaim WO yang jelas agar dapat diverifikasi oleh Panitia.',
              '',
              '📌 *Contoh format pelaporan:*',
              '• _"!klaim WO untuk Match 1 karena lawan tidak hadir setelah toleransi 15 menit."_',
              '• _"!klaim WO lawan [Nama Tim] karena menolak membuat room pertandingan."_',
            ].join('\n'),
          };
        }

        // Resolve reporting delegate & fixture
        const resolution = await this.identityResolver.resolveIdentity(
          message.sender_raw_address,
          message.chat_id
        );
        const reportingDelegateId =
          resolution.status === 'VERIFIED' && resolution.delegate
            ? resolution.delegate.id
            : null;

        const fixRes = await resolveFixtureForWoClaim(
          this.db,
          reportingDelegateId,
          textAfterPrefix,
          woIntent
        );

        if (fixRes.error) {
          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: fixRes.error,
          };
        }

        if (fixRes.fixture && fixRes.reportingTeam && fixRes.forfeitingTeam && fixRes.tournamentId && fixRes.tournamentName) {
          const claim: PendingWoClaim = {
            id: randomUUID(),
            chatId: message.chat_id,
            fixtureId: fixRes.fixture.id,
            tournamentId: fixRes.tournamentId,
            tournamentName: fixRes.tournamentName,
            groupId: fixRes.fixture.group_id || null,
            stage: fixRes.fixture.stage,
            roundCode: fixRes.fixture.round_code || null,
            teamAName: fixRes.fixture.team_a_name,
            teamBName: fixRes.fixture.team_b_name,
            reportingTeamId: fixRes.reportingTeam.id,
            reportingTeamName: fixRes.reportingTeam.name,
            forfeitingTeamId: fixRes.forfeitingTeam.id,
            forfeitingTeamName: fixRes.forfeitingTeam.name,
            reason: woIntent.extractedReason || 'Lawan tidak hadir / forfeit',
            reportedByAddress: message.sender_raw_address,
            reportedByDelegateId: reportingDelegateId,
            createdAt: Date.now(),
            expiresAt: Date.now() + 15 * 60 * 1000,
          };

          this.woClaimSession.stagePendingClaim(claim);

          const organizerPhone =
            (this.commandRouter as any).organizerPhone || process.env.WA_ORGANIZER_PHONE || '';
          const promptText = this.woClaimSession.formatClaimPrompt(claim, organizerPhone);

          const rawOrgJid =
            (this.commandRouter as any).organizerJid ||
            process.env.WA_ORGANIZER_JID ||
            (organizerPhone ? `${organizerPhone.replace(/\D/g, '')}@s.whatsapp.net` : '');
          const organizerJid = rawOrgJid.split(',')[0].trim();
          const mentions = organizerJid ? [organizerJid] : [];

          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: promptText,
            mentions,
          };
        }
      }

      // 2. Jadwal Hari Ini / Matchday Status & Deadline (e.g. "!apa jadwal hari ini", "!kapan batas main")
      const isTodayScheduleQuery =
        /(jadwal|main|tanding).*(hari ini|today|sekarang|saat ini)/i.test(normQuery) ||
        /(hari ini|today|sekarang).*(jadwal|main|tanding)/i.test(normQuery) ||
        /(deadline|batas waktu|sisa waktu|sampai jam berapa|jam berapa batas)/i.test(normQuery);

      if (isTodayScheduleQuery && this.matchdayService) {
        const statusText = await this.matchdayService.formatMatchdayStatus();
        return {
          handled: true,
          type: 'COMMAND',
          replyText: statusText,
        };
      }

      // 3. Regulasi / Aturan Turnamen (e.g. "!aturan turnamen apa aja", "!gimana aturannya")
      if (/(aturan|rule|regulasi|ketentuan|syarat|format turnamen)/i.test(normQuery)) {
        const ruleRes = await this.commandRouter.handleMessage({
          ...message,
          text_body: '!rule',
        });
        return {
          handled: true,
          type: 'COMMAND',
          replyText: ruleRes?.responseText,
        };
      }

      // 4. Top Scorer / Penghargaan / Best GK (e.g. "!siapa top skor", "!topskor sementara")
      if (/(top\s*skor|top\s*scorer|kiper terbaik|best\s*gk|penghargaan|awards|pencetak gol)/i.test(normQuery)) {
        const awardsRes = await this.commandRouter.handleMessage({
          ...message,
          text_body: '!awards',
        });
        return {
          handled: true,
          type: 'COMMAND',
          replyText: awardsRes?.responseText,
        };
      }

      // 5. Klasemen / Standings (e.g. "!lihat klasemen grup A", "!gimana klasemen sementara")
      if (/(klasemen|standings|peringkat|posisi grup|tabel grup)/i.test(normQuery)) {
        const groupMatch = normQuery.match(/\b(?:grup|group)\s*([a-z0-9]+)\b/i);
        const groupArg = groupMatch ? ` ${groupMatch[1]}` : '';
        const standingsRes = await this.commandRouter.handleMessage({
          ...message,
          text_body: `!standings${groupArg}`,
        });
        return {
          handled: true,
          type: 'COMMAND',
          replyText: standingsRes?.responseText,
        };
      }

      // 6. Jadwal Pertandingan Umum (e.g. "!lihat jadwal", "!tampilkan jadwal")
      if (/(jadwal|schedule|fixture)/i.test(normQuery)) {
        const schedRes = await this.commandRouter.handleMessage({
          ...message,
          text_body: `!schedule ${textAfterPrefix}`,
        });
        return {
          handled: true,
          type: 'COMMAND',
          replyText: schedRes?.responseText,
        };
      }

      // 7. Roster / Susunan Pemain (e.g. "!siapa pemain singa fc", "!susunan pemain garuda", "!daftar roster...")
      if (/(roster|susunan pemain|daftar pemain|lineup|pemain)/i.test(normQuery)) {
        const isReg = /(?:gk|kiper|penjaga\s*gawang)/i.test(normQuery);
        let rosterArg = textAfterPrefix;
        if (!isReg) {
          const teamMatch = normQuery.match(/(?:tim|roster|pemain)\s+([a-zA-Z0-9\s]+)/i);
          rosterArg = teamMatch && teamMatch[1] ? teamMatch[1].trim() : textAfterPrefix;
        }
        const cleanArg = rosterArg.replace(/^(?:daftar\s+roster|daftar\s+pemain|susunan\s+pemain|roster)\s*/i, '').trim();
        const rosterRes = await this.commandRouter.handleMessage({
          ...message,
          text_body: `!roster ${cleanArg}`,
        });
        return {
          handled: true,
          type: 'COMMAND',
          replyText: rosterRes?.responseText,
        };
      }

      // If text starts with '!' but is neither a known command nor a known NL intent,
      // dispatch to router for UNKNOWN_COMMAND handling
      const commandResult = await this.commandRouter.handleMessage(message);
      return {
        handled: true,
        type: 'COMMAND',
        commandResult: commandResult || undefined,
        replyText: commandResult?.responseText,
      };
    }

    // 1.2 Real-Time Interactive Quiz Listener (Community Engagement)
    if (
      this.quizSessionManager &&
      this.quizSessionManager.hasActiveQuiz(message.chat_id) &&
      message.message_type === 'TEXT'
    ) {
      if (rawMsgText.length > 0 && (rawMsgText.length <= 60 || message.reply_to_key)) {
        const evalRes = await this.quizSessionManager.evaluateAnswer(message.chat_id, rawMsgText);
        if (evalRes.isAnswerToQuiz) {
          const senderJid = message.sender_raw_address || message.sender_normalized_address;
          const pushName = message.push_name || (senderJid.split('@')[0]);
          const mentionJid = senderJid.includes('@s.whatsapp.net') ? senderJid : '';
          const mentionTag = mentionJid ? `@${senderJid.split('@')[0]}` : `*${pushName}*`;
          const mentions = mentionJid ? [senderJid] : [];

          if (evalRes.isCorrect && evalRes.active) {
            const active = evalRes.active;
            this.quizSessionManager.cancelQuiz(message.chat_id);
            const totalScore = await this.quizSessionManager.recordWin(
              message.chat_id,
              message.sender_raw_address,
              pushName
            );

            const lines = [
              '🎉 *TEBAKAN BENAR!* 👏',
              '',
              `Selamat ${mentionTag}! Jawaban kamu tepat:`,
              `💡 *${active.quiz.answer}*`,
              '',
              `⏱️ Waktu tebak: *${evalRes.elapsedSeconds} detik*`,
              `🏆 Total Skor Kuis Kamu: *${totalScore} poin*`,
              '',
              '_Ketik *!quiz* buat main lagi, atau *!topquiz* buat lihat leaderboard!_',
            ];

            return {
              handled: true,
              type: 'COMMAND',
              replyText: lines.join('\n'),
              mentions,
            };
          } else {
            // Feedback for incorrect answer during 15s window
            return {
              handled: true,
              type: 'COMMAND',
              replyText: `❌ Kurang tepat ${mentionTag}! Coba tebak lagi sebelum 15 detik habis!`,
              mentions,
            };
          }
        }
      }
    }

    // 1.5 Pending Manual Report Confirmation / Correction Check
    // AUDIT-VERIFY-T8: a staged manual-report draft is the ORGANIZER's draft
    // (staged via !manualreport). Plain-text 'ok'/corrections from other group
    // members used to confirm/modify it (confirmPending hardcodes
    // is_organizer: true) — now only the organizer may do either. Delegates
    // can still use !ok/!confirm/!batal which are ORGANIZER-role gated in the
    // router.
    if (this.manualReportSession.hasPending(message.chat_id, message.sender_normalized_address)) {
      const normText = rawMsgText.toLowerCase();
      const senderIsOrganizer = this.commandRouter.isSenderOrganizer(message);
      const isConfirm = ['ok', 'ya', 'confirm', '!ok', '!confirm', 'lanjut', 'benar', 'sudah benar'].includes(normText);

      if (isConfirm) {
        if (!senderIsOrganizer) {
          return {
            handled: true,
            type: 'COMMAND',
            replyText: '⛔ Konfirmasi draf laporan manual hanya dapat dilakukan oleh Panitia (yang membuat drafnya). Ketik *!ok* sebagai Panitia untuk mengonfirmasi.',
          };
        }
        const organizerId = message.sender_normalized_address || 'ORGANIZER';
        const confirmRes = await this.manualReportSession.confirmPending(
          this.db,
          message.chat_id,
          organizerId
        );
        return {
          handled: true,
          type: 'COMMAND',
          replyText: confirmRes.success ? confirmRes.replyText : confirmRes.error,
        };
      }

      const isCorrection =
        normText.includes('bukan') ||
        normText.includes('koreksi') ||
        normText.includes('ganti') ||
        normText.includes('gol a') ||
        normText.includes('gol b') ||
        normText.includes('tim a') ||
        normText.includes('tim b') ||
        normText.startsWith('a:') ||
        normText.startsWith('b:');

      if (isCorrection) {
        if (!senderIsOrganizer) {
          return {
            handled: true,
            type: 'COMMAND',
            replyText: '⛔ Koreksi draf laporan manual hanya dapat dilakukan oleh Panitia.',
          };
        }
        const organizerId = message.sender_normalized_address || 'ORGANIZER';
        const correctionRes = this.manualReportSession.applyCorrection(
          message.chat_id,
          organizerId,
          rawMsgText
        );
        return {
          handled: true,
          type: 'COMMAND',
          replyText: correctionRes.success ? correctionRes.updatedPrompt : correctionRes.error,
        };
      }
    }

    // 2. Onboarding Flow Check
    const activeTournaments = await this.db.execute("SELECT id FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
    if (activeTournaments.rows.length > 0) {
      const tournamentId = String(activeTournaments.rows[0].id ?? activeTournaments.rows[0][0]);
      const activePrompt = this.onboardingService.getActivePrompt(tournamentId);
      if (activePrompt && message.reply_to_key === activePrompt.promptMessageKey) {
        const replyRes = await this.onboardingService.handleOnboardingReply(tournamentId, message);
        if (replyRes.status === 'SUCCESS') {
          // If there is a next pending team to prompt, send it sequentially after 2s
          if (replyRes.nextPrompt?.promptText && replyRes.nextPrompt.team && this.sender) {
            const nextPrompt = replyRes.nextPrompt;
            setTimeout(async () => {
              try {
                if (this.sender && nextPrompt.promptText && nextPrompt.team) {
                  const nextKey = await this.sender.sendText(message.chat_id, nextPrompt.promptText);
                  this.onboardingService.setActivePrompt(tournamentId, nextPrompt.team.id, nextKey);
                }
              } catch (err) {
                console.error('[Onboarding] Error sending next sequential prompt:', err);
              }
            }, 2000);
          }
          return {
            handled: true,
            type: 'ONBOARDING',
            replyText: replyRes.responseText,
          };
        }
      }
    }

    // 3. Natural Language Correction Check
    const text = (message.text_body || message.caption || '').toLowerCase();
    const isCorrectionCandidate =
      text.includes('koreksi') ||
      text.includes('salah di') ||
      text.includes('seharusnya') ||
      text.includes('bukan') ||
      text.includes('player urutan');

    if (isCorrectionCandidate && message.reply_to_key) {
      const targetVersion = await this.findVersionByMessageKey(message.reply_to_key);
      if (targetVersion && this.correctionParser) {
        // AUDIT-VERIFY-T6: forward the organizer flag so an organizer's NL
        // correction is authorized (the coordinator used to drop it, making
        // every organizer correction 'Unauthorized sender').
        const correctionRes = await this.handleCorrection(targetVersion.id, message, this.commandRouter.isSenderOrganizer(message));
        return {
          handled: true,
          type: 'CORRECTION',
          replyText: correctionRes.replyText,
        };
      }
    }

    // 4. Evidence / Match Ingestion Capture
    if (
      message.chat_id.endsWith('@broadcast') ||
      message.chat_id === 'status@broadcast' ||
      message.chat_id.endsWith('@newsletter')
    ) {
      return { handled: false, type: 'UNKNOWN' };
    }

    const hasMedia = message.message_type === 'IMAGE' || Boolean(message.media_metadata) || Boolean(mediaBuffer);
    if ((hasMedia && message.message_type === 'IMAGE') || isCorrectionCandidate) {
      const resolvedIdentity = await this.identityResolver.resolveIdentity(message.sender_raw_address);
      const delegateId = resolvedIdentity?.delegate?.id || null;

      const fixture = await resolveFixtureForMessage(this.db, this.identityResolver, message);
      let sessionId: string | null = null;
      let session: ReportSession | undefined;

      if (fixture) {
        const teamId = fixture.submitting_team_id || resolvedIdentity?.team?.id || fixture.team_a_id;
        const sessionRes = await findOrCreateReportSession(this.db, {
          fixture_id: fixture.id,
          submitting_team_id: teamId,
        });
        sessionId = sessionRes.session.id;
      }

      const captureRes = await captureInboundMessage(this.db, {
        provider_message_key: message.provider_message_key,
        chat_id: message.chat_id,
        sender_raw_address: message.sender_raw_address,
        delegate_id: delegateId,
        message_timestamp: message.message_timestamp,
        message_type: message.message_type,
        text_body: message.text_body,
        caption: message.caption,
        reply_to_key: message.reply_to_key,
        report_session_id: sessionId,
      });

      // Persist binary media into Flash Peak media service & Turso media_assets table
      if (mediaBuffer && this.mediaClient) {
        try {
          const originalName = message.media_metadata?.fileName || `${message.provider_message_key}.jpg`;
          const mime = message.media_metadata?.mimetype || 'image/jpeg';
          const asset = await this.mediaClient.uploadMedia({
            buffer: mediaBuffer,
            filename: originalName,
            mimeType: mime,
            mediaRole: 'MAIN_MATCH',
            sourceMessageId: captureRes.message.id,
            uploadedByDelegateId: delegateId,
          });
          console.log(`[Media] Uploaded asset '${asset.id}' (${mediaBuffer.length} bytes) for message ${captureRes.message.id}`);
        } catch (uploadErr) {
          console.error('[Media] Failed to upload media asset to media service:', uploadErr);
        }
      }

      if (sessionId) {
        session = await resetSessionDebounce(
          this.db,
          sessionId,
          this.quietWindowMs
        );

        // Acknowledge receipt so the delegate is never left in silence while the
        // debounce window elapses and the batch waits for processing (silent-intake fix).
        // A late photo for an already-retried session also re-extends the window,
        // so the ack always states the honest current position.
        const isRetrySession = session.ai_retry_count > 0;
        const ackLines: string[] = [];
        if (isRetrySession) {
          ackLines.push('⏳ Screenshot tambahan diterima dan digabungkan dengan laporan yang sedang menunggu percobaan ulang AI.');
        } else {
          ackLines.push('📸 Screenshot diterima. Laporan sedang diproses otomatis.');
        }
        ackLines.push(
          `Mohon tunggu konfirmasi hasil di grup${session.ai_retry_count > 0 ? ' — tidak perlu mengirim ulang' : ''}.`
        );

        return {
          handled: true,
          type: 'EVIDENCE',
          session,
          replyText: ackLines.join(' '),
        };
      }
    }

    return { handled: false, type: 'UNKNOWN' };
  }

  /**
   * Interactive knockout per-game evidence flow (FIX2-KO-002).
   *
   * Handles a photo whose caption starts with "!kogame": classifies the
   * screenshot, extracts the score, applies it to the correct game slot of
   * the knockout series (slot derived from persisted state, never from user
   * input), and returns the per-game reply (result + running series score +
   * next-game request or series-completion announcement).
   *
   * Dispatched from handleInboundMessage BEFORE the generic evidence-capture
   * path so knockout photos never enter the BO1 group-stage debounce
   * pipeline.
   */
  public async handleKoGameEvidenceMessage(
    message: NormalizedMessage,
    mediaBuffer: Buffer | null | undefined,
    explicitFixtureId?: string
  ): Promise<{ handled: boolean; replyText?: string; mentions?: string[] }> {
    const caption = (message.caption || message.text_body || '').trim();
    const normCaption = caption.toLowerCase();

    if (!normCaption.startsWith('!kogame')) {
      return { handled: false };
    }
    if (!mediaBuffer) {
      return {
        handled: true,
        replyText: '📸 Kirim screenshot hasil game sebagai foto dengan caption *!kogame* (teks saja tidak bisa diproses). Contoh: foto skor + caption `!kogame`.',
      };
    }

    // Resolve delegate identity (RBAC: only verified delegates or organizer)
    const resolved = await this.identityResolver.resolveIdentity(
      message.sender_raw_address,
      message.chat_id
    );
    const delegateId = resolved.status === 'VERIFIED' && resolved.delegate ? resolved.delegate.id : null;
    const isOrg = this.commandRouter.isSenderOrganizer(message);
    if (!delegateId && !isOrg) {
      return {
        handled: true,
        replyText: '⚠️ Hanya delegasi resmi tim peserta (atau Panitia) yang dapat melaporkan hasil game knockout.',
      };
    }

    // FIX2-KO-003 (audit 20 Nov 2026, temuan 3.1 Critical): ko_game_evidence.source_message_id
    // and media_assets.source_message_id both have FK REFERENCES inbound_messages(id), but this
    // path used to pass the WhatsApp provider_message_key — which is NOT a row UUID — so every
    // journal INSERT failed with SQLITE FOREIGN KEY constraint and the photo pipeline was dead.
    // Fix: capture the inbound message row FIRST (idempotent, like the group-stage path at
    // captureInboundMessage) and use the row UUID as sourceMessageId everywhere below.
    const captureRes = await captureInboundMessage(this.db, {
      provider_message_key: message.provider_message_key,
      chat_id: message.chat_id,
      sender_raw_address: message.sender_raw_address,
      delegate_id: delegateId,
      message_timestamp: message.message_timestamp,
      message_type: message.message_type,
      text_body: message.text_body,
      caption: message.caption,
      reply_to_key: message.reply_to_key,
    });
    const sourceMessageRowId = captureRes.message.id;

    // Resolve the target series fixture:
    // 1) explicit fixture id from the caption, else
    // 2) the sender's team's active knockout fixture, else
    // 3) the single active knockout fixture of the latest tournament.
    // FIX2-KO-004 (audit temuan 3.2 High): an explicit caption arg is validated as a real
    // fixture id BEFORE use (a stray word like "MOCK" must not be treated as a fixture id),
    // and an ambiguous implicit resolution is rejected with a chooser list instead of
    // silently defaulting to the oldest series.
    let fixtureId = '';
    const explicitArg = (explicitFixtureId || '').trim();
    if (explicitArg) {
      const validRes = await this.db.execute({
        sql: `SELECT id FROM fixtures WHERE id = ? LIMIT 1`,
        args: [explicitArg],
      });
      if (validRes.rows.length === 0) {
        return {
          handled: true,
          replyText: `⚠️ ID fixture *"${explicitArg}"* tidak ditemukan. Kirim foto dengan caption *!kogame <fixture_id>* menggunakan ID fixture yang benar (lihat *!schedule*).`,
        };
      }
      fixtureId = explicitArg;
    }
    if (!fixtureId) {
      const teamId = resolved.status === 'VERIFIED' && resolved.team ? resolved.team.id : null;
      if (teamId) {
        const fRes = await this.db.execute({
          sql: `SELECT f.id FROM fixtures f
                WHERE f.stage = 'KNOCKOUT' AND (f.team_a_id = ? OR f.team_b_id = ?)
                  AND f.status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
                ORDER BY f.created_at ASC LIMIT 1`,
          args: [teamId, teamId],
        });
        if (fRes.rows.length > 0) fixtureId = String(fRes.rows[0].id);
      }
    }
    if (!fixtureId) {
      // FIX2-KO-004 (audit temuan 3.2 High): never default silently to the oldest
      // active series. If MORE than one active knockout fixture exists, reply with
      // a chooser list so the delegate explicitly states the target; auto-pick the
      // single one only when it is truly unambiguous.
      const fRes = await this.db.execute({
        sql: `SELECT f.id, f.round_code, ta.team_name AS team_a_name, tb.team_name AS team_b_name
              FROM fixtures f
              JOIN tournaments t ON f.tournament_id = t.id
              JOIN teams ta ON f.team_a_id = ta.id
              JOIN teams tb ON f.team_b_id = tb.id
              WHERE f.stage = 'KNOCKOUT' AND t.status NOT IN ('COMPLETED', 'ARCHIVED')
                AND f.status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
              ORDER BY f.created_at ASC`,
      });
      if (fRes.rows.length === 1) {
        fixtureId = String(fRes.rows[0].id);
      } else if (fRes.rows.length > 1) {
        const lines = fRes.rows.map((r) => {
          const row = r as unknown as Record<string, unknown>;
          return `• *${String(row.team_a_name)}* vs *${String(row.team_b_name)}* (${String(row.round_code)}) — \`${String(row.id)}\``;
        });
        return {
          handled: true,
          replyText: [
            '⚠️ Ada beberapa series knockout aktif — sebutkan ID fixture secara eksplisit:',
            ...lines,
            '',
            'Contoh: kirim ulang foto dengan caption `!kogame <fixture_id> <skor_a>-<skor_b>`.',
            'Daftar ID fixture juga bisa dilihat via *!schedule*.',
          ].join('\n'),
        };
      }
    }

    if (!fixtureId) {
      return {
        handled: true,
        replyText: '⚠️ Tidak ada pertandingan knockout aktif yang menunggu hasil. Pastikan fase knockout sudah dimulai (*!startknockout*) dan sertakan ID fixture di caption bila ada beberapa pertandingan aktif: `!kogame <fixture_id>`.',
      };
    }

    const ctxInfo = await getKoSeriesContext(this.db, fixtureId);
    if (!ctxInfo) {
      return {
        handled: true,
        replyText: `⚠️ Series knockout tidak ditemukan untuk fixture *"${fixtureId}"*. Pastikan ID fixture benar (lihat *!schedule*).`,
      };
    }

    // Classify + extract using the generic AI components
    if (!this.providerRouter || !this.classifier || !this.matchExtractor) {
      return {
        handled: true,
        replyText: '⚠️ Pipeline AI belum terkonfigurasi. Gunakan *!kores <fixture_id> <game_no> <skor_a>-<skor_b>* (Panitia) untuk mencatat hasil game.',
      };
    }

    const base64 = mediaBuffer.toString('base64');

    const classification = await this.classifier.classify(
      { mime_type: 'image/jpeg', base64 },
      { caption }
    );

    if (classification.screen_type !== 'MAIN_MATCH_SUMMARY') {
      return {
        handled: true,
        replyText: '⚠️ Screenshot ini tidak terdeteksi sebagai *ringkasan hasil pertandingan*. Kirim screenshot skor akhir game (main match summary) dengan caption *!kogame*.',
      };
    }

    // Upload to media service (journal link; failures do not block recording)
    let mediaAssetId: string | null = null;
    if (this.mediaClient) {
      try {
        const asset = await this.mediaClient.uploadMedia({
          buffer: mediaBuffer,
          filename: message.media_metadata?.fileName || `${message.provider_message_key}.jpg`,
          mimeType: message.media_metadata?.mimetype || 'image/jpeg',
          mediaRole: 'MAIN_MATCH',
          // FIX2-KO-003: inbound_messages row UUID (FK-safe), NOT provider_message_key.
          sourceMessageId: sourceMessageRowId,
          uploadedByDelegateId: delegateId,
        });
        mediaAssetId = asset.id;
      } catch (err) {
        console.error('[KO-Evidence] Media upload failed (continuing without asset link):', err);
      }
    }

    // Extract the score with trusted context
    const extraction = await this.matchExtractor.extract(
      { mime_type: 'image/jpeg', base64 },
      {
        trusted_context: {
          fixture_id: fixtureId,
          team_a_name: ctxInfo.teamAName,
          team_b_name: ctxInfo.teamBName,
          expected_roster: [],
        },
        correlation_id: `ko-evidence-${fixtureId}`,
      }
    );

    // The extractor reports scores from the perspective of the screenshot's
    // left/right team. Orient to fixture team_a/team_b using the same
    // convention as the BO1 processor: team_a_name match on the left side.
    // The extraction schema provides team_a_score/team_b_score already mapped
    // to the trusted_context team order.
    const extractedA = extraction.summary_data.team_a_score;
    const extractedB = extraction.summary_data.team_b_score;
    if (extractedA === null || extractedA === undefined || extractedB === null || extractedB === undefined) {
      return {
        handled: true,
        replyText: '⚠️ Skor tidak terbaca dari screenshot. Kirim ulang screenshot skor akhir yang jelas, atau minta Panitia mencatat via *!kores <fixture_id> <game_no> <skor_a>-<skor_b>*.',
      };
    }

    try {
      const outcome = await applyKoGameEvidence(this.db, {
        fixtureId,
        teamAScore: extractedA,
        teamBScore: extractedB,
        submittedByDelegateId: delegateId,
        mediaAssetId,
        // FIX2-KO-003: inbound_messages row UUID (FK-safe), NOT provider_message_key.
        sourceMessageId: sourceMessageRowId,
        extractionJson: JSON.stringify({
          raw: extraction.raw_extraction,
          summary: extraction.summary_data,
        }),
      });

      // Grand Final completed via the delegate photo pipeline -> tournament over.
      if (
        outcome.status === 'SERIES_COMPLETE' &&
        ctxInfo.roundCode === 'FINAL' &&
        outcome.winnerTeamId
      ) {
        await this.db.execute({
          sql: `UPDATE tournaments SET status = 'COMPLETED', updated_at = ? WHERE id = ?`,
          args: [new Date().toISOString(), ctxInfo.tournamentId],
        });
      }

      // Build the interactive per-game reply
      const lines: string[] = [];
      if (outcome.status === 'SERIES_COMPLETE') {
        const winnerName = outcome.winnerTeamId === ctxInfo.teamAId ? ctxInfo.teamAName : ctxInfo.teamBName;
        lines.push('🏆 *HASIL GAME KNOCKOUT TERCATAT — SERIES SELESAI!*');
        lines.push('──────────────────────────────');
        lines.push(`⚔️ *${ctxInfo.teamAName}* vs *${ctxInfo.teamBName}* (${ctxInfo.roundCode || 'KNOCKOUT'}, ${outcome.seriesFormat})`);
        lines.push(`🎮 Game ke-${outcome.gameNumber}: ${ctxInfo.teamAName} ${extractedA} — ${extractedB} ${ctxInfo.teamBName}`);
        lines.push(`📊 *Skor Series Final:* ${outcome.seriesScore.team_a} — ${outcome.seriesScore.team_b}`);
        lines.push(`🏆 Pemenang series: *${winnerName}*`);
        lines.push('');
        if (ctxInfo.roundCode === 'FINAL') {
          lines.push('👑 *GRAND FINAL selesai — turnamen tamat!* Ketik *!awards* untuk rekap penghargaan.');
        } else {
          lines.push('💡 _Panitia memicu ronde berikutnya dengan *!startknockout* setelah semua series ronde ini selesai._');
        }

        // AI-NATIVE (D-040): engagement hype recap + champion celebration.
        // Fires AFTER the official result message is built. The recap is a
        // SEPARATE follow-up message (sent via sender) so the formal result
        // stays unambiguous. Hype uses ONLY real facts (series score, margin,
        // round) — AI formats presentation, never invents. Champion celebration
        // fires only on Grand Final completion. Both silently skip if AI
        // unavailable (non-critical).
        if (this.engagement && this.sender) {
          const hypeFacts = {
            stage: 'KNOCKOUT' as const,
            team_a_name: ctxInfo.teamAName,
            team_b_name: ctxInfo.teamBName,
            team_a_score: outcome.seriesScore.team_a,
            team_b_score: outcome.seriesScore.team_b,
            context_summary: `${ctxInfo.roundCode || 'KO'} ${outcome.seriesFormat}, pemenang ${winnerName}`,
            form_notes: [],
          };
          // Detached — never blocks the reply.
          Promise.resolve().then(async () => {
            try {
              if (ctxInfo.roundCode === 'FINAL' && outcome.winnerTeamId) {
                // Champion celebration instead of generic hype.
                const tRes = await this.db.execute({ sql: 'SELECT name FROM tournaments WHERE id = ?', args: [ctxInfo.tournamentId] });
                const tName = tRes.rows.length > 0 ? String((tRes.rows[0] as unknown as Record<string, unknown>)[0] ?? (tRes.rows[0] as unknown as Record<string, unknown>).name) : 'Turnamen Flash Peak';
                const celeb = await this.engagement!.buildChampionCelebration({
                  tournament_name: tName,
                  champion_team_name: winnerName,
                  champion_path_summary: `Series final ${outcome.seriesScore.team_a}-${outcome.seriesScore.team_b} (${outcome.seriesFormat})`,
                });
                if (celeb && this.sender) {
                  await this.sender.sendText(message.chat_id, celeb);
                }
              } else {
                const hype = await this.engagement!.buildHypeRecap(hypeFacts);
                if (hype && this.sender) {
                  await this.sender.sendText(message.chat_id, hype);
                }
              }
            } catch {
              // best-effort; never let engagement break the result flow
            }
          });
        }
      } else if (outcome.status === 'SERIES_ALREADY_COMPLETE') {
        lines.push(outcome.message);
      } else if (outcome.status === 'DUPLICATE') {
        lines.push(outcome.message);
      } else {
        lines.push('✅ *HASIL GAME KNOCKOUT TERCATAT*');
        lines.push('──────────────────────────────');
        lines.push(`⚔️ *${ctxInfo.teamAName}* vs *${ctxInfo.teamBName}* (${ctxInfo.roundCode || 'KNOCKOUT'}, ${outcome.seriesFormat})`);
        if (outcome.seriesOutcome?.is_replay_required) {
          lines.push(`🔁 Game ke-${outcome.gameNumber} seri ${extractedA}-${extractedB} — wajib replay pada slot yang sama (D-028). Kirim screenshot hasil replay dengan caption *!kogame*.`);
        } else {
          lines.push(`🎮 Game ke-${outcome.gameNumber}: ${ctxInfo.teamAName} ${extractedA} — ${extractedB} ${ctxInfo.teamBName}`);
          lines.push(`📊 *Skor Series:* ${outcome.seriesScore.team_a} — ${outcome.seriesScore.team_b}`);
          lines.push(`➡️ Series belum selesai — kirim screenshot *game ke-${outcome.nextGameNumber}* dengan caption *!kogame*.`);
          lines.push(`💡 _${outcome.seriesFormat}: first to ${outcome.targetWins} wins._`);
        }
      }

      return { handled: true, replyText: lines.join('\n') };
    } catch (err: any) {
      return {
        handled: true,
        replyText: `⚠️ Gagal memproses bukti game knockout: ${err.message || String(err)}`,
      };
    }
  }

  /**
   * Processes all due sliding debounce batches atomically.
   */
  public async processDueDebounceBatches(): Promise<ProcessedBatchResult[]> {
    const results: ProcessedBatchResult[] = [];

    while (true) {
      const batch = await claimDebounceBatch(this.db, this.workerId, this.leaseDurationMs);
      if (!batch) break;

      const res = await processClaimedBatch(
        {
          db: this.db,
          mediaClient: this.mediaClient,
          providerRouter: this.providerRouter,
          classifier: this.classifier,
          matchExtractor: this.matchExtractor,
          gkExtractor: this.gkExtractor,
          centralGroupJid: this.centralGroupJid,
          aiMaxRetries: this.aiMaxRetries,
          aiRetryDelayMs: this.aiRetryDelayMs,
        },
        batch
      );
      results.push(res);
    }

    return results;
  }

  /**
   * Applies natural language correction to a report version.
   */
  public async handleCorrection(
    versionId: UUID,
    message: NormalizedMessage,
    isOrganizer = false
  ): Promise<{ result: CorrectionResult; replyText: string }> {
    if (!this.correctionParser) {
      throw new Error('Correction parser not configured');
    }

    return handleReportCorrection(
      {
        db: this.db,
        correctionParser: this.correctionParser,
        identityResolver: this.identityResolver,
      },
      versionId,
      message,
      isOrganizer
    );
  }

  /**
   * Submits 3-party approval on a report version.
   */
  public async submitApproval(
    reportVersionId: UUID,
    approverType: ApproverType,
    approverId: string,
    decision: ApprovalDecision,
    isOrganizer = false
  ): Promise<ApprovalOutcome> {
    return submitReportApproval(this.db, {
      report_version_id: reportVersionId,
      approver_type: approverType,
      approver_id: approverId,
      decision,
      is_organizer: isOrganizer,
      // FIX2-APR-003: verify ORGANIZER authority against configured organizer
      // identities (WA_ORGANIZER_JID / WA_ORGANIZER_PHONE), not string patterns.
      allowed_organizer_ids: this.commandRouter.getOrganizerIdentities(),
    });
  }

  /**
   * Submits a manual match report (Admin only, FR-FAIL-003).
   */
  public async submitManualReport(input: ManualReportInput): Promise<ManualReportResult> {
    return handleManualReport(this.db, input);
  }

  /**
   * Computes group standings table formatted for WhatsApp.
   */
  public async getStandingsTable(
    tournamentId: UUID,
    groupId: UUID,
    groupCode = 'A',
    options?: { showFooter?: boolean }
  ): Promise<string> {
    const standings = await recalculateAndPersistGroupStandings(this.db, tournamentId, groupId);
    return formatStandingsTable(groupCode, standings, options);
  }

  /**
   * Computes tournament awards summary and formatted WhatsApp text.
   */
  public async getAwardsSummary(
    tournamentId: UUID,
    tournamentTitle = 'Flash Peak Tour',
    options?: AwardsCalculationOptions
  ): Promise<{ awards: TournamentAwardsSummary; formattedText: string }> {
    const awards = await calculateTournamentAwards(this.db, tournamentId, options);
    const formattedText = formatAwardsAnnouncement(tournamentTitle, awards);
    return { awards, formattedText };
  }

  /**
   * Starts periodic debounce queue polling.
   */
  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;

    // FIX2-LEASE-001: actively recover orphaned PROCESSING leases at boot so a
    // session interrupted by a restart is re-queued immediately instead of
    // waiting for its ~30s lease to passively expire.
    recoverOrphanedLeases(this.db)
      .then((recovered) => {
        if (recovered > 0) {
          this.logger.info({ recovered }, 'Recovered orphaned debounce leases at startup');
        }
      })
      .catch((err) => {
        console.error('[FlashPeakApp] Error recovering orphaned leases at startup:', err);
      });

    // AI-NATIVE (D-038): recover organizer AI agent plans stuck in EXECUTING
    // from a crash/restart. Marks them FAILED so the organizer is informed on
    // next !agentconfirm and no plan is left in an ambiguous state.
    if (this.agent) {
      this.agent.recoverInterruptedPlans()
        .then((n) => {
          if (n > 0) this.logger.info({ recovered: n }, 'Recovered interrupted AI agent plans at startup');
        })
        .catch((err) => {
          console.error('[FlashPeakApp] Error recovering interrupted AI agent plans:', err);
        });
    }

    this.pollTimer = setInterval(async () => {
      try {
        const batchResults = await this.processDueDebounceBatches();
        for (const res of batchResults) {
          if (res.whatsappSummary && this.sender) {
            const destChat = res.targetChatId || this.centralGroupJid;
            if (destChat) {
              const sentKey = await this.sender.sendText(destChat, res.whatsappSummary);
              if (sentKey && res.sessionId) {
                try {
                  await this.db.execute({
                    sql: `INSERT OR IGNORE INTO inbound_messages (
                            id, report_session_id, provider_message_key, chat_id,
                            sender_raw_address, message_type, text_body,
                            message_timestamp, received_at, raw_metadata_json, created_at
                          ) VALUES (?, ?, ?, ?, 'bot@s.whatsapp.net', 'TEXT', ?, ?, ?, '{}', ?)`,
                    args: [
                      randomUUID(),
                      res.sessionId,
                      sentKey,
                      destChat,
                      res.whatsappSummary,
                      new Date().toISOString(),
                      new Date().toISOString(),
                      new Date().toISOString(),
                    ],
                  });
                } catch (persistErr) {
                  console.warn('[FlashPeakApp] Could not bind outbound summary message key:', persistErr);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[FlashPeakApp] Error processing debounce batches:', err);
      }

      // Check matchday schedule (cutoff & reminders) every ~30 seconds
      const now = Date.now();
      if (now - this.lastMatchdayCheck >= 30000) {
        this.lastMatchdayCheck = now;
        try {
          await this.matchdayService.processDailyCutoff();
          await this.matchdayService.checkAndSendReminders();
        } catch (mErr) {
          console.error('[FlashPeakApp] Error in matchday scheduler:', mErr);
        }
      }

      // Check and send pending outbox messages (asynchronous outbound broadcasts)
      if (this.sender) {
        try {
          await this.processOutboxMessages();
        } catch (oErr) {
          console.error('[FlashPeakApp] Error processing outbox messages:', oErr);
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Processes pending outbound broadcast messages from outbox_messages table.
   */
  public async processOutboxMessages(): Promise<number> {
    if (!this.sender) return 0;
    let sentCount = 0;
    try {
      const res = await this.db.execute({
        sql: `SELECT id, chat_id, message_text FROM outbox_messages WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 5`,
      });
      for (const row of res.rows) {
        const id = String(row.id);
        const chatId = String(row.chat_id) || this.centralGroupJid;
        const text = String(row.message_text);
        if (!chatId) continue;
        try {
          await this.sender.sendText(chatId, text);
          await this.db.execute({
            sql: `UPDATE outbox_messages SET status = 'SENT', sent_at = ? WHERE id = ?`,
            args: [new Date().toISOString(), id],
          });
          sentCount++;
          this.logger.info({ id, chatId }, '[FlashPeakApp] Outbox message sent successfully');
        } catch (sendErr) {
          console.error(`[FlashPeakApp] Failed to send outbox message ${id}:`, sendErr);
          await this.db.execute({
            sql: `UPDATE outbox_messages SET status = 'FAILED', error = ? WHERE id = ?`,
            args: [sendErr instanceof Error ? sendErr.message : String(sendErr), id],
          });
        }
      }
    } catch {
      // Table might not exist yet before migration
    }
    return sentCount;
  }

  /**
   * Stops periodic debounce queue polling.
   */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  // --- Helpers ---
  private async findVersionByMessageKey(messageKey: string): Promise<ReportVersion | null> {
    const res = await this.db.execute({
      sql: `SELECT rv.id FROM report_versions rv
            JOIN report_sessions rs ON rv.report_session_id = rs.id
            JOIN inbound_messages im ON im.report_session_id = rs.id
            WHERE im.provider_message_key = ?
            ORDER BY rv.version_number DESC LIMIT 1`,
      args: [messageKey],
    });
    if (res.rows.length === 0) return null;
    return getReportVersion(this.db, String(res.rows[0][0]));
  }
}

/**
 * Factory function to instantiate FlashPeakApp.
 */
export function createApp(config: FlashPeakAppConfig): FlashPeakApp {
  return new FlashPeakApp(config);
}

// =============================================================================
// Re-exports of all core modules and domain types
// =============================================================================
export * from './shared/types/index.js';
export * from './shared/schemas/index.js';
export * from './db/client.js';
export * from './db/migrate.js';
export * from './identity/resolver.js';
export * from './identity/onboarding.js';
export * from './whatsapp/index.js';
export * from './media/client.js';
export * from './ingestion/index.js';
export * from './ai/index.js';
export * from './reports/index.js';
export * from './competition/index.js';
export * from './stats/index.js';
