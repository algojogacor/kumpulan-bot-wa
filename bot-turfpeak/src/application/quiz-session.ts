/**
 * Flash Peak TMS - Interactive Quiz Session Manager
 *
 * Real-time active quiz state machine for community engagement.
 * Manages 15-second fast-paced arcade quiz turns, answer evaluation,
 * timeout callbacks, and scoring into the persistent quiz_scores table.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';

export interface QuizQuestion {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string[];
  sources?: string[];
}

export interface ActiveQuiz {
  chatId: string;
  quiz: QuizQuestion;
  startedAt: number;
  expiresAt: number;
  timeoutHandle: NodeJS.Timeout;
}

export interface QuizLeaderboardEntry {
  rank: number;
  participant_name: string;
  score: number;
}

/**
 * Normalizes input text and checks whether it matches any of the quiz keywords.
 * Supports exact single-word tokens, numbers with decimals (e.g. 0.3 or 0,3),
 * percentage values, and multi-word phrases.
 */
export function isQuizAnswerMatch(input: string, keywords: string[]): boolean {
  if (!input || !keywords || keywords.length === 0) return false;

  // 1. Normalize comma in decimal numbers (e.g. "0,3" -> "0.3") and preserve dots/percentages
  const cleanInput = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/(\d+),(\d+)/g, '$1.$2')
    .replace(/[^\w\s.%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanInput) return false;

  const words = cleanInput.split(/\s+/).filter(Boolean);

  for (const kw of keywords) {
    const cleanKw = kw
      .toLowerCase()
      .trim()
      .replace(/(\d+),(\d+)/g, '$1.$2')
      .replace(/[^\w\s.%]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanKw) continue;

    // Multi-word phrase (e.g. "guided pulse pass", "free fire", "world class", "0.3 detik")
    if (cleanKw.includes(' ')) {
      if (cleanInput.includes(cleanKw)) {
        return true;
      }
    } else {
      // Single-word token (e.g. "oscar", "kelly", "steffie", "280", "18", "0.3", "5", "1")
      if (words.includes(cleanKw) || cleanInput === cleanKw) {
        return true;
      }
    }
  }

  return false;
}

export interface QuizSessionManagerDeps {
  db: Client;
  durationMs?: number; // default 15_000 (15 seconds)
  providerRouter?: ProviderRouter;
}

export class QuizSessionManager {
  private readonly db: Client;
  private readonly durationMs: number;
  private readonly providerRouter?: ProviderRouter;
  private activeQuizzes = new Map<string, ActiveQuiz>();

  constructor(deps: QuizSessionManagerDeps) {
    this.db = deps.db;
    this.durationMs = deps.durationMs ?? 15_000;
    this.providerRouter = deps.providerRouter;
  }

  /**
   * Checks whether a quiz is currently running in this chat.
   */
  hasActiveQuiz(chatId: string): boolean {
    const active = this.activeQuizzes.get(chatId.toLowerCase());
    if (!active) return false;
    if (Date.now() >= active.expiresAt) {
      this.cancelQuiz(chatId);
      return false;
    }
    return true;
  }

  /**
   * Returns remaining seconds for active quiz in this chat.
   */
  getRemainingSeconds(chatId: string): number {
    const active = this.activeQuizzes.get(chatId.toLowerCase());
    if (!active) return 0;
    const rem = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000));
    return rem;
  }

  /**
   * Starts a new 15-second quiz in the chat.
   */
  startQuiz(
    chatId: string,
    quiz: QuizQuestion,
    onTimeout: (active: ActiveQuiz) => Promise<void>
  ): { success: boolean; quiz?: ActiveQuiz; remainingSeconds?: number } {
    const key = chatId.toLowerCase();
    if (this.hasActiveQuiz(key)) {
      return {
        success: false,
        remainingSeconds: this.getRemainingSeconds(key),
      };
    }

    const now = Date.now();
    const expiresAt = now + this.durationMs;

    const timeoutHandle = setTimeout(async () => {
      const current = this.activeQuizzes.get(key);
      if (current) {
        this.activeQuizzes.delete(key);
        try {
          await onTimeout(current);
        } catch (err) {
          console.error('[QuizSessionManager] onTimeout callback error:', err);
        }
      }
    }, this.durationMs);

    const active: ActiveQuiz = {
      chatId,
      quiz,
      startedAt: now,
      expiresAt,
      timeoutHandle,
    };

    this.activeQuizzes.set(key, active);
    return { success: true, quiz: active };
  }

  /**
   * Evaluates an incoming message against the active quiz.
   * Priority:
   * 1. Fast deterministic keyword match (0ms latency, zero tokens, instant celebration).
   * 2. Casual chatter / laughter filter to avoid spamming "Kurang tepat" on banter.
   * 3. LLM semantic evaluation fallback if keywords did not match (judges whether the
   *    answer is semantically correct, incorrect, or not an answer attempt).
   */
  async evaluateAnswer(
    chatId: string,
    text: string
  ): Promise<{
    isAnswerToQuiz: boolean;
    isCorrect: boolean;
    active?: ActiveQuiz;
    elapsedSeconds: number;
    judgedBy: 'KEYWORD' | 'LLM' | 'NONE';
  }> {
    const key = chatId.toLowerCase();
    const active = this.activeQuizzes.get(key);
    if (!active) {
      return { isAnswerToQuiz: false, isCorrect: false, elapsedSeconds: 0, judgedBy: 'NONE' };
    }

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));

    // Priority 1: Fast deterministic keyword match
    if (isQuizAnswerMatch(text, active.quiz.keywords)) {
      return {
        isAnswerToQuiz: true,
        isCorrect: true,
        active,
        elapsedSeconds,
        judgedBy: 'KEYWORD',
      };
    }

    const trimmed = text.trim();

    // Filter out obvious casual chatter / laughter to prevent spamming "Kurang tepat"
    const isObviousBanter =
      /^(?:[wk]+|[ha]+|[he]+|[wko]+|anj+|jir|gilak|lah|woe|woy|anjir|bjir|ngakak|capek|pake laptop)\b/i.test(trimmed) ||
      trimmed.length < 1;

    if (isObviousBanter) {
      return {
        isAnswerToQuiz: false,
        isCorrect: false,
        active,
        elapsedSeconds,
        judgedBy: 'NONE',
      };
    }

    // Priority 2: LLM semantic evaluation fallback if keyword did not match
    if (this.providerRouter && trimmed.length >= 1) {
      try {
        const judgePrompt = `Kamu adalah juri penilai kuis trivia game Flash Peak.
Pertanyaan: "${active.quiz.question}"
Kunci Jawaban Resmi: "${active.quiz.answer}"
Pesan Peserta: "${trimmed}"

Tugas:
1. Jika pesan peserta secara makna BENAR dan menjawab pertanyaan di atas (termasuk sinonim, kalimat santai, atau angka yang setara), jawab: BENAR
2. Jika pesan peserta adalah tebakan/jawaban kuis tapi SALAH, jawab: SALAH
3. Jika pesan peserta sama sekali BUKAN tebakan kuis (misal sekadar obrolan santai, tawa, atau komentar tidak jelas), jawab: BUKAN_JAWABAN

Jawab HANYA satu kata: BENAR, SALAH, atau BUKAN_JAWABAN.`;

        const resp = await this.providerRouter.execute<string>({
          task: 'CHAT_OMAK_PEAK',
          system_prompt: 'Kamu adalah juri kuis presisi. Jawab HANYA satu kata: BENAR, SALAH, atau BUKAN_JAWABAN.',
          prompt: judgePrompt,
          temperature: 0.1,
          timeout_ms: 3500,
          correlation_id: `quiz-judge-${randomUUID().slice(0, 8)}`,
        });

        const rawReply = (resp.raw_text || '').trim().toUpperCase();
        if (rawReply.includes('BENAR')) {
          return {
            isAnswerToQuiz: true,
            isCorrect: true,
            active,
            elapsedSeconds,
            judgedBy: 'LLM',
          };
        }
        if (rawReply.includes('BUKAN_JAWABAN')) {
          return {
            isAnswerToQuiz: false,
            isCorrect: false,
            active,
            elapsedSeconds,
            judgedBy: 'LLM',
          };
        }
        if (rawReply.includes('SALAH')) {
          return {
            isAnswerToQuiz: true,
            isCorrect: false,
            active,
            elapsedSeconds,
            judgedBy: 'LLM',
          };
        }
      } catch {
        // If LLM fails or times out, fallback to treating as normal attempt
      }
    }

    return {
      isAnswerToQuiz: true,
      isCorrect: false,
      active,
      elapsedSeconds,
      judgedBy: 'NONE',
    };
  }

  /**
   * Cancels/closes the active quiz immediately (e.g. when someone answered correctly).
   */
  cancelQuiz(chatId: string): void {
    const key = chatId.toLowerCase();
    const active = this.activeQuizzes.get(key);
    if (active) {
      clearTimeout(active.timeoutHandle);
      this.activeQuizzes.delete(key);
    }
  }

  /**
   * Records a correct answer win in the database and returns the participant's updated score.
   */
  async recordWin(
    chatId: string,
    senderRawAddress: string,
    participantName: string
  ): Promise<number> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.execute({
      sql: `
        INSERT INTO quiz_scores (id, chat_id, sender_raw_address, participant_name, score, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(chat_id, sender_raw_address) DO UPDATE SET
          score = score + 1,
          participant_name = excluded.participant_name,
          updated_at = excluded.updated_at
      `,
      args: [id, chatId, senderRawAddress, participantName, now, now],
    });

    const res = await this.db.execute({
      sql: `SELECT score FROM quiz_scores WHERE chat_id = ? AND sender_raw_address = ?`,
      args: [chatId, senderRawAddress],
    });

    return Number(res.rows[0]?.score ?? 1);
  }

  /**
   * Retrieves the top quiz scorers for this chat (or global).
   */
  async getLeaderboard(chatId?: string, limit = 10): Promise<QuizLeaderboardEntry[]> {
    let sql: string;
    let args: any[];

    if (chatId) {
      sql = `SELECT participant_name, score FROM quiz_scores WHERE chat_id = ? ORDER BY score DESC, updated_at ASC LIMIT ?`;
      args = [chatId, limit];
    } else {
      sql = `SELECT participant_name, SUM(score) as score FROM quiz_scores GROUP BY sender_raw_address ORDER BY score DESC, updated_at ASC LIMIT ?`;
      args = [limit];
    }

    try {
      const res = await this.db.execute({ sql, args });
      return res.rows.map((r, i) => ({
        rank: i + 1,
        participant_name: String(r.participant_name),
        score: Number(r.score),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Formats the quiz leaderboard into a clean WhatsApp message.
   */
  formatLeaderboard(rows: QuizLeaderboardEntry[]): string {
    if (rows.length === 0) {
      return [
        '🎮 *LEADERBOARD KUIS FLASH PEAK* 🏆',
        '_Ajang seru-seruan komunitas tongkrongan_',
        '──────────────────────────────',
        '',
        'Belum ada skor kuis tercatat di grup ini.',
        'Ketik *!quiz* untuk mulai bermain dan jadilah juara kuis pertama! 🥇',
      ].join('\n');
    }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const lines: string[] = [
      '🎮 *LEADERBOARD KUIS FLASH PEAK* 🏆',
      '_Ajang seru-seruan komunitas tongkrongan_',
      '──────────────────────────────',
      '',
    ];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const badge = medals[i] || `${i + 1}.`;
      lines.push(`${badge} *${row.participant_name}* — ${row.score} Poin Kuis`);
    }

    lines.push('');
    lines.push('──────────────────────────────');
    lines.push('💡 _Kuis ini murni seru-seruan (tidak mempengaruhi klasemen turnamen). Ketik *!quiz* untuk main!_');

    return lines.join('\n');
  }
}
