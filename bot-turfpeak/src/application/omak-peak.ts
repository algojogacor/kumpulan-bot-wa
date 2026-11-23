/**
 * Flash Peak TMS - Omak Peak Application Service (AI-native expansion, D-037)
 *
 * Implements the !ai command (read-only chat with the Omak Peak persona) and
 * the engagement commentary hooks used by other modules (standings commentary,
 * match-lock hype recap, champion celebration) — all grounded in real DB data.
 *
 * !ai behavior (per task brief 2026-11-22):
 * - Open-scope: any question is allowed; the only hard limits are read-only
 *   guarantee, safety, and operational-data secrecy.
 * - Rate limit: rolling window, max 2 uses per user per 60 seconds. Rejects
 *   with a clear Omak-Peak-voiced message stating when to retry.
 * - Persona: "Omak Peak" — already publicly introduced by Arya (organizer) on
 *   2026-11-21. Santai, confident, occasionally Flash-Peak-flavored.
 * - First-use / no-arg invocation: returns a short intro so the persona is
 *   discoverable without a state write (read-only invariant preserved).
 *
 * Engagement commentary (D-040): buildHypeRecap / buildStandingsCommentary /
 * buildChampionCelebration take FACTS from the DB (score margins, streaks,
 * standings movement) and let AI format the presentation. The AI never invents
 * facts — only rephrases. If AI is unavailable, the engagement message is
 * skipped silently (non-critical).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';
import { AIError } from '../ai/adapter.js';
import { buildOmakPeakPrompt } from '../ai/prompts/omak-peak.js';
import type { OmakPeakContext } from '../ai/prompts/omak-peak-context.js';
import { FLASH_PEAK_GAME_KNOWLEDGE } from '../ai/prompts/flashpeak-game-knowledge.js';

// =============================================================================
// Output normalization — never post raw AI wrappers into the chat.
//
// Some models wrap a chat reply in an ad-hoc JSON envelope
// ({"thinking": ..., "speak": ...}) even WITHOUT json_object mode being forced
// (observed in prod 2026-11-22 when a legacy adapter forced JSON mode onto
// CHAT_OMAK_PEAK). If that happens, extract the spoken part only; the
// "thinking" field is internal reasoning and must never leak to the group.
// =============================================================================

function extractSpeakText(rawText: string): string {
  let t = (rawText || '').trim();
  // Strip markdown code fences if present.
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t) as { speak?: unknown };
      if (typeof obj.speak === 'string' && obj.speak.trim()) {
        return obj.speak.trim();
      }
    } catch {
      // Not valid JSON — treat as plain chat text.
    }
  }
  return t;
}

// =============================================================================
// Rolling-window rate limiter (in-memory; restart resets are acceptable for
// short abuse windows). 2 uses per 60s per sender per the task brief.
// =============================================================================

export class RollingRateLimiter {
  private uses = new Map<string, number[]>();
  constructor(
    private readonly maxUses: number,
    private readonly windowMs: number
  ) {}

  /**
   * Returns {allowed: true} if the caller may proceed, or {allowed: false,
   * retryAfterMs} with the milliseconds until the oldest in-window use expires.
   * On allow, records the use timestamp.
   */
  check(sender: string, now: number = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const arr = (this.uses.get(sender) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.maxUses) {
      const oldest = arr[0];
      const retryAfterMs = Math.max(1000, this.windowMs - (now - oldest));
      return { allowed: false, retryAfterMs: Math.ceil(retryAfterMs / 1000) * 1000 };
    }
    arr.push(now);
    this.uses.set(sender, arr);
    return { allowed: true };
  }

  /** Test helper: reset a sender's history. */
  reset(sender: string): void {
    this.uses.delete(sender);
  }
}

// =============================================================================
// Conversation memory — rolling per-group ring buffer of recent !ai turns.
//
// Omak Peak was originally stateless (each !ai call = a fresh cold turn), which
// produced jarring UX in fast-moving group chats: a user replying "coba tebak
// terserah" right after another user's "siapa juara" got a confused "percakapan
// baru mulai" reply. This buffer keeps the last N Q&A pairs per central group
// chat (with a TTL so stale context drops off), in-memory only — no DB writes
// (read-only invariant preserved). Restart resets it; that is acceptable for a
// community chat-assistant context.
// =============================================================================

export interface MemoryTurn {
  senderLabel: string;
  question: string;
  answer: string;
  ts: number; // epoch ms
}

export class ConversationMemory {
  private readonly turns = new Map<string, MemoryTurn[]>();

  constructor(
    private readonly maxTurns = 6,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** Append a Q&A turn for a chat, trimming to the last maxTurns. */
  record(chatId: string, senderLabel: string, question: string, answer: string): void {
    const key = this.key(chatId);
    const arr = (this.turns.get(key) || []).filter((t) => this.now() - t.ts < this.ttlMs);
    arr.push({ senderLabel, question, answer, ts: this.now() });
    while (arr.length > this.maxTurns) arr.shift();
    this.turns.set(key, arr);
  }

  /** Return fresh (within-TTL) turns for a chat, oldest first. Lazily prunes. */
  recent(chatId: string): MemoryTurn[] {
    const key = this.key(chatId);
    const arr = this.turns.get(key);
    if (!arr || arr.length === 0) return [];
    const cutoff = this.now() - this.ttlMs;
    const fresh = arr.filter((t) => t.ts >= cutoff);
    if (fresh.length !== arr.length) this.turns.set(key, fresh);
    return fresh;
  }

  /** Test helper. */
  reset(chatId?: string): void {
    if (chatId) this.turns.delete(this.key(chatId));
    else this.turns.clear();
  }

  private key(chatId: string): string {
    return (chatId || '_default').toLowerCase();
  }
}

// =============================================================================
// Omak Peak service
// =============================================================================

export interface OmakPeakDeps {
  db: Client;
  providerRouter?: ProviderRouter;
  /** Injected for tests; defaults to a real RollingRateLimiter in production. */
  rateLimiter?: RollingRateLimiter;
  /** Injected for tests; defaults to a real ConversationMemory in production. */
  conversationMemory?: ConversationMemory;
}

export const OMAK_PEAK_INTRO = `👋 *Omak Peak here.*\n\nAku asisten otomatis turnamen Flash Peak (Gojiha Tournament) di grup ini. Bisa ditanya apa aja — jadwal, hasil, klasemen, aturan, atau sekadar ngobrol soal Flash Peak. Aku read-only: nggak bisa ubah apa pun di sistem, bukan itu peranku. Kalau lo butuh aksi (ubah hasil, reopen, dll), ke Panitia Arya langsung.\n\nCaranya: ketik *!ai <pertanyaan>*. Contoh:\n• *!ai siapa lawan tim aku besok?*\n• *!ai gimana aturan WO?*\n• *!ai skill Homer apa?*\n\n_2x per menit per user, ya — biar adil buat semua._`;

/**
 * Safely bounds chat responses to prevent runaway hallucination or spam,
 * cleanly truncating at the last paragraph/sentence boundary if exceeding maxLen.
 */
export function smartTruncate(text: string, maxLen = 5000): string {
  if (text.length <= maxLen) return text;
  const sub = text.slice(0, maxLen);
  const lastBreak = Math.max(sub.lastIndexOf('\n'), sub.lastIndexOf('. '));
  const cutoff = lastBreak > maxLen * 0.7 ? lastBreak + 1 : maxLen;
  return sub.slice(0, cutoff).trimEnd() + '\n\n_(Pesan terpotong pada batas maksimal 5.000 karakter)_';
}

export class OmakPeakService {
  private readonly rateLimiter: RollingRateLimiter;
  private readonly memory: ConversationMemory;

  constructor(private readonly deps: OmakPeakDeps) {
    this.rateLimiter = deps.rateLimiter ?? new RollingRateLimiter(2, 60_000);
    this.memory = deps.conversationMemory ?? new ConversationMemory();
  }

  /**
   * Handles the !ai command.
   * Returns the reply text (and optional metadata). Never throws — AI failures
   * surface as a friendly Omak-Peak-voiced fallback message.
   *
   * `chatId` scopes the rolling conversation memory to this group chat so
   * follow-up turns (across users) get continuity. `senderLabel` (typically
   * the WA push_name) is stored in memory so the model can attribute prior
   * turns to a speaker; both fall back gracefully if absent.
   */
  async handleAiCommand(
    senderRawAddress: string,
    userMessage: string,
    chatId: string,
    senderLabel?: string
  ): Promise<{ replyText: string; rateLimited: boolean; retryAfterSeconds?: number }> {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return { replyText: OMAK_PEAK_INTRO, rateLimited: false };
    }

    const gate = this.rateLimiter.check(senderRawAddress);
    if (!gate.allowed) {
      const secs = Math.ceil(gate.retryAfterMs / 1000);
      return {
        replyText:
          `⏳ Sabar ya, Omak Peak lagi cooldown. Kamu baru aja nanya dua kali berturut-turut — ` +
          `coba lagi dalam *${secs} detik* biar quota-nya balik. (Batas: 2x per menit per user.)`,
        rateLimited: true,
        retryAfterSeconds: secs,
      };
    }

    if (!this.deps.providerRouter) {
      return {
        replyText:
          '⚠️ Maaf, aku lagi nggak bisa nyambung ke AI provider-ku. Coba sebentar lagi, atau tanya Panitia Arya langsung soal hal yang urgent.',
        rateLimited: false,
      };
    }

    // Snapshot recent !ai turns in THIS group chat so the model gets continuity.
    // Captured BEFORE building DB context so memory survives even if DB build
    // throws (we still want follow-ups to work when the DB hiccups).
    const recentTurns = this.memory.recent(chatId);

    let context: OmakPeakContext;
    try {
      context = await buildOmakPeakContext(this.deps.db);
    } catch {
      // Context build failure is non-fatal: proceed with an empty context so the
      // user still gets a response (the AI will hedge about tournament specifics).
      context = {
        today_fixtures: [],
        standings_by_group: [],
        teams_and_delegates: [],
        team_rosters: [],
        quiz_leaderboard: [],
        qna_entries: [],
        rules_summary: '(konteks turnamen gagal dimuat — jawaban turnamen mungkin terbatas)',
        game_knowledge: FLASH_PEAK_GAME_KNOWLEDGE,
      };
    }
    if (recentTurns.length > 0) {
      context.recent_ai_turns = recentTurns.map((t) => ({
        sender_label: t.senderLabel,
        question: t.question,
        answer: t.answer,
        ts: new Date(t.ts).toISOString(),
      }));
    }

    const { system_prompt, prompt } = buildOmakPeakPrompt(context, trimmed);

    try {
      const response = await this.deps.providerRouter.execute<string>({
        task: 'CHAT_OMAK_PEAK',
        system_prompt,
        prompt,
        temperature: 0.7,
        timeout_ms: 30_000,
        correlation_id: `omak-peak-${randomUUID().slice(0, 8)}`,
      });
      const text = extractSpeakText(response.raw_text || '');
      if (!text) {
        return {
          replyText:
            '🤔 Aku bingung jawabnya — coba pertanyaan yang lebih spesifik, atau tanya Panitia Arya soal hal yang urgent.',
          rateLimited: false,
        };
      }
      // Gunakan smartTruncate dengan batas pengaman 5.000 karakter (setara ~1.500-1.800 token)
      // agar analisa panjang tetap tuntas dan utuh, namun mencegah runaway loop/spam.
      const finalText = smartTruncate(text, 5000);
      // Record into rolling memory AFTER a successful response. The current
      // turn is not in the snapshot above, so the model never sees its own
      // in-progress answer (avoids self-referential noise).
      const label = (senderLabel && senderLabel.trim()) || senderRawAddress;
      this.memory.record(chatId, label, trimmed, finalText);
      return { replyText: finalText, rateLimited: false };
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return {
          replyText:
            '⚠️ Aku lagi nggak bisa nyambung ke AI provider-ku (semuanya lagi bermasalah). Coba sebentar lagi — kalau urgent, tanya Panitia Arya langsung.',
          rateLimited: false,
        };
      }
      const msg = err instanceof AIError ? err.message : String(err);
      return {
        replyText:
          `⚠️ Aku sempat mau jawab tapi ada gangguan teknis (${msg.slice(0, 80)}). Coba ulang ya, atau tanya Panitia Arya.`,
        rateLimited: false,
      };
    }
  }
}

// =============================================================================
// Context builder — read-only DB queries. All surfaced data is safe for any
// group participant (D-037: delegate contacts are shareable).
// =============================================================================

const RULES_SUMMARY = `Aturan inti Gojiha Tournament (Flash Peak):
- Game: Flash Peak (4v4 arcade, ~5 menit per match, third-person single-character control, no offside/fouls).
- Roster: 5 starters (1 GK + 4 outfield), maks 5 subs (total maks 10). Karakter in-game harus unik per tim (no duplicate character).
- Group Stage: round-robin 1 game per fixture. Win=3pts, Draw=1pt, Loss=0pts. Top 2 per group lolos KO.
- Knockout: BO3 (first to 2 wins) sampai final; Grand Final BO5 (first to 3 wins). Tied KO game di-replay, skor replay masuk ke series score.
- Pelaporan Skor: Tim pemenang cukup kirim 1 screenshot skor akhir (scoreboard utama). Kewajiban kartu statistik kiper DITANGGUHKAN sementara demi kemudahan pelaporan.
- Room host: tim sisi kiri default (rekomendasi / host_team_name); kalau nggak bisa host dan lawan mau, match jalan; kalau lawan nolak, lawan kena forfeit.
- Double room-card unavailable: Group Stage = double walkover (0 pts each, no stats); Knockout = double loss (kedua tim kalah, pasangan ronde berikutnya bye).
- Sistem Matchday & Waktu Tanding:
  • Seluruh pertandingan grup telah dijadwalkan per ronde (Ronde 1, Ronde 2, Ronde 3) sejak fase undian (!draw / !schedule).
  • Tiap ronde/matchday berdurasi 24 jam dengan batas cutoff pukul 19:59 WIB.
  • Jam kickoff spesifik TIDAK ditentukan kaku oleh panitia, melainkan bebas disepakati bersama oleh delegasi kedua tim (fleksibel) selama diselesaikan sebelum batas cutoff 19:59 WIB.
- Cutoff harian: 19:59 WIB — fixture yang belum selesai pas cutoff otomatis dinyatakan Double Walkover (D-031 babak grup, 0 poin untuk kedua tim) atau Kalah Ganda (D-032 babak KO).
- Best Goalkeeper Award: DITANGGUHKAN sementara untuk season ini atas keputusan panitia. Penghargaan aktif: Golden Boot, Top Assist, Best Defender.`;

function formatRoundLabel(roundCode: string | null | undefined): string {
  if (!roundCode) return '-';
  if (/^ROUND_(\d+)$/i.test(roundCode)) {
    return roundCode.replace(/^ROUND_(\d+)$/i, 'Ronde $1');
  }
  return roundCode.replace(/_/g, ' ');
}

function getWibInfo(): { wibNow: string; cutoffTime: string; timeRemaining: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const hours = parseInt(p.hour, 10);
  const minutes = parseInt(p.minute, 10);
  const currentTotal = hours * 60 + minutes;
  const cutoffTotal = 19 * 60 + 59;
  let diff = cutoffTotal - currentTotal;
  if (diff < 0) diff += 24 * 60;
  const hoursLeft = Math.floor(diff / 60);
  const minsLeft = diff % 60;
  return {
    wibNow: `${p.hour}:${p.minute} WIB (${p.year}-${p.month}-${p.day})`,
    cutoffTime: '19:59 WIB',
    timeRemaining: `${hoursLeft} jam ${minsLeft} menit`,
  };
}

async function fetchQuizLeaderboard(db: Client): Promise<OmakPeakContext['quiz_leaderboard']> {
  try {
    const qzRes = await db.execute({
      sql: `SELECT participant_name, score FROM quiz_scores ORDER BY score DESC, updated_at ASC LIMIT 5`,
    });
    return qzRes.rows.map((r, i) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        rank: i + 1,
        participant_name: String(row.participant_name),
        score: Number(row.score),
      };
    });
  } catch {
    return [];
  }
}

export async function buildOmakPeakContext(db: Client): Promise<OmakPeakContext> {
  // Active tournament (any non-terminal status).
  const tRes = await db.execute({
    sql: "SELECT id, name, status, config_json FROM tournaments WHERE status NOT IN ('COMPLETED','ARCHIVED') ORDER BY created_at DESC LIMIT 1",
  });
  if (tRes.rows.length === 0) {
    const quiz_leaderboard = await fetchQuizLeaderboard(db);
    return {
      today_fixtures: [],
      standings_by_group: [],
      teams_and_delegates: [],
      team_rosters: [],
      quiz_leaderboard,
      qna_entries: [],
      rules_summary: RULES_SUMMARY,
      game_knowledge: FLASH_PEAK_GAME_KNOWLEDGE,
    };
  }
  const tRow = tRes.rows[0] as unknown as Record<string, unknown>;
  const tournamentId = String(tRow.id);
  const tournamentName = String(tRow.name);
  const tournamentStatus = String(tRow.status);

  let config: Partial<{
    kickoff_time: string;
    confirmation_deadline: string;
    grace_period_minutes: number;
    report_window_minutes: number;
    points_win: number;
    points_draw: number;
    points_loss: number;
  }> = {};
  try {
    if (tRow.config_json) config = JSON.parse(String(tRow.config_json));
  } catch {
    config = {};
  }

  // Active round detection (earliest unfinished round, same progression as MatchdayService)
  let currentRoundCode: string | null = null;
  try {
    const unfinRes = await db.execute({
      sql: `SELECT round_code
            FROM fixtures
            WHERE tournament_id = ? AND round_code IS NOT NULL
              AND stage IN ('GROUP', 'KNOCKOUT')
              AND status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')
            GROUP BY round_code
            ORDER BY CASE WHEN stage = 'GROUP' THEN 0 ELSE 1 END,
              CASE round_code
                WHEN 'ROUND_OF_32' THEN 0
                WHEN 'ROUND_OF_16' THEN 1
                WHEN 'QUARTER_FINAL' THEN 2
                WHEN 'SEMI_FINAL' THEN 3
                WHEN 'FINAL' THEN 4
                ELSE 5
              END ASC,
              MIN(created_at) ASC
            LIMIT 1`,
      args: [tournamentId],
    });
    if (unfinRes.rows.length > 0) {
      currentRoundCode = String(unfinRes.rows[0].round_code ?? unfinRes.rows[0][0]);
    }
  } catch {
    currentRoundCode = null;
  }

  const { wibNow, cutoffTime, timeRemaining } = getWibInfo();

  // Fixtures: all fixtures with scores if completed/locked
  const fxRes = await db.execute({
    sql: `SELECT f.id, f.stage, f.round_code, f.scheduled_at, f.status,
                 ta.team_name AS team_a_name, tb.team_name AS team_b_name,
                 tl.team_name AS host_name,
                 g.group_code, gm.team_a_score, gm.team_b_score, gm.is_walkover
          FROM fixtures f
          LEFT JOIN teams ta ON ta.id = f.team_a_id
          LEFT JOIN teams tb ON tb.id = f.team_b_id
          LEFT JOIN teams tl ON tl.id = f.left_side_team_id
          LEFT JOIN groups g ON g.id = f.group_id
          LEFT JOIN games gm ON gm.fixture_id = f.id
          WHERE f.tournament_id = ?
          ORDER BY f.round_code ASC, g.group_code ASC, (f.scheduled_at IS NULL), f.scheduled_at ASC`,
    args: [tournamentId],
  });
  const today_fixtures = fxRes.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    const status = String(row.status);
    const roundCode = row.round_code ? String(row.round_code) : null;
    let score: string | null = null;
    if (status !== 'SCHEDULED' && row.team_a_score !== null && row.team_b_score !== null) {
      score = `${row.team_a_score} - ${row.team_b_score}${row.is_walkover ? ' (WO)' : ''}`;
    }
    return {
      fixture_id: String(row.id),
      stage: String(row.stage),
      group_code: row.group_code ? String(row.group_code) : null,
      round_code: roundCode,
      round_label: formatRoundLabel(roundCode),
      team_a_name: String(row.team_a_name),
      team_b_name: String(row.team_b_name),
      host_team_name: String(row.host_name || row.team_a_name),
      is_current_round: Boolean(currentRoundCode && roundCode === currentRoundCode),
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      status,
      score,
      is_walkover: Boolean(row.is_walkover),
    };
  });

  // Top Scorers across tournament
  let top_scorers: OmakPeakContext['top_scorers'] = [];
  try {
    const tsRes = await db.execute({
      sql: `SELECT p.nickname_raw, t.team_name, SUM(pgs.goals) AS total_goals, COUNT(pgs.id) AS matches
            FROM player_game_stats pgs
            JOIN players p ON pgs.player_id = p.id
            JOIN teams t ON pgs.team_id = t.id
            WHERE p.tournament_id = ?
            GROUP BY p.id
            HAVING total_goals > 0
            ORDER BY total_goals DESC
            LIMIT 10`,
      args: [tournamentId],
    });
    top_scorers = tsRes.rows.map((r, i) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        rank: i + 1,
        nickname: String(row.nickname_raw),
        team_name: String(row.team_name),
        goals: Number(row.total_goals),
        matches: Number(row.matches),
      };
    });
  } catch {
    top_scorers = [];
  }

  // Top Assists across tournament
  let top_assists: OmakPeakContext['top_assists'] = [];
  try {
    const taRes = await db.execute({
      sql: `SELECT p.nickname_raw, t.team_name, SUM(pgs.assists) AS total_assists, COUNT(pgs.id) AS matches
            FROM player_game_stats pgs
            JOIN players p ON pgs.player_id = p.id
            JOIN teams t ON pgs.team_id = t.id
            WHERE p.tournament_id = ?
            GROUP BY p.id
            HAVING total_assists > 0
            ORDER BY total_assists DESC
            LIMIT 10`,
      args: [tournamentId],
    });
    top_assists = taRes.rows.map((r, i) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        rank: i + 1,
        nickname: String(row.nickname_raw),
        team_name: String(row.team_name),
        assists: Number(row.total_assists),
        matches: Number(row.matches),
      };
    });
  } catch {
    top_assists = [];
  }

  // Top Defenders across tournament
  let top_defenders: OmakPeakContext['top_defenders'] = [];
  try {
    const tdRes = await db.execute({
      sql: `SELECT p.nickname_raw, t.team_name, SUM(pgs.defense_raw) AS total_def, COUNT(pgs.id) AS matches
            FROM player_game_stats pgs
            JOIN players p ON pgs.player_id = p.id
            JOIN teams t ON pgs.team_id = t.id
            WHERE p.tournament_id = ? AND p.position = 'OUTFIELD'
            GROUP BY p.id
            HAVING total_def > 0
            ORDER BY total_def DESC
            LIMIT 10`,
      args: [tournamentId],
    });
    top_defenders = tdRes.rows.map((r, i) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        rank: i + 1,
        nickname: String(row.nickname_raw),
        team_name: String(row.team_name),
        defense: Number(row.total_def),
        matches: Number(row.matches),
      };
    });
  } catch {
    top_defenders = [];
  }

  // Standings per group (bounded rows per group).
  const stRes = await db.execute({
    sql: `SELECT s.group_id, g.group_code, s.team_id, t.team_name,
                 s.played, s.wins, s.draws, s.losses,
                 s.goals_for, s.goals_against, s.points
          FROM standings s
          JOIN groups g ON g.id = s.group_id
          JOIN teams t ON t.id = s.team_id
          WHERE s.tournament_id = ?
          ORDER BY s.group_id, s.points DESC, s.goal_difference DESC, s.goals_for DESC`,
    args: [tournamentId],
  });
  const groupMap = new Map<string, { group_code: string; rows: any[] }>();
  for (const r of stRes.rows) {
    const row = r as unknown as Record<string, unknown>;
    const gid = String(row.group_id);
    const gcode = String(row.group_code);
    if (!groupMap.has(gid)) groupMap.set(gid, { group_code: gcode, rows: [] });
    const grp = groupMap.get(gid)!;
    if (grp.rows.length < 5) {
      grp.rows.push({
        team_name: String(row.team_name),
        played: Number(row.played),
        wins: Number(row.wins),
        draws: Number(row.draws),
        losses: Number(row.losses),
        goals_for: Number(row.goals_for),
        goals_against: Number(row.goals_against),
        points: Number(row.points),
      });
    }
  }
  const standings_by_group = Array.from(groupMap.values());

  // Teams + delegates + primary WA identity (delegate contacts shareable per D-037).
  // NOTE on LIDs: when the primary identity is a WhatsApp internal LID
  // (raw_address ending '@lid'), it is flagged (delegate_whatsapp_is_lid)
  // instead of being treated as an actionable contact — see the prompt rule
  // in src/ai/prompts/omak-peak.ts.
  const tdRes = await db.execute({
    sql: `SELECT t.team_name, t.team_code, d.display_name AS delegate_display_name,
                 wi.raw_address AS delegate_whatsapp, g.group_code
          FROM teams t
          LEFT JOIN delegates d ON d.id = t.delegate_id
          LEFT JOIN whatsapp_identities wi ON wi.delegate_id = d.id AND wi.is_primary = 1
          LEFT JOIN group_members gm ON gm.team_id = t.id
          LEFT JOIN groups g ON g.id = gm.group_id
          WHERE t.tournament_id = ? AND t.registration_status IN ('VERIFIED','PENDING')
          ORDER BY t.team_name ASC
          LIMIT 30`,
    args: [tournamentId],
  });
  const teams_and_delegates = tdRes.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    const delegateWhatsapp = row.delegate_whatsapp ? String(row.delegate_whatsapp) : null;
    return {
      team_name: String(row.team_name),
      team_code: row.team_code ? String(row.team_code) : null,
      delegate_display_name: row.delegate_display_name ? String(row.delegate_display_name) : null,
      delegate_whatsapp: delegateWhatsapp,
      // Flag internal WhatsApp LIDs: a raw @lid address is NOT a dialable
      // phone contact, so the prompt must not offer it as one (D-037
      // contact-sharing stays honest — see omak-peak.ts prompt guidance).
      delegate_whatsapp_is_lid: delegateWhatsapp !== null && delegateWhatsapp.endsWith('@lid'),
      group_code: row.group_code ? String(row.group_code) : null,
    };
  });

  // QnA entries (living FAQ).
  let qna_entries: Array<{ question: string; answer: string; category: string | null }> = [];
  try {
    const qRes = await db.execute({
      sql: `SELECT question, answer, category FROM qna_entries WHERE is_active = 1 ORDER BY created_at DESC LIMIT 30`,
    });
    qna_entries = qRes.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        question: String(row.question),
        answer: String(row.answer),
        category: row.category ? String(row.category) : null,
      };
    });
  } catch {
    // qna_entries table may not exist yet on legacy DBs without migration 004.
    qna_entries = [];
  }

  // Official registered team rosters (all active players per team)
  let team_rosters: OmakPeakContext['team_rosters'] = [];
  try {
    const plRes = await db.execute({
      sql: `SELECT t.team_name, g.group_code, p.nickname_raw, p.position, p.roster_type
            FROM players p
            JOIN teams t ON t.id = p.team_id
            LEFT JOIN group_members gm ON gm.team_id = t.id
            LEFT JOIN groups g ON g.id = gm.group_id
            WHERE p.tournament_id = ? AND p.status = 'ACTIVE'
            ORDER BY g.group_code ASC, t.team_name ASC, p.roster_slot ASC`,
      args: [tournamentId],
    });
    const rosterMap = new Map<string, {
      team_name: string;
      group_code: string | null;
      players: Array<{
        nickname: string;
        position: 'GOALKEEPER' | 'OUTFIELD';
        roster_type: 'STARTER' | 'SUBSTITUTE';
      }>;
    }>();
    for (const r of plRes.rows) {
      const row = r as unknown as Record<string, unknown>;
      const teamName = String(row.team_name);
      if (!rosterMap.has(teamName)) {
        rosterMap.set(teamName, {
          team_name: teamName,
          group_code: row.group_code ? String(row.group_code) : null,
          players: [],
        });
      }
      rosterMap.get(teamName)!.players.push({
        nickname: String(row.nickname_raw),
        position: String(row.position) as 'GOALKEEPER' | 'OUTFIELD',
        roster_type: String(row.roster_type) as 'STARTER' | 'SUBSTITUTE',
      });
    }
    team_rosters = Array.from(rosterMap.values());
  } catch {
    team_rosters = [];
  }

  // Quiz Leaderboard (community trivia mini-game, separate from tournament)
  const quiz_leaderboard = await fetchQuizLeaderboard(db);

  return {
    tournament: {
      name: tournamentName,
      status: tournamentStatus,
      current_round_code: currentRoundCode,
      current_round_label: formatRoundLabel(currentRoundCode),
      wib_now: wibNow,
      cutoff_time: cutoffTime,
      time_remaining_to_cutoff: timeRemaining,
      matchday_policy: 'Sistem matchday harian 24 jam dengan batas cutoff pukul 19:59 WIB. Setiap ronde berlangsung hingga cutoff 19:59 WIB. Waktu tanding ditentukan atas kesepakatan delegasi kedua tim sebelum batas cutoff 19:59 WIB.',
      kickoff_time: config.kickoff_time,
      confirmation_deadline: config.confirmation_deadline,
      grace_period_minutes: config.grace_period_minutes,
      report_window_minutes: config.report_window_minutes,
      points_win: config.points_win,
      points_draw: config.points_draw,
      points_loss: config.points_loss,
    },
    today_fixtures,
    standings_by_group,
    top_scorers,
    top_assists,
    top_defenders,
    awards_status: {
      goalkeeper_award_suspended: true,
      active_awards: ['GOLDEN_BOOT (Top Scorer)', 'TOP_ASSIST', 'BEST_DEFENDER'],
      notes: 'Penghargaan kiper (Best Goalkeeper) ditangguhkan sementara selama season ini. Penghargaan individu aktif: Golden Boot, Top Assist, Best Defender.',
    },
    teams_and_delegates,
    team_rosters,
    quiz_leaderboard,
    qna_entries,
    rules_summary: RULES_SUMMARY,
    game_knowledge: FLASH_PEAK_GAME_KNOWLEDGE,
  };
}
