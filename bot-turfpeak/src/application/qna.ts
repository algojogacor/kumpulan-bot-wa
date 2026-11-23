/**
 * Flash Peak TMS - QnA Service (AI-native expansion, D-039)
 *
 * !qna  — list the living FAQ (any role).
 * !saveqna [n] — organizer: AI-extracts Q&A pairs from the last n (default 10)
 *                group messages and adds them to the FAQ.
 *
 * Design:
 * - Relies on the broad text capture (AI-NATIVE-001 in src/index.ts) which
 *   persists all central-group TEXT messages to inbound_messages. Without that
 *   capture, !saveqna would have nothing to read.
 * - Traceability: every inserted pair stores the source message IDs (AI returns
 *   them from the chat history; the backend validates each ID actually exists
 *   in the extraction window before insert, so hallucinated IDs are dropped).
 * - The AI decides which message pairs are genuine Q&A (participant question +
 *   organizer answer) vs unrelated chat. No rigid heuristic — per the brief,
 *   "serahkan penilaian itu ke AI".
 * - Dedup: the AI is passed the existing Q list and asked to mark each new
 *   candidate as new vs duplicate-of-existing. Exact (question, answer) pairs
 *   are also rejected by the UNIQUE constraint on qna_entries.
 * - Honest counting: "Ditambahkan: N" counts only rows actually inserted
 *   (rowsAffected of each INSERT OR IGNORE), so silently-ignored exact
 *   duplicates never inflate the reported number.
 * - Rate guard: !saveqna is organizer-only and bounded to one invocation per
 *   30 seconds (in-memory) so a misclick doesn't burn quota.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';

const SAVEQNA_COOLDOWN_MS = 30_000;

interface ExtractedQnaPair {
  question: string;
  answer: string;
  category: string | null;
  source_message_ids: string[];
  duplicate_of_existing: boolean;
}

const QNA_EXTRACTOR_SYSTEM_PROMPT = `Kamu mengekstrak pasangan Q&A dari histori chat grup turnamen Flash Peak.

Tugasmu:
1. Baca <chat_history> (pesan terakhir grup, urut waktu lama→baru).
2. Identifikasi pasangan pertanyaan-jawaban yang RELEVAN untuk FAQ turnamen:
   - Pertanyaan dari peserta (delegate/non-organizer) soal turnamen (jadwal, aturan, hasil, WO, roster, dll).
   - Jawaban dari organizer (panitia, biasanya Arya) yang menjawab pertanyaan itu.
3. Abaikan obrolan santai/spam yang BUKAN Q&A turnamen. Hanya ambil pasangan yang genuine informatif.
4. Cek <existing_qna> — kalau pasangan yang sama sudah ada (atau sangat mirip), tandai duplicate_of_existing=true.
5. Rapihkan: question ringkas (kalimat pertanyaan inti), answer jelas (jawaban organizer yang inti).
6. Untuk tiap pasangan, isi source_message_ids dengan ID pesan ASAL pasangan itu: id pesan pertanyaan dan id pesan jawaban, diambil dari field "id" entri yang sesuai di <chat_history>.

OUTPUT (JSON saja):
{
  "pairs": [
    {
      "question": "...",
      "answer": "...",
      "category": "jadwal|aturan|teknis|wo|roster|hasil|umum",
      "source_message_ids": ["id-pesan-pertanyaan", "id-pesan-jawaban"],
      "duplicate_of_existing": false
    }
  ]
}

Aturan:
- Maksimum 10 pasangan per run.
- Jangan invent pertanyaan/jawaban yang tidak ada di chat.
- Kalau tidak ada pasangan Q&A yang valid, return { "pairs": [] }.
- category harus salah satu dari enum di atas (atau null kalau tidak yakin).
- source_message_ids HANYA boleh berisi id yang benar-benar muncul di <chat_history> — jangan mengarang id. Kalau tidak yakin id-nya, kirim array kosong [].`;

export interface QnaDeps {
  db: Client;
  providerRouter?: ProviderRouter;
}

export class QnaService {
  private lastSaveqnaAt = 0;

  constructor(private readonly deps: QnaDeps) {}

  /** !qna — list the living FAQ. */
  async listEntries(): Promise<string> {
    let rows: Array<{ question: string; answer: string; category: string | null }> = [];
    try {
      const res = await this.deps.db.execute({
        sql: `SELECT question, answer, category FROM qna_entries WHERE is_active = 1 ORDER BY created_at DESC LIMIT 50`,
      });
      rows = res.rows.map((r) => {
        const row = r as unknown as Record<string, unknown>;
        return {
          question: String(row.question),
          answer: String(row.answer),
          category: row.category ? String(row.category) : null,
        };
      });
    } catch {
      // qna_entries table may not exist yet (migration 004 not applied).
      return 'ℹ️ Fitur Q&A belum tersedia (tabel qna_entries belum ada). Jalankan migrasi 004.';
    }

    if (rows.length === 0) {
      return [
        '📋 *FAQ Turnamen (QnA)*',
        '',
        'Belum ada Q&A yang terkumpul.',
        '',
        'Panitia bisa menambahkan dengan *!saveqna* — AI akan mengekstrak pasangan Q&A dari pesan-pesan terakhir grup.',
        '',
        'Atau tanya langsung ke *!ai* (Omak Peak) kalau mau jawaban cepat.',
      ].join('\n');
    }

    const lines: string[] = [];
    lines.push('📋 *FAQ Turnamen (QnA)*');
    lines.push(`_${rows.length} entri terkumpul_`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      lines.push(`${i + 1}. *Q: ${r.question}*`);
      lines.push(`   A: ${r.answer}`);
      if (r.category) lines.push(`   _kategori: ${r.category}_`);
      lines.push('');
    }
    lines.push('💡 Mau tanya langsung? Pakai *!ai <pertanyaan>*.');
    return lines.join('\n');
  }

  /** !saveqna [n] — AI-extract Q&A from last n group messages. */
  async extractAndSave(input: {
    chatId: string;
    count: number;
    organizerAddress: string;
    organizerDelegateId: string | null;
  }): Promise<{ success: boolean; responseText: string }> {
    // Rate guard (organizer-only, but prevent quota burn from misclicks).
    const nowMs = Date.now();
    if (nowMs - this.lastSaveqnaAt < SAVEQNA_COOLDOWN_MS) {
      const wait = Math.ceil((SAVEQNA_COOLDOWN_MS - (nowMs - this.lastSaveqnaAt)) / 1000);
      return {
        success: false,
        responseText: `⏳ Baru saja jalankan !saveqna. Tunggu *${wait} detik* sebelum run lagi (anti misclick).`,
      };
    }
    this.lastSaveqnaAt = nowMs;

    if (!this.deps.providerRouter) {
      return {
        success: false,
        responseText: '⚠️ AI provider belum dikonfigurasi — !saveqna butuh AI untuk ekstraksi Q&A.',
      };
    }

    // Fetch last N text messages from the central group, oldest-first.
    const msgsRes = await this.deps.db.execute({
      sql: `SELECT id, sender_raw_address, message_timestamp, text_body, caption
            FROM inbound_messages
            WHERE chat_id = ? AND message_type = 'TEXT'
              AND (text_body IS NOT NULL OR caption IS NOT NULL)
            ORDER BY message_timestamp DESC
            LIMIT ?`,
      args: [input.chatId, input.count],
    });
    if (msgsRes.rows.length === 0) {
      return {
        success: false,
        responseText:
          'ℹ️ Belum ada pesan terkumpul di grup untuk diekstrak. ' +
          '(Catatan: sistem mulai mencatat semua pesan teks grup sejak update AI-native — pesan lama sebelum itu tidak tersimpan.)',
      };
    }

    const msgs = msgsRes.rows.reverse().map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        id: String(row.id),
        sender: String(row.sender_raw_address),
        time: String(row.message_timestamp),
        text: String(row.text_body || row.caption || ''),
      };
    });

    // Fetch existing Q&A for dedup.
    let existingQna: Array<{ question: string; answer: string }> = [];
    try {
      const exRes = await this.deps.db.execute({
        sql: 'SELECT question, answer FROM qna_entries WHERE is_active = 1',
      });
      existingQna = exRes.rows.map((r) => {
        const row = r as unknown as Record<string, unknown>;
        return { question: String(row.question), answer: String(row.answer) };
      });
    } catch {
      // qna_entries not yet created
    }

    // Call AI.
    const userPrompt =
      `<chat_history>\n${JSON.stringify(msgs, null, 2)}\n</chat_history>\n\n` +
      `<existing_qna>\n${JSON.stringify(existingQna.slice(0, 50), null, 2)}\n</existing_qna>\n\n` +
      `Return JSON only.`;

    let pairs: ExtractedQnaPair[];
    try {
      const response = await this.deps.providerRouter.execute({
        task: 'EXTRACT_QNA',
        structured_output: true,
        system_prompt: QNA_EXTRACTOR_SYSTEM_PROMPT,
        prompt: userPrompt,
        temperature: 0.1,
        timeout_ms: 45_000,
        correlation_id: `qna-${randomUUID().slice(0, 8)}`,
      });
      // Validate returned source_message_ids against the ids actually present
      // in the extraction window — hallucinated ids are dropped here.
      const validIds = new Set(msgs.map((m) => m.id));
      pairs = parseQnaResponse(response.raw_text || '', validIds);
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return {
          success: false,
          responseText: '⚠️ Semua AI provider gagal — !saveqna tidak bisa ekstrak sekarang. Coba sebentar lagi.',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, responseText: `⚠️ Gagal ekstrak Q&A: ${msg.slice(0, 150)}` };
    }

    if (pairs.length === 0) {
      return {
        success: true,
        responseText:
          `ℹ️ Aku baca ${msgs.length} pesan terakhir grup — nggak ada pasangan Q&A turnamen yang valid untuk dimasukkan ke FAQ. ` +
          `(Obrolan biasa/spam tidak diambil.) Coba lagi nanti setelah ada tanya-jawab soal turnamen.`,
      };
    }

    // Persist new (non-duplicate) pairs. Counting is honest: each INSERT OR
    // IGNORE's rowsAffected is checked, so exact (question, answer) duplicates
    // silently skipped by the UNIQUE constraint are reported as skipped, not
    // as inserted.
    const now = new Date().toISOString();
    let inserted = 0;
    let skippedDup = 0;
    let skippedUnique = 0;
    let skippedError = 0;
    let firstError: string | null = null;
    const insertedPairs: Array<{ question: string; answer: string; category: string | null }> = [];
    for (const p of pairs) {
      if (p.duplicate_of_existing) {
        skippedDup++;
        continue;
      }
      try {
        const insRes = await this.deps.db.execute({
          sql: `INSERT OR IGNORE INTO qna_entries
                  (id, question, answer, category, source_message_ids_json,
                   created_by_delegate_id, created_by_organizer, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          args: [
            randomUUID(),
            p.question.slice(0, 500),
            p.answer.slice(0, 2000),
            p.category,
            JSON.stringify(p.source_message_ids),
            input.organizerDelegateId,
            now,
            now,
          ],
        });
        const insertedRows = (insRes as any).rowsAffected ?? (insRes as any).changes ?? 0;
        if (insertedRows > 0) {
          insertedPairs.push({ question: p.question, answer: p.answer, category: p.category });
          inserted++;
        } else {
          // OR IGNORE silently skipped an exact (question, answer) duplicate
          // the AI did not flag — count it so the summary stays honest.
          skippedUnique++;
        }
      } catch (e) {
        // Surface non-UNIQUE errors (e.g. missing table) instead of swallowing —
        // a silent zero-insert success is misleading to the organizer.
        skippedError++;
        if (firstError === null) firstError = e instanceof Error ? e.message : String(e);
      }
    }

    const lines: string[] = [];
    lines.push('📝 *EKSTRAK Q&A* — selesai');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`📊 Dibaca: ${msgs.length} pesan terakhir grup`);
    lines.push(`✅ Ditambahkan ke FAQ: ${inserted} pasangan baru`);
    if (skippedDup > 0) lines.push(`♻️ Duplikat existing (ditandai AI, di-skip): ${skippedDup}`);
    if (skippedUnique > 0) lines.push(`♻️ Duplikat persis (UNIQUE, otomatis di-skip): ${skippedUnique}`);
    if (skippedError > 0) lines.push(`⚠️ Gagal insert: ${skippedError} pasangan (error: ${firstError?.slice(0, 100)})`);
    if (insertedPairs.length > 0) {
      lines.push('');
      lines.push('*Pasangan baru:*');
      for (const p of insertedPairs.slice(0, 5)) {
        lines.push(`• Q: ${p.question}`);
        lines.push(`  A: ${p.answer.slice(0, 120)}${p.answer.length > 120 ? '…' : ''}`);
      }
      if (insertedPairs.length > 5) lines.push(`_...dan ${insertedPairs.length - 5} lainnya._`);
    }
    lines.push('');
    lines.push('Lihat daftar lengkap via *!qna*.');
    return { success: true, responseText: lines.join('\n') };
  }
}

function parseQnaResponse(raw: string, validMessageIds: Set<string>): ExtractedQnaPair[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.pairs)) return [];
  const out: ExtractedQnaPair[] = [];
  for (const p of parsed.pairs) {
    if (!p || typeof p.question !== 'string' || typeof p.answer !== 'string') continue;
    if (!p.question.trim() || !p.answer.trim()) continue;
    out.push({
      question: String(p.question).slice(0, 500),
      answer: String(p.answer).slice(0, 2000),
      category:
        typeof p.category === 'string' &&
        ['jadwal', 'aturan', 'teknis', 'wo', 'roster', 'hasil', 'umum'].includes(p.category)
          ? String(p.category)
          : null,
      // Keep only source ids that actually exist in the extraction window;
      // drop anything else (guards against hallucinated ids).
      source_message_ids: Array.isArray(p.source_message_ids)
        ? p.source_message_ids
            .filter((mid: unknown) => typeof mid === 'string' && validMessageIds.has(mid))
            .slice(0, 10)
        : [],
      duplicate_of_existing: Boolean(p.duplicate_of_existing),
    });
  }
  return out.slice(0, 10);
}
