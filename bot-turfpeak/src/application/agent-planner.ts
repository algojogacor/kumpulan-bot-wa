/**
 * Flash Peak TMS - Organizer AI Agent Planner (AI-native expansion, D-038)
 *
 * The organizer AI agent: turns a natural-language instruction into a typed
 * action plan, requires explicit confirmation by plan_code, and executes
 * transactionally with idempotency + full audit trail.
 *
 * Safety design (per task brief 2026-11-22, non-negotiable):
 * - NO execution without explicit !agentconfirm <code>.
 * - Idempotency: the atomic claim UPDATE (PENDING -> EXECUTING) guarantees a
 *   double-confirm CANNOT execute twice. A second confirm gets an explicit
 *   rejection stating the prior outcome + timestamp (never silently ignored).
 * - Transactional execution: ALL actions in a plan run inside ONE libSQL
 *   transaction. If any action fails, the whole plan rolls back; the plan is
 *   marked FAILED with a reason and NO half-changes persist.
 * - Crash recovery: a plan stuck in EXECUTING (bot died mid-execution) is
 *   detected by confirmAndExecute / cancelPlan as "interrupted" and reported
 *   honestly; a startup sweep marks stale EXECUTING plans as FAILED.
 * - Audit trail: every execution writes an audit_events row with before/after
 *   JSON, instruction, plan_code, and per-action results.
 * - Closed action catalog: the AI picks action_id(s) from
 *   AgentActionCatalog; it never produces SQL/code. Backend re-validates every
 *   action's params (Zod) and preconditions (preview) BEFORE staging and again
 *   before execution.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';
import { AIMalformedResponseError } from '../ai/adapter.js';
import type { AgentActionCatalog, ActionExecuteResult, TxClient } from './agent-actions.js';
import { extractAnnounceMessages } from './agent-actions.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';

const PLAN_TTL_MINUTES = 10;
const EXECUTING_STALE_MS = 5 * 60 * 1000; // EXECUTING older than this = crashed mid-execution

// =============================================================================
// Plan persistence (ai_action_plans)
// =============================================================================

interface StagedPlanRow {
  id: string;
  plan_code: string;
  tournament_id: string | null;
  organizer_address: string;
  instruction_text: string;
  plan_json: string;
  status: string;
  expires_at: string;
  executed_at: string | null;
  execution_result_json: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

async function loadPlanByCode(db: Client, planCode: string): Promise<StagedPlanRow | null> {
  const res = await db.execute({
    sql: 'SELECT * FROM ai_action_plans WHERE plan_code = ? LIMIT 1',
    args: [planCode],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    plan_code: String(r.plan_code),
    tournament_id: r.tournament_id ? String(r.tournament_id) : null,
    organizer_address: String(r.organizer_address),
    instruction_text: String(r.instruction_text),
    plan_json: String(r.plan_json),
    status: String(r.status),
    expires_at: String(r.expires_at),
    executed_at: r.executed_at ? String(r.executed_at) : null,
    execution_result_json: r.execution_result_json ? String(r.execution_result_json) : null,
    failure_reason: r.failure_reason ? String(r.failure_reason) : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function generatePlanCode(): string {
  // AGENT-XXXX where XXXX is 4 hex chars. Collision probability is low for the
  // small number of concurrent plans; the UNIQUE constraint catches collisions
  // and the caller retries.
  const hex = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `AGENT-${hex}`;
}

// =============================================================================
// Planner service
// =============================================================================

export interface AgentPlannerDeps {
  db: Client;
  providerRouter?: ProviderRouter;
  actionCatalog: AgentActionCatalog;
  sender?: WhatsAppSender;
  centralGroupJid?: string;
}

export interface PlanRequest {
  instruction: string;
  organizerAddress: string;
  organizerDelegateId: string | null;
  chatId: string;
}

export interface PlanResponse {
  success: boolean;
  responseText: string;
  planCode?: string;
}

export class AgentPlannerService {
  constructor(private readonly deps: AgentPlannerDeps) {}

  // ---------------------------------------------------------------------------
  // !agent <instruction> — build plan, stage it, return preview
  // ---------------------------------------------------------------------------
  async planFromInstruction(req: PlanRequest): Promise<PlanResponse> {
    const instruction = req.instruction.trim();
    if (!instruction) {
      return {
        success: false,
        responseText:
          '🤖 *AI AGENT PANITIA*\n\nKetik instruksi bahasa natural, contoh:\n• *!agent reopen laporan fixture abc123, alasan: skor salah*\n• *!agent pause turnamen sampai besok*\n• *!agent tim X menang WO lawan Y, lawan ga hadir*\n\nSetelah aku susun rencana, kamu konfirmasi pakai *!agentconfirm <kode>* baru aku eksekusi.',
      };
    }

    if (!this.deps.providerRouter) {
      return {
        success: false,
        responseText:
          '⚠️ AI provider belum dikonfigurasi — AI agent tidak bisa menyusun rencana. Pakai command admin manual (!reopen, !override, !kores, dll) atau hubungi engineer.',
      };
    }

    // Build planner context: active tournament + recent fixtures + catalog.
    const context = await buildPlannerContext(this.deps.db, this.deps.actionCatalog, instruction);

    let planJson: { actions: Array<{ action_id: string; params: Record<string, unknown>; rationale?: string }> };
    try {
      planJson = await callPlannerAI(this.deps.providerRouter, context, instruction);
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return {
          success: false,
          responseText:
            '⚠️ Semua AI provider gagal — aku nggak bisa nyusun rencana sekarang. Coba sebentar lagi, atau pakai command admin manual (!reopen/!override/!kores).',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        responseText: `⚠️ Gagal menyusun rencana via AI: ${msg.slice(0, 150)}`,
      };
    }

    if (!planJson.actions || planJson.actions.length === 0) {
      return {
        success: false,
        responseText:
          '🤔 Aku nggak bisa petakan instruksi kamu ke aksi yang tersedia. Aksi yang aku bisa lakukan: reopen laporan, override-lock, forfeit/WO, reschedule, cancel fixture, ubah status turnamen, catat skor KO, atau kirim pengumuman. Coba kata kunci yang lebih spesifik ya.',
      };
    }

    // Validate every action: action_id exists, params match schema, preview passes.
    const previews: Array<{ action_id: string; summary: string; errors: string[] }> = [];
    for (const proposed of planJson.actions) {
      const def = this.deps.actionCatalog.get(proposed.action_id);
      if (!def) {
        previews.push({
          action_id: proposed.action_id,
          summary: '',
          errors: [`action_id "${proposed.action_id}" tidak dikenal — pilih dari katalog`],
        });
        continue;
      }
      const parsed = def.parameters_schema.safeParse(proposed.params);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        previews.push({
          action_id: proposed.action_id,
          summary: '',
          errors: [`parameter tidak valid: ${issues}`],
        });
        continue;
      }
      try {
        const pv = await def.preview(this.deps.db, parsed.data);
        previews.push({ action_id: proposed.action_id, summary: pv.summary, errors: pv.validation_errors });
      } catch (pvErr) {
        previews.push({
          action_id: proposed.action_id,
          summary: '',
          errors: [`preview error: ${pvErr instanceof Error ? pvErr.message : String(pvErr)}`],
        });
      }
    }

    const anyInvalid = previews.some((p) => p.errors.length > 0);
    if (anyInvalid) {
      const lines = ['⚠️ *Rencana TIDAK BISA DIBUAT* — beberapa aksi gagal validasi:', ''];
      for (let i = 0; i < planJson.actions.length; i++) {
        const p = previews[i];
        lines.push(`${i + 1}. *${p.action_id}*`);
        for (const e of p.errors) lines.push(`   ❌ ${e}`);
      }
      lines.push('', 'Perbaiki instruksi atau lakukan manual via command admin.');
      return { success: false, responseText: lines.join('\n') };
    }

    // Stage the plan in DB (PENDING, ~10 min TTL).
    const planCode = await allocatePlanCode(this.deps.db);
    const planId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PLAN_TTL_MINUTES * 60 * 1000).toISOString();

    // Resolve active tournament id (if any) for FK.
    let tournamentId: string | null = null;
    try {
      const tRes = await this.deps.db.execute({
        sql: "SELECT id FROM tournaments WHERE status NOT IN ('COMPLETED','ARCHIVED') ORDER BY created_at DESC LIMIT 1",
      });
      if (tRes.rows.length > 0) tournamentId = String((tRes.rows[0] as unknown as Record<string, unknown>).id);
    } catch {
      // tolerate
    }

    const fullPlanJson = {
      actions: planJson.actions.map((a, i) => ({
        action_id: a.action_id,
        params: a.params,
        rationale: a.rationale || null,
        preview_summary: previews[i].summary,
      })),
    };

    await this.deps.db.execute({
      sql: `INSERT INTO ai_action_plans
              (id, plan_code, tournament_id, organizer_address, organizer_delegate_id,
               instruction_text, plan_json, status, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      args: [
        planId,
        planCode,
        tournamentId,
        req.organizerAddress,
        req.organizerDelegateId,
        instruction,
        JSON.stringify(fullPlanJson),
        expiresAt,
        now.toISOString(),
        now.toISOString(),
      ],
    });

    // Build the preview message shown to the organizer.
    const lines: string[] = [];
    lines.push('🤖 *RENCANA AI AGENT* — butuh konfirmasi sebelum dieksekusi');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`📋 *Kode Plan:* \`${planCode}\``);
    lines.push(`📝 *Instruksi:* "${instruction.slice(0, 200)}${instruction.length > 200 ? '…' : ''}"`);
    lines.push('');
    lines.push('*Aksi yang akan dijalankan:*');
    for (let i = 0; i < fullPlanJson.actions.length; i++) {
      const a = fullPlanJson.actions[i];
      lines.push(`${i + 1}. *${a.action_id}*`);
      lines.push(`   ${a.preview_summary}`);
    }
    lines.push('');
    lines.push(`✅ *Konfirmasi:* ketik *!agentconfirm ${planCode}*`);
    lines.push(`❌ *Batalkan:* ketik *!agentcancel ${planCode}*`);
    lines.push(`⏱️ Kedaluwarsa dalam *${PLAN_TTL_MINUTES} menit* otomatis.`);
    lines.push('');
    lines.push('_IDempotent: konfirmasi dobel akan ditolak eksplisit. Eksekusi transaksional (all-or-nothing). Tercatat di audit trail._');

    return { success: true, responseText: lines.join('\n'), planCode };
  }

  // ---------------------------------------------------------------------------
  // !agentconfirm <code> — atomic claim + transactional execution
  // ---------------------------------------------------------------------------
  async confirmAndExecute(planCode: string, organizerAddress: string): Promise<PlanResponse> {
    const code = planCode.toUpperCase();
    const plan = await loadPlanByCode(this.deps.db, code);
    if (!plan) {
      return {
        success: false,
        responseText: `⚠️ Plan *${code}* tidak ditemukan. Ketik *!agent* untuk menyusun rencana baru.`,
      };
    }

    // Authorize: only the organizer who staged the plan may confirm it.
    if (plan.organizer_address !== organizerAddress) {
      return {
        success: false,
        responseText: `⛔ Plan *${code}* dibuat oleh organizer lain. Kamu nggak bisa konfirmasi plan orang lain.`,
      };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // Status gate — explicit rejection for every non-PENDING state.
    if (plan.status === 'EXECUTED') {
      const at = plan.executed_at ? new Date(plan.executed_at).toISOString() : 'waktu tidak diketahui';
      return {
        success: false,
        responseText:
          `ℹ️ Plan *${code}* SUDAH DIEKSEKUSI pada *${at}* — konfirmasi kedua ditolak (idempotency).\n` +
          `Kalau mau melakukan aksi yang sama, susun plan baru dengan *!agent*.`,
      };
    }
    if (plan.status === 'EXECUTING') {
      // Possibly crashed mid-execution. Check staleness — measured from
      // updated_at (the time of the LAST status transition, i.e. when the plan
      // entered EXECUTING), the exact same basis as the startup sweep
      // (recoverInterruptedPlans, which compares updated_at against the
      // cutoff). Using created_at here would misclassify a plan confirmed
      // minutes after staging as "crashed mid-execution" even though its
      // EXECUTING transition is only seconds old.
      const ageMs = now.getTime() - new Date(plan.updated_at).getTime();
      if (ageMs > EXECUTING_STALE_MS) {
        // Mark as FAILED (interrupted) and inform.
        await this.deps.db.execute({
          sql: "UPDATE ai_action_plans SET status='FAILED', failure_reason=?, updated_at=? WHERE plan_code=? AND status='EXECUTING'",
          args: [`Interrupted: EXECUTING stale > ${EXECUTING_STALE_MS}ms (probable crash/restart)`, nowIso, code],
        });
        return {
          success: false,
          responseText:
            `⚠️ Plan *${code}* ditinggalkan di status EXECUTING (kemungkinan bot crash/restart di tengah eksekusi). ` +
            `Status diubah ke FAILED. Periksa audit trail / data apakah aksi sempat partially terjadi — kalau perlu susun plan baru.`,
        };
      }
      return {
        success: false,
        responseText:
          `⏳ Plan *${code}* sedang EXECUTING (baru saja dikonfirmasi). Tunggu beberapa detik untuk hasilnya — jangan konfirmasi ulang.`,
      };
    }
    if (plan.status === 'CANCELLED') {
      return {
        success: false,
        responseText: `ℹ️ Plan *${code}* sudah dibatalkan. Susun plan baru dengan *!agent* kalau masih butuh.`,
      };
    }
    if (plan.status === 'FAILED') {
      const reason = plan.failure_reason || '(tidak ada alasan)';
      return {
        success: false,
        responseText: `⚠️ Plan *${code}* sudah FAILED sebelumnya. Alasan: ${reason}. Susun plan baru dengan *!agent*.`,
      };
    }
    if (plan.status === 'EXPIRED' || new Date(plan.expires_at).getTime() < now.getTime()) {
      // Lazily expire.
      await this.deps.db.execute({
        sql: "UPDATE ai_action_plans SET status='EXPIRED', updated_at=? WHERE plan_code=? AND status='PENDING'",
        args: [nowIso, code],
      });
      return {
        success: false,
        responseText:
          `⏱️ Plan *${code}* sudah KEDALUWARSA (lebih dari ${PLAN_TTL_MINUTES} menit). ` +
          `Susun ulang rencana dengan *!agent* kalau masih relevan.`,
      };
    }

    // Atomic claim: PENDING -> EXECUTING. If affected rows = 0, someone else
    // claimed it in the race window — re-read and report the actual state.
    const claimRes = await this.deps.db.execute({
      sql: "UPDATE ai_action_plans SET status='EXECUTING', updated_at=? WHERE plan_code=? AND status='PENDING' AND expires_at > ?",
      args: [nowIso, code, nowIso],
    });
    const claimed = (claimRes as any).rowsAffected ?? (claimRes as any).changes ?? 0;
    if (claimed === 0) {
      // Lost the race — re-read and report.
      const fresh = await loadPlanByCode(this.deps.db, code);
      return {
        success: false,
        responseText:
          `ℹ️ Plan *${code}* statusnya berubah (*${fresh?.status || '?'}*) tepat saat kamu konfirmasi — kemungkinan konfirmasi ganda atau kedaluwarsa simultan. Tidak ada eksekusi ganda yang terjadi.`,
      };
    }

    // Parse the plan and execute transactionally.
    let parsedPlan: { actions: Array<{ action_id: string; params: Record<string, unknown>; rationale?: string }> };
    try {
      parsedPlan = JSON.parse(plan.plan_json);
    } catch {
      await this.markFailed(code, 'plan_json corrupt — tidak bisa di-parse');
      return { success: false, responseText: `⚠️ Plan *${code}* korup (plan_json tidak bisa di-parse). Ditandai FAILED.` };
    }

    const execResults: Array<ActionExecuteResult & { action_id: string }> = [];
    let tx: Awaited<ReturnType<Client['transaction']>> | null = null;
    try {
      tx = await this.deps.db.transaction('write');
      for (const proposed of parsedPlan.actions) {
        const def = this.deps.actionCatalog.get(proposed.action_id);
        if (!def) {
          throw new Error(`action_id "${proposed.action_id}" tidak dikenal (race: catalog berubah?)`);
        }
        const parsed = def.parameters_schema.safeParse(proposed.params);
        if (!parsed.success) {
          throw new Error(`parameter ${proposed.action_id} tidak valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        // Re-preview inside the transaction (catches races: e.g. fixture status changed since staging).
        const pv = await def.preview(tx as unknown as Client, parsed.data);
        if (pv.validation_errors.length > 0) {
          throw new Error(`precondition ${proposed.action_id} gagal saat eksekusi: ${pv.validation_errors.join('; ')}`);
        }
        const res = await def.execute(tx as unknown as TxClient, parsed.data);
        execResults.push({ ...res, action_id: proposed.action_id });
        if (!res.ok) {
          throw new Error(`aksi ${proposed.action_id} gagal: ${res.error || 'unknown error'}`);
        }
      }
      await tx.commit();
      tx = null;
    } catch (err) {
      if (tx) {
        try { await tx.rollback(); } catch { /* ignore */ }
      }
      const reason = err instanceof Error ? err.message : String(err);
      await this.markFailed(code, reason);
      // Record audit event for the failed execution.
      await this.recordAuditEvent({
        planId: plan.id,
        planCode: code,
        organizerAddress,
        instruction: plan.instruction_text,
        success: false,
        execResults,
        reason,
      });
      return {
        success: false,
        responseText:
          `❌ *Eksekusi plan ${code} GAGAL* — semua perubahan di-rollback (transaksional).\n` +
          `Alasan: ${reason.slice(0, 200)}\n` +
          `Plan ditandai FAILED. Tidak ada data setengah berubah. Susun ulang dengan *!agent* kalau masih relevan.`,
      };
    }

    // Success: update plan to EXECUTED — guarded on status='EXECUTING' so a
    // concurrently terminal plan (e.g. marked FAILED by the stale-interrupt
    // sweep while this execution was finishing) is never overwritten.
    const execSummary = execResults.map((r) => ({
      action_id: r.action_id,
      ok: r.ok,
      before: r.before,
      after: r.after,
    }));
    const executedAt = new Date().toISOString();
    const executedRes = await this.deps.db.execute({
      sql: "UPDATE ai_action_plans SET status='EXECUTED', executed_at=?, execution_result_json=?, updated_at=? WHERE plan_code=? AND status='EXECUTING'",
      args: [executedAt, JSON.stringify(execSummary), executedAt, code],
    });
    const executedRows = (executedRes as any).rowsAffected ?? (executedRes as any).changes ?? 0;
    let concurrentStatusNote = '';
    if (executedRows === 0) {
      // Rare race: another process moved the plan out of EXECUTING while this
      // execution was running. The data changes themselves DID commit —
      // report that honestly instead of silently implying the plan is
      // EXECUTED while the row says otherwise.
      const fresh = await loadPlanByCode(this.deps.db, code);
      concurrentStatusNote =
        `⚠️ Catatan: tepat saat eksekusi selesai, plan ini sudah ditandai *${fresh?.status || '?'}* oleh proses lain ` +
        `(mis. stale-recovery) — status plan TIDAK diubah ke EXECUTED supaya tidak menimpa status final itu. ` +
        `Perubahan datanya sendiri sudah terjadi dan tercatat di audit trail — verifikasi bila perlu.`;
    }

    // Audit trail.
    await this.recordAuditEvent({
      planId: plan.id,
      planCode: code,
      organizerAddress,
      instruction: plan.instruction_text,
      success: true,
      execResults,
      reason: undefined,
    });

    // Post-commit side effects: send announce messages (if any).
    const announceMsgs = extractAnnounceMessages(parsedPlan.actions, execResults);
    if (announceMsgs.length > 0 && this.deps.sender && this.deps.centralGroupJid) {
      for (const msg of announceMsgs) {
        try {
          await this.deps.sender.sendText(this.deps.centralGroupJid, `📢 *PENGUMUMAN PANITIA (via AI Agent)*\n\n${msg}`);
        } catch (sendErr) {
          // Send failure does not roll back the plan (already committed).
          // Logged but reported to organizer.
          console.error('[AgentPlanner] announce send failed (plan already committed):', sendErr);
        }
      }
    }

    // Build success message.
    const lines: string[] = [];
    lines.push('✅ *PLAN DIEKSEKUSI* — transaksional, semua aksi berhasil');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`📋 *Kode:* ${code}`);
    lines.push(`📝 *Instruksi:* "${plan.instruction_text.slice(0, 150)}${plan.instruction_text.length > 150 ? '…' : ''}"`);
    lines.push('');
    lines.push('*Hasil per aksi:*');
    for (const r of execResults) {
      lines.push(`• ${r.action_id}: ✅ sukses`);
      if (r.after) lines.push(`  → ${JSON.stringify(r.after).slice(0, 150)}`);
    }
    lines.push('');
    lines.push(`🔐 Tercatat di audit trail (entity AI_ACTION_PLAN/${plan.id.slice(0, 8)}…).`);
    if (announceMsgs.length > 0) {
      lines.push(`📢 ${announceMsgs.length} pengumuman dikirim ke grup.`);
    }
    if (concurrentStatusNote) {
      lines.push('', concurrentStatusNote);
    }
    return { success: true, responseText: lines.join('\n') };
  }

  // ---------------------------------------------------------------------------
  // !agentcancel <code> — cancel a pending plan
  // ---------------------------------------------------------------------------
  async cancelPlan(planCode: string, organizerAddress: string): Promise<PlanResponse> {
    const code = planCode.toUpperCase();
    const plan = await loadPlanByCode(this.deps.db, code);
    if (!plan) {
      return { success: false, responseText: `⚠️ Plan *${code}* tidak ditemukan.` };
    }
    if (plan.organizer_address !== organizerAddress) {
      return { success: false, responseText: `⛔ Plan *${code}* bukan milik kamu.` };
    }
    if (plan.status !== 'PENDING') {
      return {
        success: false,
        responseText: `ℹ️ Plan *${code}* status *${plan.status}* — tidak bisa dibatalkan (hanya PENDING yang bisa dicancel).`,
      };
    }
    const cancelRes = await this.deps.db.execute({
      sql: "UPDATE ai_action_plans SET status='CANCELLED', updated_at=? WHERE plan_code=? AND status='PENDING'",
      args: [new Date().toISOString(), code],
    });
    // TOCTOU guard: the plan may have left PENDING between loadPlanByCode and
    // this UPDATE (e.g. the organizer confirmed it from another device at the
    // same moment). The status='PENDING' guard in the WHERE clause kept the
    // data safe — but if rowsAffected = 0 the cancel did NOT happen, so we
    // must NOT reply "Plan dibatalkan". Re-read and report the actual state.
    const cancelledRows = (cancelRes as any).rowsAffected ?? (cancelRes as any).changes ?? 0;
    if (cancelledRows === 0) {
      const fresh = await loadPlanByCode(this.deps.db, code);
      const st = fresh?.status ?? '?';
      if (st === 'EXECUTING') {
        return {
          success: false,
          responseText:
            `⚠️ Plan *${code}* sudah mulai dieksekusi (status EXECUTING) tepat saat kamu meminta pembatalan — ` +
            `tidak bisa dibatalkan lagi dan TIDAK jadi dibatalkan. Tunggu hasil eksekusinya.`,
        };
      }
      if (st === 'EXECUTED') {
        return {
          success: false,
          responseText:
            `ℹ️ Plan *${code}* sudah selesai dieksekusi (status EXECUTED) tepat saat kamu meminta pembatalan — ` +
            `terlambat untuk dibatalkan. Cek hasil eksekusinya di atas.`,
        };
      }
      return {
        success: false,
        responseText:
          `ℹ️ Plan *${code}* statusnya berubah ke *${st}* tepat saat pembatalan diproses — tidak jadi dibatalkan ` +
          `(hanya plan PENDING yang bisa dibatalkan).`,
      };
    }
    return { success: true, responseText: `🗑️ Plan *${code}* dibatalkan.` };
  }

  // ---------------------------------------------------------------------------
  // Startup sweep: mark stale EXECUTING plans as FAILED (crash recovery).
  // Called once at app boot from FlashPeakApp.start().
  // ---------------------------------------------------------------------------
  async recoverInterruptedPlans(): Promise<number> {
    const cutoff = new Date(Date.now() - EXECUTING_STALE_MS).toISOString();
    const res = await this.deps.db.execute({
      sql: "UPDATE ai_action_plans SET status='FAILED', failure_reason=?, updated_at=? WHERE status='EXECUTING' AND updated_at < ?",
      args: [`Interrupted: EXECUTING stale (crash/restart recovery, cutoff ${cutoff})`, new Date().toISOString(), cutoff],
    });
    const n = (res as any).rowsAffected ?? (res as any).changes ?? 0;
    return n;
  }

  // ---------------------------------------------------------------------------
  private async markFailed(planCode: string, reason: string): Promise<void> {
    // Status guard: only an EXECUTING plan may transition to FAILED here —
    // same guard principle as the atomic claim and the final EXECUTED update,
    // so a terminal status set concurrently (e.g. EXECUTED by a racing
    // completion, or FAILED by the sweep) is never overwritten.
    await this.deps.db.execute({
      sql: "UPDATE ai_action_plans SET status='FAILED', failure_reason=?, updated_at=? WHERE plan_code=? AND status='EXECUTING'",
      args: [reason.slice(0, 1000), new Date().toISOString(), planCode],
    });
  }

  private async recordAuditEvent(input: {
    planId: string;
    planCode: string;
    organizerAddress: string;
    instruction: string;
    success: boolean;
    execResults: Array<ActionExecuteResult & { action_id: string }>;
    reason?: string;
  }): Promise<void> {
    const before = input.execResults.map((r) => ({ action_id: r.action_id, before: r.before }));
    const after = input.execResults.map((r) => ({ action_id: r.action_id, after: r.after, ok: r.ok }));
    try {
      await this.deps.db.execute({
        sql: `INSERT INTO audit_events
                (id, actor_type, actor_id, event_type, entity_type, entity_id,
                 before_json, after_json, reason, correlation_id, created_at)
              VALUES (?, 'ORGANIZER', ?, ?, 'AI_ACTION_PLAN', ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          input.organizerAddress,
          input.success ? 'AI_AGENT_PLAN_EXECUTED' : 'AI_AGENT_PLAN_FAILED',
          input.planId,
          JSON.stringify(before),
          JSON.stringify(after),
          input.reason
            ? `${input.planCode} FAILED: ${input.reason}`
            : `${input.planCode} executed: "${input.instruction.slice(0, 200)}"`,
          input.planCode,
          new Date().toISOString(),
        ],
      });
    } catch (e) {
      // Audit recording must never block the user-facing flow.
      console.error('[AgentPlanner] audit_events insert failed (non-blocking):', e);
    }
  }
}

// =============================================================================
// Plan code allocation (retry on collision)
// =============================================================================

async function allocatePlanCode(db: Client): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePlanCode();
    const res = await db.execute({
      sql: 'SELECT 1 FROM ai_action_plans WHERE plan_code = ? LIMIT 1',
      args: [code],
    });
    if (res.rows.length === 0) return code;
  }
  // Extremely unlikely — fall back to a longer code.
  return `AGENT-${randomUUID().slice(0, 8).toUpperCase()}`;
}

// =============================================================================
// Planner context + AI call
// =============================================================================

interface PlannerContext {
  instruction: string;
  active_tournament: { id: string; name: string; status: string } | null;
  recent_fixtures: Array<{
    id: string; stage: string; status: string; group_code: string | null; round_code: string | null;
    team_a_name: string; team_b_name: string; scheduled_at: string | null;
  }>;
  available_actions: string; // catalog.toPromptJson()
}

async function buildPlannerContext(
  db: Client,
  catalog: AgentActionCatalog,
  instruction: string
): Promise<PlannerContext> {
  let activeTournament: { id: string; name: string; status: string } | null = null;
  try {
    const tRes = await db.execute({
      sql: "SELECT id, name, status FROM tournaments WHERE status NOT IN ('COMPLETED','ARCHIVED') ORDER BY created_at DESC LIMIT 1",
    });
    if (tRes.rows.length > 0) {
      const r = tRes.rows[0] as unknown as Record<string, unknown>;
      activeTournament = { id: String(r.id), name: String(r.name), status: String(r.status) };
    }
  } catch { /* tolerate */ }

  let recentFixtures: PlannerContext['recent_fixtures'] = [];
  if (activeTournament) {
    try {
      const fRes = await db.execute({
        sql: `SELECT f.id, f.stage, f.status, f.round_code, f.scheduled_at,
                     ta.team_name AS team_a_name, tb.team_name AS team_b_name,
                     g.group_code
              FROM fixtures f
              LEFT JOIN teams ta ON ta.id = f.team_a_id
              LEFT JOIN teams tb ON tb.id = f.team_b_id
              LEFT JOIN groups g ON g.id = f.group_id
              WHERE f.tournament_id = ?
              ORDER BY (f.scheduled_at IS NULL), f.scheduled_at DESC, f.created_at DESC
              LIMIT 20`,
        args: [activeTournament.id],
      });
      recentFixtures = fRes.rows.map((r) => {
        const row = r as unknown as Record<string, unknown>;
        return {
          id: String(row.id),
          stage: String(row.stage),
          status: String(row.status),
          group_code: row.group_code ? String(row.group_code) : null,
          round_code: row.round_code ? String(row.round_code) : null,
          team_a_name: String(row.team_a_name),
          team_b_name: String(row.team_b_name),
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
        };
      });
    } catch { /* tolerate */ }
  }

  return {
    instruction,
    active_tournament: activeTournament,
    recent_fixtures: recentFixtures,
    available_actions: catalog.toPromptJson(),
  };
}

const PLANNER_SYSTEM_PROMPT = `Kamu adalah AI planner untuk organizer turnamen Flash Peak. Tugasmu: terjemahkan instruksi bahasa natural dari organizer (Panitia) menjadi satu atau lebih *aksi terstruktur* yang dipilih dari katalog yang disuplai.

ATURAN MUTLAK
1. Hanya pilih action_id yang ada di <available_actions>. Jangan invent action_id baru.
2. Isi parameter sesuai schema yang tertera. UUID fixture/tournament harus dari konteks yang disuplai (jangan ngarang UUID).
3. Kalau instruksi tidak bisa dipetakan ke aksi yang tersedia, return { "actions": [] } dan isi "note" dengan penjelasan singkat.
4. Jangan eksekusi apa pun — kamu hanya menyusun rencana. Backend akan memvalidasi, menampilkan preview, dan menunggu konfirmasi eksplisit organizer sebelum eksekusi.
5. Untuk aksi yang butuh ID (fixture_id, tournament_id, winning_team_id), ambil dari <recent_fixtures> / <active_tournament> yang sesuai. Kalau tidak yakin ID mana yang dimaksud (mis. "tim X" ambigu), return empty actions + note.
6. Maksimum 5 aksi per plan. Kalau instruksi butuh lebih, prioritas yang paling penting dulu.

OUTPUT (JSON saja, tanpa teks lain):
{
  "actions": [
    { "action_id": "...", "params": { ... }, "rationale": "alasan singkat kenapa aksi ini dipilih" }
  ],
  "note": "opsional: catatan/klarifikasi kalau perlu"
}`;

async function callPlannerAI(
  router: ProviderRouter,
  context: PlannerContext,
  instruction: string
): Promise<{ actions: Array<{ action_id: string; params: Record<string, unknown>; rationale?: string }> }> {
  const userPrompt =
    `<instruction>\n${instruction}\n</instruction>\n\n` +
    `<context>\n${JSON.stringify(context, null, 2)}\n</context>\n\n` +
    `Return JSON only.`;
  const response = await router.execute({
    task: 'PLAN_AGENT',
    structured_output: true,
    system_prompt: PLANNER_SYSTEM_PROMPT,
    prompt: userPrompt,
    temperature: 0.2,
    timeout_ms: 30_000,
    correlation_id: `agent-plan-${randomUUID().slice(0, 8)}`,
  });
  const raw = (response.raw_text || '').trim();
  // Tolerate markdown code fences.
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new AIMalformedResponseError('GROQ', `planner response has no JSON object`);
  }
  const jsonStr = raw.slice(jsonStart, jsonEnd + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new AIMalformedResponseError('GROQ', `planner JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || !Array.isArray(parsed.actions)) {
    throw new AIMalformedResponseError('GROQ', 'planner JSON missing "actions" array');
  }
  // Normalize: drop actions missing action_id.
  const actions = parsed.actions
    .filter((a: any) => a && typeof a.action_id === 'string')
    .map((a: any) => ({
      action_id: String(a.action_id),
      params: (a.params && typeof a.params === 'object') ? a.params : {},
      rationale: typeof a.rationale === 'string' ? a.rationale : undefined,
    }))
    .slice(0, 5);
  return { actions };
}
