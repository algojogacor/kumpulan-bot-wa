/**
 * Flash Peak TMS - Engagement Service (AI-native expansion, D-040)
 *
 * "Hiburan & kehidupan komunitas" — makes the tournament feel alive without
 * ever fabricating data. Three responsibilities:
 *
 * 1. generatePantun()        — pure AI text generation (no factual claims);
 *                              safe to invent at runtime. Theme: Flash Peak /
 *                              tournament / Indonesian gamer community.
 * 2. buildHypeRecap(facts)   — takes REAL facts (score, margin, streaks) from
 *                              the DB and lets AI format the presentation in
 *                              Omak Peak style. AI never invents facts — only
 *                              rephrases. Skipped silently if AI unavailable.
 * 3. buildStandingsCommentary(facts) — same pattern, for group standings.
 * 4. buildChampionCelebration(facts) — tournament completion celebration.
 *
 * The "no hallucination" rule is enforced structurally: every fact passed to
 * the AI is collected by deterministic DB queries; the prompt instructs the AI
 * to use ONLY those facts and to never invent events/metrics not in the list.
 */

import { randomUUID } from 'node:crypto';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';

export interface EngagementDeps {
  providerRouter?: ProviderRouter;
}

export interface HypeFacts {
  stage: 'GROUP' | 'KNOCKOUT';
  team_a_name: string;
  team_b_name: string;
  team_a_score: number;
  team_b_score: number;
  /** Group stage: standings movement context. KO: series score. */
  context_summary: string;
  /** Streaks / form lines from DB, e.g. "Tim X: 3 wins in a row". Empty if none. */
  form_notes: string[];
}

export interface StandingsCommentaryFacts {
  group_code: string;
  rows: Array<{
    team_name: string;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goals_for: number;
    goals_against: number;
    points: number;
  }>;
}

export interface ChampionFacts {
  tournament_name: string;
  champion_team_name: string;
  champion_path_summary: string; // e.g. "QF win 2-0, SF win 2-1, Final win 3-2"
  total_goals_scored_in_tournament?: number;
}

export class EngagementService {
  constructor(private readonly deps: EngagementDeps) {}

  /** !pantun — AI-generated, Flash-Peak/tournament themed. No factual claims. */
  async generatePantun(): Promise<{ success: boolean; text: string }> {
    if (!this.deps.providerRouter) {
      return {
        success: false,
        text: '⚠️ AI provider belum dikonfigurasi — pantun butuh AI.',
      };
    }
    try {
      const response = await this.deps.providerRouter.execute({
        task: 'GENERATE_PANTUN',
        system_prompt:
          'Kamu generator pantun Indonesia 4 baris (ab-ab). Tema: Flash Peak (game 4v4 arcade football), turnamen Gojiha, ' +
          'komunitas game Indonesia. Pantun yang dihasilkan harus asli (bukan template umum), rhyme scheme benar, ' +
          'maksimal 4 baris, bahasa santai. Output HANYA pantunnya (4 baris), tanpa pembukaan/penjelasan.',
        prompt:
          'Buat satu pantun 4 baris (ab-ab) bertema Flash Peak / turnamen Gojiha. Acak temanya: bisa soal skill karakter, ' +
          'match 5 menit, no offside, roster, jadwal, semangat tim, atau vibe komunitas. Jangan ulang pantun yang umum.',
        temperature: 0.9,
        timeout_ms: 15_000,
        correlation_id: `pantun-${randomUUID().slice(0, 8)}`,
      });
      const text = (response.raw_text || '').trim();
      if (!text) {
        return { success: false, text: '⚠️ Pantun gagal dibuat. Coba lagi ya.' };
      }
      // Trim to 4 lines max (in case AI adds explanation).
      const lines = text.split('\n').filter((l) => l.trim()).slice(0, 4);
      return { success: true, text: `🎭 *Pantun Omak Peak:*\n\n${lines.join('\n')}` };
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return { success: false, text: '⚠️ AI provider lagi bermasalah — pantun skip dulu.' };
      }
      return { success: false, text: '⚠️ Gagal bikin pantun. Coba lagi nanti.' };
    }
  }

  /**
   * Build a hype recap message after a match locks. Caller passes REAL facts
   * (collected deterministically). AI formats the presentation only.
   * Returns null if AI unavailable (caller should skip the recap silently).
   */
  async buildHypeRecap(facts: HypeFacts): Promise<string | null> {
    if (!this.deps.providerRouter) return null;
    const factsJson = JSON.stringify(facts, null, 2);
    try {
      const response = await this.deps.providerRouter.execute({
        task: 'FORMAT_HYPE',
        system_prompt:
          'Kamu Omak Peak — asisten turnamen Flash Peak. Bikin komentar hype SINGKAT (2-4 kalimat) soal ' +
          'pertandingan yang baru selesai, bergaya santai dan semangat. ' +
          'ATURAN MUTLAK: HANYA pakai fakta di <facts>. Jangan ngarang event per-menit, narasi temporal di dalam match, ' +
          'atau stat yang tidak ada di facts. Kalau facts minim, bikin komentar umum yang tetap nyambung (margin skor, ' +
          'streak, posisi klasemen) — jangan halusinasi. Bahasa Indonesia santai, WhatsApp-friendly, sedikit emoji.',
        prompt: `<facts>\n${factsJson}\n</facts>\n\nBikin komentar hype 2-4 kalimat untuk pertandingan ini.`,
        temperature: 0.7,
        timeout_ms: 15_000,
        correlation_id: `hype-${randomUUID().slice(0, 8)}`,
      });
      const text = (response.raw_text || '').trim();
      if (!text) return null;
      return `🔥 _Omak Peak: ${text}_`;
    } catch {
      return null; // non-critical
    }
  }

  /**
   * Build a short commentary line for a standings table. Returns null to skip.
   */
  async buildStandingsCommentary(facts: StandingsCommentaryFacts): Promise<string | null> {
    if (!this.deps.providerRouter) return null;
    const factsJson = JSON.stringify(facts, null, 2);
    try {
      const response = await this.deps.providerRouter.execute({
        task: 'FORMAT_HYPE',
        system_prompt:
          'Kamu Omak Peak. Bikin komentar SINGKAT (1-2 kalimat) soal posisi klasemen grup, ' +
          'bergaya santai. HANYA pakai fakta di <facts>. Sebut tim yang "lagi panas" (winning streak / puncak klasemen), ' +
          'atau tim yang perlu waspada (posisi bawah / belum menang). Jangan ngarang streak yang tidak ada di facts. ' +
          'Bahasa Indonesia santai, sedikit emoji.',
        prompt: `<facts>\n${factsJson}\n</facts>\n\nBikin komentar 1-2 kalimat.`,
        temperature: 0.6,
        timeout_ms: 12_000,
        correlation_id: `standings-${randomUUID().slice(0, 8)}`,
      });
      const text = (response.raw_text || '').trim();
      if (!text) return null;
      return `📊 _Omak Peak: ${text}_`;
    } catch {
      return null;
    }
  }

  /**
   * Build a champion celebration message when the tournament completes.
   * Returns null if AI unavailable.
   */
  async buildChampionCelebration(facts: ChampionFacts): Promise<string | null> {
    if (!this.deps.providerRouter) return null;
    const factsJson = JSON.stringify(facts, null, 2);
    try {
      const response = await this.deps.providerRouter.execute({
        task: 'FORMAT_HYPE',
        system_prompt:
          'Kamu Omak Peak. Turnamen Flash Peak baru selesai. Bikin pesan perayaan JUARA yang bersemangat, ' +
          'menggunakan HANYA fakta di <facts>. Sebut nama juara, ringkas jalannya juara (path), total gol jika ada. ' +
          'Bahasa Indonesia santai, hype, emoji secukupnya. Jangan ngarang stat/detail yang tidak ada di facts.',
        prompt: `<facts>\n${factsJson}\n</facts>\n\nBikin pesan perayaan juara.`,
        temperature: 0.8,
        timeout_ms: 15_000,
        correlation_id: `champion-${randomUUID().slice(0, 8)}`,
      });
      const text = (response.raw_text || '').trim();
      if (!text) return null;
      return `👑🏆🎉\n${text}`;
    } catch {
      return null;
    }
  }
}
