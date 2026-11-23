/**
 * Flash Peak TMS - AI-Native Command Registration (AI-native expansion)
 *
 * Registers the new AI-native commands added by the 2026-11-22 expansion:
 *   !ai              — Omak Peak read-only chat (any role)
 *   !agent           — organizer AI agent: NL instruction -> plan -> confirm -> execute
 *   !agentconfirm    — confirm a staged plan by its short code (idempotency enforced)
 *   !agentcancel     — cancel a staged plan by its short code
 *   !qna             — list the living FAQ (any role)
 *   !saveqna         — organizer: AI-extract Q&A pairs from recent group messages
 *   !trivia          — random verified Flash Peak fact (any role)
 *   !quiz            — quiz question with delayed answer reveal (any role)
 *   !pantun          — AI-generated pantun, Flash-Peak/tournament themed (any role)
 *
 * Kept in a dedicated module so tournament-commands.ts does not grow further;
 * the modularization precedent (src/index.ts -> src/application/) is continued.
 */

import type { CommandRouter } from '../whatsapp/router.js';
import type { CommandContext } from '../whatsapp/types.js';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import { OmakPeakService } from './omak-peak.js';
import { AgentPlannerService } from './agent-planner.js';
import { buildDefaultAgentActionCatalog } from './agent-actions.js';
import { QnaService } from './qna.js';
import { EngagementService } from './engagement.js';
import { TriviaService } from './trivia.js';
import { QuizSessionManager } from './quiz-session.js';

export interface AiNativeCommandDeps {
  db: Client;
  providerRouter?: ProviderRouter;
  sender?: WhatsAppSender;
  centralGroupJid?: string;
  quizSessionManager?: QuizSessionManager;
}

/**
 * Registers all AI-native commands onto the given router.
 * Returns the instantiated services so the caller (FlashPeakApp) can wire
 * engagement hooks (e.g. match-lock hype recap) into the existing pipelines.
 */
export function registerAiNativeCommands(
  router: CommandRouter,
  deps: AiNativeCommandDeps
): {
  omakPeak: OmakPeakService;
  agent: AgentPlannerService;
  qna: QnaService;
  engagement: EngagementService;
  trivia: TriviaService;
  quizSessionManager: QuizSessionManager;
} {
  const omakPeak = new OmakPeakService({ db: deps.db, providerRouter: deps.providerRouter });
  const actionCatalog = buildDefaultAgentActionCatalog(deps.db);
  const agent = new AgentPlannerService({
    db: deps.db,
    providerRouter: deps.providerRouter,
    actionCatalog,
  });
  const qna = new QnaService({ db: deps.db, providerRouter: deps.providerRouter });
  const engagement = new EngagementService({ providerRouter: deps.providerRouter });
  const trivia = new TriviaService({ providerRouter: deps.providerRouter });
  const quizSessionManager =
    deps.quizSessionManager ??
    new QuizSessionManager({
      db: deps.db,
      durationMs: 15_000,
      providerRouter: deps.providerRouter,
    });

  // -------------------------------------------------------------------------
  // !ai  —  read-only chat with Omak Peak (any role, group + DM)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'ai',
    requiredRole: 'ANY',
    description: 'Tanya Omak Peak apa aja (turnamen, Flash Peak, atau ngobrol santai). Read-only.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const userMessage = ctx.rawArgs;
      const res = await omakPeak.handleAiCommand(
        ctx.message.sender_raw_address,
        userMessage,
        ctx.message.chat_id,
        ctx.message.push_name || undefined
      );
      return {
        success: !res.rateLimited,
        responseText: res.replyText,
        metadata: res.rateLimited ? { rateLimited: true, retryAfterSeconds: res.retryAfterSeconds } : undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // !agent  —  organizer AI agent: NL instruction -> plan (preview, no execute)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agent',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] AI agent: susun rencana aksi dari instruksi bahasa natural (preview + butuh !agentconfirm).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const res = await agent.planFromInstruction({
        instruction: ctx.rawArgs,
        organizerAddress: ctx.message.sender_raw_address,
        organizerDelegateId: ctx.delegateId,
        chatId: ctx.message.chat_id,
      });
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !agentconfirm <code>  —  execute a staged plan (idempotent via plan_code)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agentconfirm',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Konfirmasi & eksekusi rencana AI agent berdasarkan kode plan (idempotent).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const code = (ctx.args[0] || '').trim().toUpperCase();
      if (!code) {
        return {
          success: false,
          responseText: '⚠️ Pakai seperti: *!agentconfirm AGENT-XXXX* (kode plan dari !agent).',
        };
      }
      const res = await agent.confirmAndExecute(code, ctx.message.sender_raw_address);
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !agentcancel <code>  —  cancel a staged plan
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agentcancel',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Batalkan rencana AI agent yang masih pending.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const code = (ctx.args[0] || '').trim().toUpperCase();
      if (!code) {
        return {
          success: false,
          responseText: '⚠️ Pakai seperti: *!agentcancel AGENT-XXXX*.',
        };
      }
      const res = await agent.cancelPlan(code, ctx.message.sender_raw_address);
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !qna  —  list the living FAQ (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'qna',
    requiredRole: 'ANY',
    description: 'Lihat daftar pertanyaan-jawaban yang sudah terkumpul (FAQ hidup turnamen).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await qna.listEntries();
      return { success: true, responseText: res };
    },
  });

  // -------------------------------------------------------------------------
  // !saveqna [n]  —  organizer: AI-extract Q&A from last n (default 10) group msgs
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'saveqna',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Ekstrak pasangan Q&A dari N pesan terakhir grup (default 10) lewat AI.',
    allowedInDm: false,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const nArg = parseInt(ctx.args[0] || '', 10);
      const n = Number.isFinite(nArg) && nArg > 0 ? Math.min(50, nArg) : 10;
      const res = await qna.extractAndSave({
        chatId: ctx.message.chat_id,
        count: n,
        organizerAddress: ctx.message.sender_raw_address,
        organizerDelegateId: ctx.delegateId,
      });
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !trivia  —  random verified Flash Peak fact (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'trivia',
    requiredRole: 'ANY',
    description: 'Fakta acak soal Flash Peak (dari basis data terverifikasi, bukan karangan AI).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await trivia.randomFact();
      return { success: true, responseText: res };
    },
  });

  // -------------------------------------------------------------------------
  // !quiz / !kuis  —  interactive 15-second real-time quiz (any role)
  // -------------------------------------------------------------------------
  const handleQuiz = async (ctx: CommandContext) => {
    const targetChat = ctx.message.chat_id || deps.centralGroupJid;
    if (!targetChat) {
      return { success: false, responseText: '⚠️ Target grup tidak ditemukan.' };
    }

    if (quizSessionManager.hasActiveQuiz(targetChat)) {
      const rem = quizSessionManager.getRemainingSeconds(targetChat);
      return {
        success: true,
        responseText: `⚠️ *Kuis masih berlangsung!* Sisa waktu: *${rem} detik*. Ayo jawab sekarang!`,
      };
    }

    const res = await trivia.randomQuiz();
    if (!res.success || !res.quiz) {
      return { success: false, responseText: res.responseText || 'ℹ️ Quiz belum tersedia.' };
    }

    const quizItem = res.quiz;
    const senderRef = deps.sender;

    const startRes = quizSessionManager.startQuiz(targetChat, quizItem, async (active) => {
      // Timeout callback: called when 15 seconds elapse with no correct answer
      if (senderRef) {
        try {
          await senderRef.sendText(
            targetChat,
            [
              '⏰ *WAKTU HABIS!* (15 detik)',
              'Belum ada yang berhasil menebak dengan benar.',
              '',
              `💡 *Jawaban yang benar:* ${active.quiz.answer}`,
              '',
              '_Mau coba lagi? Ketik *!quiz*!_',
            ].join('\n')
          );
        } catch {
          // best-effort
        }
      }
    });

    if (!startRes.success || !startRes.quiz) {
      return {
        success: true,
        responseText: `⚠️ *Kuis masih berlangsung!* Sisa waktu: *${startRes.remainingSeconds} detik*. Ayo tebak dulu!`,
      };
    }

    // Send the question immediately
    try {
      if (senderRef) {
        await senderRef.sendText(
          targetChat,
          [
            '❓ *QUIZ FLASH PEAK (15 DETIK!)* ⏱️',
            '',
            quizItem.question,
            '',
            '👉 *Ketik jawabanmu langsung di grup sekarang!*',
            '_Jawaban ditutup otomatis dalam 15 detik._',
          ].join('\n')
        );
      }
    } catch {
      quizSessionManager.cancelQuiz(targetChat);
      return { success: false, responseText: '⚠️ Gagal mengirim pertanyaan kuis.' };
    }

    return { success: true, responseText: '' };
  };

  for (const cmd of ['quiz', 'kuis']) {
    router.registerCommand({
      command: cmd,
      requiredRole: 'ANY',
      description: 'Kuis Flash Peak 15 detik! Tebak langsung di grup, rebutan poin leaderboard.',
      allowedInDm: true,
      allowedInGroup: true,
      handler: handleQuiz,
    });
  }

  // -------------------------------------------------------------------------
  // !topquiz / !quizleaderboard / !kuisleaderboard / !topkuis  —  quiz leaderboard
  // -------------------------------------------------------------------------
  const handleTopQuiz = async (ctx: CommandContext) => {
    const chatId = ctx.message.chat_id || deps.centralGroupJid;
    const rows = await quizSessionManager.getLeaderboard(chatId, 10);
    return {
      success: true,
      responseText: quizSessionManager.formatLeaderboard(rows),
    };
  };

  for (const cmd of ['topquiz', 'quizleaderboard', 'kuisleaderboard', 'topkuis']) {
    router.registerCommand({
      command: cmd,
      requiredRole: 'ANY',
      description: 'Leaderboard kuis seru-seruan komunitas Flash Peak.',
      allowedInDm: true,
      allowedInGroup: true,
      handler: handleTopQuiz,
    });
  }

  // -------------------------------------------------------------------------
  // !pantun  —  AI-generated pantun, Flash-Peak/tournament themed (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'pantun',
    requiredRole: 'ANY',
    description: 'Pantun acak bergaya Flash Peak / turnamen (generate AI, bukan klaim fakta).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await engagement.generatePantun();
      return { success: res.success, responseText: res.text };
    },
  });

  // -------------------------------------------------------------------------
  // !aistatus  —  statistics of AI providers usage (any role, group + DM)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'aistatus',
    requiredRole: 'ANY',
    description: 'Lihat statistik & rekap penggunaan AI / LLM multi-provider turnamen.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async () => {
      try {
        const res = await deps.db.execute(`
          SELECT 
            provider,
            COUNT(*) as total_calls,
            SUM(CASE WHEN request_status = 'SUCCESS' THEN 1 ELSE 0 END) as success_calls,
            ROUND(AVG(latency_ms)) as avg_latency,
            SUM(COALESCE(input_units, 0)) as total_input_tokens,
            SUM(COALESCE(output_units, 0)) as total_output_tokens
          FROM provider_usage
          GROUP BY provider
          ORDER BY total_calls DESC
        `);

        if (res.rows.length === 0) {
          const breakers = deps.providerRouter ? deps.providerRouter.getCircuitBreakerStatuses() : {};
          const activeList = Object.entries(breakers)
            .map(([p, s]) => `• *${p}*: ${s.state === 'CLOSED' ? '🟢 Aktif (CLOSED)' : `🔴 Gangguan (${s.state})`}`)
            .join('\n');

          return {
            success: true,
            responseText: [
              '📊 *STATISTIK PENGGUNAAN AI / LLM TURNAMEN* 🤖',
              '──────────────────────────────',
              'Belum ada riwayat request tercatat di database.',
              '',
              '🔌 *Status Health Provider:*',
              activeList || '• Multi-provider router standby.',
              '──────────────────────────────',
              '💡 _Prioritas teks: Mistral ➔ Groq ➔ Nvidia NIM ➔ Cohere ➔ Gemini ➔ DeepSeek (hemat saldo)._',
            ].join('\n'),
          };
        }

        const lines = [
          '📊 *STATISTIK PENGGUNAAN AI / LLM TURNAMEN* 🤖',
          '──────────────────────────────',
        ];

        for (const row of res.rows) {
          const p = String(row.provider);
          const total = Number(row.total_calls);
          const success = Number(row.success_calls);
          const avgLat = Number(row.avg_latency);
          const inTok = Number(row.total_input_tokens);
          const outTok = Number(row.total_output_tokens);
          lines.push(`• *${p}*: ${total} calls (✅ ${success} sukses) | Avg: ${avgLat}ms | Tokens: ${inTok + outTok}`);
        }

        lines.push('──────────────────────────────');
        lines.push('💡 _Prioritas teks: Mistral ➔ Groq ➔ Nvidia NIM ➔ Cohere ➔ Gemini ➔ DeepSeek (hemat saldo)._');
        return {
          success: true,
          responseText: lines.join('\n'),
        };
      } catch {
        return {
          success: false,
          responseText: '⚠️ Gagal membaca statistik penggunaan AI.',
        };
      }
    },
  });

  return { omakPeak, agent, qna, engagement, trivia, quizSessionManager };
}
