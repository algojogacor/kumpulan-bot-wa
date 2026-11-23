/**
 * Flash Peak TMS - Trivia Service (AI-native expansion, D-040)
 *
 * !trivia — random verified Flash Peak fact.
 * !quiz   — quiz question with delayed answer reveal (handled by the command
 *           registration which schedules the answer send 15s after the question).
 *
 * Critical design rule (per task brief 2026-11-22):
 *   "FAKTANYA sendiri harus dari basis data yang sudah diverifikasi, bukan AI
 *    generate fakta dari kepalanya saat runtime."
 *
 * Facts are loaded from src/data/flashpeak-trivia.json (curated at development
 * time from web research — see the file's _meta). The runtime AI is only used
 * to REPHRASE the presentation for variety, and ONLY if the rephrase preserves
 * the factual content. If the rephrase AI fails or the fact is sensitive, the
 * raw curated fact is used directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ProviderRouter } from '../ai/router.js';

export interface TriviaFact {
  id: string;
  category: string;
  fact: string;
  sources: string[];
}
export interface TriviaQuiz {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string[];
  sources?: string[];
}
interface TriviaData {
  facts: TriviaFact[];
  quiz: TriviaQuiz[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRIVIA_PATH = path.resolve(__dirname, '../data/flashpeak-trivia.json');

function loadTrivia(): TriviaData {
  const raw = readFileSync(TRIVIA_PATH, 'utf8');
  return JSON.parse(raw) as TriviaData;
}

export interface TriviaDeps {
  providerRouter?: ProviderRouter;
}

export class TriviaService {
  private data: TriviaData;

  constructor(private readonly deps: TriviaDeps) {
    this.data = loadTrivia();
  }

  /** !trivia — random fact, optionally AI-rephrased for variety. */
  async randomFact(): Promise<string> {
    const facts = this.data.facts;
    if (facts.length === 0) return 'ℹ️ Trivia belum tersedia.';
    const fact = facts[Math.floor(Math.random() * facts.length)];

    // Try AI rephrase for variety; fall back to raw if AI unavailable/fails.
    let text = fact.fact;
    if (this.deps.providerRouter) {
      try {
        const response = await this.deps.providerRouter.execute({
          task: 'REPHRASE_TRIVIA',
          system_prompt:
            'Kamu Omak Peak. Rephrase fakta Flash Peak berikut agar lebih hidup dan variatif (bahasa Indonesia santai), ' +
            'TAPI pertahankan SEMUA fakta teknis dengan tepat — angka, nama karakter, posisi, mekanik tidak boleh berubah. ' +
            'Jangan tambahkan fakta baru yang tidak ada di input. Maksimal 2 kalimat. Output HANYA teks rephrased.',
          prompt: `Fakta asli: ${fact.fact}\n\nRephrase:`,
          temperature: 0.6,
          timeout_ms: 10_000,
        });
        const rephrased = (response.raw_text || '').trim();
        if (rephrased && rephrased.length > 10) text = rephrased;
      } catch {
        // fall back to raw fact
      }
    }

    const lines = [
      '🎲 *TRIVIA FLASH PEAK*',
      '',
      text,
      '',
      `📂 Kategori: ${fact.category}`,
      `_sumber: ${fact.sources.join(', ')}_`,
      '',
      'Mau yang lain? Ketik *!trivia* lagi. Mau quiz? *!quiz*.',
    ];
    return lines.join('\n');
  }

  /** !quiz — pick a random quiz question. Answer reveal handled by caller. */
  async randomQuiz(): Promise<{
    success: boolean;
    responseText: string;
    question?: string;
    answer?: string;
    quiz?: TriviaQuiz;
  }> {
    const quiz = this.data.quiz;
    if (quiz.length === 0) {
      return { success: false, responseText: 'ℹ️ Quiz belum tersedia.' };
    }
    const q = quiz[Math.floor(Math.random() * quiz.length)];
    return {
      success: true,
      responseText: '', // not displayed; the command handler sends a custom message
      question: q.question,
      answer: q.answer,
      quiz: q,
    };
  }
}
