/**
 * Flash Peak TMS - Agent Action Catalog (AI-native expansion, D-038)
 *
 * Defines the CLOSED set of typed actions the organizer AI agent can plan and
 * execute. The AI never produces free-form SQL or code — it picks action_id(s)
 * from this catalog and fills typed parameters. Every action has:
 *   - description (for the AI planner prompt)
 *   - parameter schema (Zod) — strict validation
 *   - preview(db, params): builds a human-readable "old → new" summary WITHOUT
 *     mutating state; also surfaces validation errors (e.g. fixture not found,
 *     wrong status) so the plan can be rejected BEFORE staging.
 *   - execute(txClient, params): runs inside a transaction; returns before/after
 *     state for the audit trail, or an error if execution fails.
 *
 * Why a closed catalog (not free-form): the user's brief is explicit — "ruang
 * kesalahannya terbatas", "tidak boleh ada jalur eksekusi tanpa konfirmasi",
 * "tidak boleh ada kegagalan yang meninggalkan data setengah berubah". A closed
 * catalog + transactional execution + plan-id idempotency satisfies all three.
 *
 * Each action delegates to the SAME authoritative functions used by the manual
 * organizer commands (!kores, !override, !reopen, !claimwo, etc.) — no parallel
 * write path. This guarantees behavior parity with existing audit-trailed flows.
 */

import type { Client } from '@libsql/client';
import { z } from 'zod';
import { organizerOverrideLock, organizerReopenReport } from '../reports/approval.js';
import { handleSingleForfeit } from '../competition/walkover.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';
import { getSeriesByFixture, recordSeriesGameResult } from '../competition/series.js';
import { getKoSeriesContext, deriveOpenGameSlot } from './ko-evidence-pipeline.js';

// =============================================================================
// Minimal client interface accepted by action execute() — the Transaction object
// returned by client.transaction() satisfies this. Existing domain functions take
// the full Client; we cast at the call site (runtime-safe because they only use
// .execute(), which Transaction implements).
// =============================================================================

export type TxClient = Pick<Client, 'execute' | 'batch'>;

// =============================================================================
// Action parameter schemas (Zod) — strict, typed, documented for the AI prompt.
// =============================================================================

export const reopenReportParams = z.object({
  fixture_id: z.string().describe('ID fixture yang laporannya akan di-reopen'),
  reason: z.string().min(1).max(300).describe('Alasan organizer reopen (akan dicatat di audit)'),
});
export type ReopenReportParams = z.infer<typeof reopenReportParams>;

export const overrideLockParams = z.object({
  fixture_id: z.string().describe('ID fixture yang laporannya akan di-override-lock (force LOCK tanpa konsensus 3 pihak)'),
  reason: z.string().min(1).max(300).describe('Alasan override (mis. sengketa yang tidak bisa ditunggu konsensus)'),
});
export type OverrideLockParams = z.infer<typeof overrideLockParams>;

export const forfeitWinnerParams = z.object({
  fixture_id: z.string().describe('ID fixture'),
  winning_team_id: z.string().describe('ID tim pemenang (tim lawan dianggap forfeit/WO)'),
  reason: z.string().min(1).max(300).describe('Alasan WO (mis. lawan tidak hadir 15 menit)'),
});
export type ForfeitWinnerParams = z.infer<typeof forfeitWinnerParams>;

export const rescheduleFixtureParams = z.object({
  fixture_id: z.string(),
  new_scheduled_at: z.string().describe('ISO-8601 datetime (UTC) untuk kickoff baru'),
  reason: z.string().min(1).max(300),
});
export type RescheduleFixtureParams = z.infer<typeof rescheduleFixtureParams>;

export const cancelFixtureParams = z.object({
  fixture_id: z.string(),
  reason: z.string().min(1).max(300),
});
export type CancelFixtureParams = z.infer<typeof cancelFixtureParams>;

export const setTournamentStatusParams = z.object({
  tournament_id: z.string(),
  new_status: z.enum(['DRAFT', 'REGISTRATION', 'ONBOARDING', 'DRAW_READY', 'ACTIVE', 'COMPLETED', 'ARCHIVED'])
    .describe('Status turnamen baru. PAUSE = DRAW_READY; RESUME = ACTIVE.'),
  reason: z.string().min(1).max(300),
});
export type SetTournamentStatusParams = z.infer<typeof setTournamentStatusParams>;

export const recordKoGameScoreParams = z.object({
  fixture_id: z.string(),
  team_a_score: z.number().int().min(0).max(99),
  team_b_score: z.number().int().min(0).max(99),
  reason: z.string().min(1).max(300).describe('Alasan organizer mencatat manual (mis. AI gagal ekstraksi)'),
});
export type RecordKoGameScoreParams = z.infer<typeof recordKoGameScoreParams>;

export const announceParams = z.object({
  message: z.string().min(1).max(1500).describe('Isi pengumuman yang akan dikirim ke grup turnamen resmi'),
});
export type AnnounceParams = z.infer<typeof announceParams>;

// =============================================================================
// Action definition interface
// =============================================================================

export interface ActionPreviewResult {
  summary: string;
  validation_errors: string[];
  before?: unknown;
}

export interface ActionExecuteResult {
  ok: boolean;
  before?: unknown;
  after?: unknown;
  error?: string;
}

export interface AgentActionDef<P = Record<string, unknown>> {
  action_id: string;
  description: string;
  parameters_schema: z.ZodType<P>;
  preview(db: Client, params: P): Promise<ActionPreviewResult>;
  execute(tx: TxClient, params: P): Promise<ActionExecuteResult>;
}

// =============================================================================
// Catalog container
// =============================================================================

export class AgentActionCatalog {
  private defs = new Map<string, AgentActionDef<any>>();

  register(def: AgentActionDef<any>): void {
    if (this.defs.has(def.action_id)) {
      throw new Error(`AgentActionCatalog duplicate action_id: ${def.action_id}`);
    }
    this.defs.set(def.action_id, def);
  }

  get(action_id: string): AgentActionDef<any> | undefined {
    return this.defs.get(action_id);
  }

  list(): Array<{ action_id: string; description: string; parameters_schema: z.ZodType<any> }> {
    return Array.from(this.defs.values()).map((d) => ({
      action_id: d.action_id,
      description: d.description,
      parameters_schema: d.parameters_schema,
    }));
  }

  /** Compact JSON description for the AI planner prompt. */
  toPromptJson(): string {
    return JSON.stringify(
      this.list().map((d) => ({
        action_id: d.action_id,
        description: d.description,
        parameters: describeZodSchema(d.parameters_schema),
      })),
      null,
      2
    );
  }
}

function describeZodSchema(schema: z.ZodType<any>): Record<string, string> {
  if (!(schema instanceof z.ZodObject)) return { _value: 'object' };
  const shape = (schema as z.ZodObject<any>).shape;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(shape)) {
    if (val instanceof z.ZodString) out[key] = 'string';
    else if (val instanceof z.ZodNumber) out[key] = 'number';
    else if (val instanceof z.ZodEnum) {
      const opts = (val as z.ZodEnum<any>).options;
      out[key] = `enum(${opts.join('|')})`;
    } else {
      out[key] = (val as z.ZodTypeAny).constructor.name.replace('Zod', '').toLowerCase();
    }
  }
  return out;
}

// =============================================================================
// Helpers
// =============================================================================

/** Find the latest LOCKED report version for a fixture. */
async function findLatestLockedVersion(
  db: Client,
  fixtureId: string
): Promise<{ id: string; version_number: number } | null> {
  const res = await db.execute({
    sql: `SELECT rv.id, rv.version_number FROM report_versions rv
          JOIN report_sessions rs ON rs.id = rv.report_session_id
          WHERE rs.fixture_id = ? AND rv.status = 'LOCKED'
          ORDER BY rv.version_number DESC LIMIT 1`,
    args: [fixtureId],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return { id: String(r.id), version_number: Number(r.version_number) };
}

/** Find the latest report version (any status) for a fixture. */
async function findLatestVersion(
  db: Client,
  fixtureId: string
): Promise<{ id: string; version_number: number; status: string } | null> {
  const res = await db.execute({
    sql: `SELECT rv.id, rv.version_number, rv.status FROM report_versions rv
          JOIN report_sessions rs ON rs.id = rv.report_session_id
          WHERE rs.fixture_id = ?
          ORDER BY rv.version_number DESC LIMIT 1`,
    args: [fixtureId],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return { id: String(r.id), version_number: Number(r.version_number), status: String(r.status) };
}

// =============================================================================
// Default catalog — wired to existing organizer capabilities.
// =============================================================================

export function buildDefaultAgentActionCatalog(_db: Client): AgentActionCatalog {
  const catalog = new AgentActionCatalog();

  // --- reopen_report -------------------------------------------------------
  catalog.register({
    action_id: 'reopen_report',
    description: 'Buka kembali laporan pertandingan yang sudah LOCKED (sama seperti !reopen). Approval direset; butuh 3 approval baru untuk LOCK ulang.',
    parameters_schema: reopenReportParams,
    async preview(d, params) {
      const r = reopenReportParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.status, ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.status) !== 'COMPLETED' && String(row.status) !== 'WALKOVER') {
        return {
          summary: '',
          validation_errors: [`fixture status "${row.status}" — reopen hanya untuk fixture COMPLETED/WALKOVER`],
        };
      }
      const locked = await findLatestLockedVersion(d, r.fixture_id);
      if (!locked) {
        return {
          summary: '',
          validation_errors: [`tidak ada report version LOCKED untuk fixture ini`],
        };
      }
      return {
        summary: `Reopen laporan *${String(row.a)} vs ${String(row.b)}* (fixture ${r.fixture_id.slice(0,8)}…): version v${locked.version_number} status LOCKED → NEEDS_CORRECTION. Alasan: "${r.reason}". Approval direset — butuh 3 approval baru.`,
        validation_errors: [],
        before: { version_id: locked.id, version_number: locked.version_number, status: 'LOCKED' },
      };
    },
    async execute(tx, params) {
      const r = reopenReportParams.parse(params);
      const locked = await findLatestLockedVersion(tx as unknown as Client, r.fixture_id);
      if (!locked) {
        return { ok: false, error: 'tidak ada report version LOCKED untuk fixture ini (race?)' };
      }
      const before = { version_id: locked.id, version_number: locked.version_number, status: 'LOCKED' };
      try {
        await organizerReopenReport(tx as unknown as Client, {
          report_version_id: locked.id,
          organizer_id: 'AI_AGENT',
          reason: r.reason,
        });
        const afterRes = await tx.execute({ sql: 'SELECT status FROM report_versions WHERE id = ?', args: [locked.id] });
        const after = afterRes.rows.length > 0 ? { status: String((afterRes.rows[0] as unknown as Record<string, unknown>).status) } : { status: 'unknown' };
        return { ok: true, before, after };
      } catch (e) {
        return { ok: false, before, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  // --- override_lock -------------------------------------------------------
  catalog.register({
    action_id: 'override_lock',
    description: 'Kunci paksa laporan (force LOCK) tanpa konsensus 3 pihak — darurat, tercatat di audit (sama seperti !override). Hanya untuk version yang belum LOCKED.',
    parameters_schema: overrideLockParams,
    async preview(d, params) {
      const r = overrideLockParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.status, ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      const latest = await findLatestVersion(d, r.fixture_id);
      if (!latest) {
        return {
          summary: '',
          validation_errors: [`tidak ada report version untuk fixture ini — tidak bisa override-lock. Gunakan !manualreport atau forfeit_winner.`],
        };
      }
      if (latest.status === 'LOCKED') {
        return {
          summary: '',
          validation_errors: [`version v${latest.version_number} sudah LOCKED — tidak perlu override. Gunakan reopen_report dulu kalau mau ubah.`],
        };
      }
      return {
        summary: `Override-lock laporan *${String(row.a)} vs ${String(row.b)}* (fixture ${r.fixture_id.slice(0,8)}…): version v${latest.version_number} status ${latest.status} → LOCKED. Alasan: "${r.reason}". Statistik difinalisasi seperti lock biasa.`,
        validation_errors: [],
        before: { version_id: latest.id, version_number: latest.version_number, status: latest.status },
      };
    },
    async execute(tx, params) {
      const r = overrideLockParams.parse(params);
      const latest = await findLatestVersion(tx as unknown as Client, r.fixture_id);
      if (!latest) {
        return { ok: false, error: 'tidak ada report version untuk fixture ini' };
      }
      if (latest.status === 'LOCKED') {
        return { ok: false, error: 'version sudah LOCKED (race?) — tidak override' };
      }
      const before = { version_id: latest.id, version_number: latest.version_number, status: latest.status };
      try {
        await organizerOverrideLock(tx as unknown as Client, {
          report_version_id: latest.id,
          organizer_id: 'AI_AGENT',
          reason: r.reason,
        });
        // Recompute standings if this is a group-stage fixture.
        const fxRes = await tx.execute({
          sql: 'SELECT stage, tournament_id, group_id FROM fixtures WHERE id = ?',
          args: [r.fixture_id],
        });
        if (fxRes.rows.length > 0) {
          const fr = fxRes.rows[0] as unknown as Record<string, unknown>;
          if (String(fr.stage) === 'GROUP' && fr.group_id) {
            await recalculateAndPersistGroupStandings(tx as unknown as Client, String(fr.tournament_id), String(fr.group_id));
          }
        }
        return { ok: true, before, after: { status: 'LOCKED' } };
      } catch (e) {
        return { ok: false, before, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  // --- forfeit_winner ------------------------------------------------------
  catalog.register({
    action_id: 'forfeit_winner',
    description: 'Tetapkan pemenang fixture via walkover/forfeit (sama seperti !ok pada WO claim). Tim lawan dari winning_team_id dianggap forfeit. Untuk fixture yang belum COMPLETED.',
    parameters_schema: forfeitWinnerParams,
    async preview(d, params) {
      const r = forfeitWinnerParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.status, f.stage, f.team_a_id, f.team_b_id,
                     ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.status) === 'COMPLETED' || String(row.status) === 'CANCELLED') {
        return { summary: '', validation_errors: [`fixture status "${row.status}" — forfeit tidak relevan`] };
      }
      if (r.winning_team_id !== String(row.team_a_id) && r.winning_team_id !== String(row.team_b_id)) {
        return {
          summary: '',
          validation_errors: [`winning_team_id "${r.winning_team_id}" bukan peserta fixture ini (tim: ${row.a} / ${row.b})`],
        };
      }
      const winnerName = r.winning_team_id === String(row.team_a_id) ? String(row.a) : String(row.b);
      const loserName = r.winning_team_id === String(row.team_a_id) ? String(row.b) : String(row.a);
      return {
        summary: `Forfeit/WO *${String(row.a)} vs ${String(row.b)}*: pemenang *${winnerName}* (lawan *${loserName}* forfeit). Stage: ${String(row.stage)}. Alasan: "${r.reason}".`,
        validation_errors: [],
        before: { status: String(row.status) },
      };
    },
    async execute(tx, params) {
      const r = forfeitWinnerParams.parse(params);
      const fxRes = await tx.execute({
        sql: 'SELECT team_a_id, team_b_id, status, stage, tournament_id, group_id FROM fixtures WHERE id = ?',
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) return { ok: false, error: 'fixture tidak ditemukan (race?)' };
      const fr = fxRes.rows[0] as unknown as Record<string, unknown>;
      const teamAId = String(fr.team_a_id);
      const teamBId = String(fr.team_b_id);
      const forfeitingTeamId = r.winning_team_id === teamAId ? teamBId : teamAId;
      const before = { status: String(fr.status) };
      try {
        await handleSingleForfeit(tx as unknown as Client, r.fixture_id, forfeitingTeamId, r.reason);
        // Recompute group standings if group-stage.
        if (String(fr.stage) === 'GROUP' && fr.group_id) {
          await recalculateAndPersistGroupStandings(tx as unknown as Client, String(fr.tournament_id), String(fr.group_id));
        }
        const afterRes = await tx.execute({ sql: 'SELECT status, winner_team_id FROM fixtures WHERE id = ?', args: [r.fixture_id] });
        const after = afterRes.rows.length > 0
          ? { status: String((afterRes.rows[0] as unknown as Record<string, unknown>).status), winner_team_id: String((afterRes.rows[0] as unknown as Record<string, unknown>).winner_team_id) }
          : {};
        return { ok: true, before, after };
      } catch (e) {
        return { ok: false, before, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  // --- reschedule_fixture --------------------------------------------------
  catalog.register({
    action_id: 'reschedule_fixture',
    description: 'Ubah jadwal kickoff fixture (scheduled_at). Tidak mengubah status/hasil. Berguna kalau dua tim sepakat pindah waktu main.',
    parameters_schema: rescheduleFixtureParams,
    async preview(d, params) {
      const r = rescheduleFixtureParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.scheduled_at, f.status, ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.status) === 'COMPLETED' || String(row.status) === 'WALKOVER' || String(row.status) === 'CANCELLED') {
        return { summary: '', validation_errors: [`fixture status "${row.status}" — reschedule tidak relevan`] };
      }
      const old = row.scheduled_at ? String(row.scheduled_at) : '(belum dijadwal)';
      return {
        summary: `Reschedule *${String(row.a)} vs ${String(row.b)}*: kickoff ${old} → ${r.new_scheduled_at}. Alasan: "${r.reason}".`,
        validation_errors: [],
        before: { scheduled_at: old },
      };
    },
    async execute(tx, params) {
      const r = rescheduleFixtureParams.parse(params);
      const beforeRes = await tx.execute({ sql: 'SELECT scheduled_at FROM fixtures WHERE id = ?', args: [r.fixture_id] });
      const before = beforeRes.rows.length > 0 ? { scheduled_at: (beforeRes.rows[0] as unknown as Record<string, unknown>).scheduled_at ?? null } : {};
      await tx.execute({
        sql: "UPDATE fixtures SET scheduled_at = ?, updated_at = ? WHERE id = ?",
        args: [r.new_scheduled_at, new Date().toISOString(), r.fixture_id],
      });
      return { ok: true, before, after: { scheduled_at: r.new_scheduled_at } };
    },
  });

  // --- cancel_fixture ------------------------------------------------------
  catalog.register({
    action_id: 'cancel_fixture',
    description: 'Batalkan fixture (status → CANCELLED). Tidak menghasilkan stats/poin. Untuk kasus darurat organisator (mis. tim diskualifikasi, force majeure).',
    parameters_schema: cancelFixtureParams,
    async preview(d, params) {
      const r = cancelFixtureParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.status, ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.status) === 'COMPLETED' || String(row.status) === 'CANCELLED') {
        return { summary: '', validation_errors: [`fixture status "${row.status}" — cancel tidak relevan`] };
      }
      return {
        summary: `Cancel *${String(row.a)} vs ${String(row.b)}*: status ${String(row.status)} → CANCELLED. Alasan: "${r.reason}".`,
        validation_errors: [],
        before: { status: String(row.status) },
      };
    },
    async execute(tx, params) {
      const r = cancelFixtureParams.parse(params);
      const beforeRes = await tx.execute({ sql: 'SELECT status FROM fixtures WHERE id = ?', args: [r.fixture_id] });
      const before = beforeRes.rows.length > 0 ? { status: String((beforeRes.rows[0] as unknown as Record<string, unknown>).status) } : {};
      await tx.execute({
        sql: "UPDATE fixtures SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
        args: [new Date().toISOString(), r.fixture_id],
      });
      return { ok: true, before, after: { status: 'CANCELLED' } };
    },
  });

  // --- set_tournament_status ----------------------------------------------
  catalog.register({
    action_id: 'set_tournament_status',
    description: 'Ubah status turnamen (PAUSE = set ke DRAW_READY; RESUME = set ke ACTIVE; dll). Persis operasi yang Arya lakukan manual via SQL pasca-draw — sekarang via action yang aman & ter-audit.',
    parameters_schema: setTournamentStatusParams,
    async preview(d, params) {
      const r = setTournamentStatusParams.parse(params);
      const tRes = await d.execute({ sql: 'SELECT id, name, status FROM tournaments WHERE id = ?', args: [r.tournament_id] });
      if (tRes.rows.length === 0) {
        return { summary: '', validation_errors: [`tournament_id "${r.tournament_id}" tidak ditemukan`] };
      }
      const row = tRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.status) === r.new_status) {
        return { summary: '', validation_errors: [`status sudah "${r.new_status}" — tidak ada perubahan`] };
      }
      return {
        summary: `Ubah status turnamen *${String(row.name)}*: ${String(row.status)} → ${r.new_status}. Alasan: "${r.reason}".`,
        validation_errors: [],
        before: { status: String(row.status) },
      };
    },
    async execute(tx, params) {
      const r = setTournamentStatusParams.parse(params);
      const beforeRes = await tx.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: [r.tournament_id] });
      const before = beforeRes.rows.length > 0 ? { status: String((beforeRes.rows[0] as unknown as Record<string, unknown>).status) } : {};
      await tx.execute({
        sql: "UPDATE tournaments SET status = ?, updated_at = ? WHERE id = ?",
        args: [r.new_status, new Date().toISOString(), r.tournament_id],
      });
      return { ok: true, before, after: { status: r.new_status } };
    },
  });

  // --- record_ko_game_score -----------------------------------------------
  catalog.register({
    action_id: 'record_ko_game_score',
    description: 'Catat skor game knockout secara manual (sama seperti !kores <fixture> <a>-<b>). Slot game di-derive otomatis dari state series (tidak perlu sebut nomor game). Untuk fixture KNOCKOUT yang punya series.',
    parameters_schema: recordKoGameScoreParams,
    async preview(d, params) {
      const r = recordKoGameScoreParams.parse(params);
      const fxRes = await d.execute({
        sql: `SELECT f.id, f.stage, f.status, ta.team_name AS a, tb.team_name AS b
              FROM fixtures f JOIN teams ta ON ta.id=f.team_a_id JOIN teams tb ON tb.id=f.team_b_id
              WHERE f.id = ? LIMIT 1`,
        args: [r.fixture_id],
      });
      if (fxRes.rows.length === 0) {
        return { summary: '', validation_errors: [`fixture_id "${r.fixture_id}" tidak ditemukan`] };
      }
      const row = fxRes.rows[0] as unknown as Record<string, unknown>;
      if (String(row.stage) !== 'KNOCKOUT') {
        return { summary: '', validation_errors: [`fixture stage "${row.stage}" — record_ko_game_score hanya untuk KNOCKOUT`] };
      }
      const ctx = await getKoSeriesContext(d, r.fixture_id);
      if (!ctx) {
        return { summary: '', validation_errors: [`series knockout tidak ditemukan untuk fixture ini`] };
      }
      const slot = await deriveOpenGameSlot(d, r.fixture_id);
      if (!slot) {
        return { summary: '', validation_errors: [`series sudah selesai / tidak ada slot game terbuka`] };
      }
      return {
        summary: `Catat skor game KO *${String(row.a)} vs ${String(row.b)}*: ${r.team_a_score}-${r.team_b_score} (slot game #${slot.gameNumber}${slot.isTiedPendingReplay ? ', replay' : ''}). Series sekarang ${ctx.gameWinsA}-${ctx.gameWinsB}. Alasan: "${r.reason}".`,
        validation_errors: [],
        before: { series_a_wins: ctx.gameWinsA, series_b_wins: ctx.gameWinsB, slot: slot.gameNumber },
      };
    },
    async execute(tx, params) {
      const r = recordKoGameScoreParams.parse(params);
      const ctx = await getKoSeriesContext(tx as unknown as Client, r.fixture_id);
      if (!ctx) return { ok: false, error: 'series knockout tidak ditemukan' };
      const slot = await deriveOpenGameSlot(tx as unknown as Client, r.fixture_id);
      if (!slot) return { ok: false, error: 'tidak ada slot game terbuka (series selesai?)' };
      const series = await getSeriesByFixture(tx as unknown as Client, r.fixture_id);
      if (!series) return { ok: false, error: 'series tidak ditemukan' };
      const before = { series_a_wins: ctx.gameWinsA, series_b_wins: ctx.gameWinsB, slot: slot.gameNumber };
      try {
        await recordSeriesGameResult(tx as unknown as Client, {
          series_id: series.id,
          game_number: slot.gameNumber,
          team_a_score: r.team_a_score,
          team_b_score: r.team_b_score,
          is_replay: slot.isTiedPendingReplay,
          allow_completed_series: true,
        });
        return { ok: true, before, after: { team_a_score: r.team_a_score, team_b_score: r.team_b_score, slot: slot.gameNumber } };
      } catch (e) {
        return { ok: false, before, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  // --- announce ------------------------------------------------------------
  // announce is a SIDE-EFFECT action (sends a WA message). It does not mutate
  // DB state inside the transaction; the transaction only records that the
  // announcement was authorized. The actual send happens AFTER the plan
  // commits (extracted by the planner via extractAnnounceMessages), so a send
  // failure does NOT roll back the plan.
  catalog.register({
    action_id: 'announce',
    description: 'Kirim pengumuman resmi Panitia ke grup turnamen. Isi pesan bebas (maks 1500 karakter). Tidak mengubah data turnamen.',
    parameters_schema: announceParams,
    async preview(_d, params) {
      const r = announceParams.parse(params);
      return {
        summary: `Kirim pengumuman ke grup turnamen:\n"${r.message.slice(0, 200)}${r.message.length > 200 ? '…' : ''}"`,
        validation_errors: [],
        before: undefined,
      };
    },
    async execute(_tx, params) {
      const r = announceParams.parse(params);
      return { ok: true, before: undefined, after: { message_length: r.message.length } };
    },
  });

  return catalog;
}

/** Extracts announce messages from a plan for post-commit sending. */
export function extractAnnounceMessages(
  planActions: Array<{ action_id: string; params: Record<string, unknown> }>,
  execResults: Array<{ action_id: string; ok: boolean }>
): string[] {
  const out: string[] = [];
  for (let i = 0; i < planActions.length; i++) {
    const a = planActions[i];
    if (a.action_id !== 'announce') continue;
    const res = execResults[i];
    if (res?.ok) {
      const parsed = announceParams.safeParse(a.params);
      if (parsed.success) out.push(parsed.data.message);
    }
  }
  return out;
}
