/**
 * Flash Peak TMS - Report Correction Coordinator (Application Layer)
 * 
 * Coordinates natural language match report correction use cases:
 * - Assembles structured ReportContext from immutable validated draft data
 * - Invokes AI CorrectionParser to produce typed JSON patches
 * - Ensures inbound correction message is captured in database
 * - Applies correction patch to generate a new immutable report version
 * - Resets all prior approvals on the target report version
 * - Formats user-friendly confirmation or clarification reply text
 */

import type { Client } from '@libsql/client';
import type { CorrectionParser, ReportContext } from '../ai/correction-parser.js';
import type { IdentityResolver } from '../identity/resolver.js';
import { getReportVersion } from '../reports/versioning.js';
import { applyReportCorrection, type CorrectionResult } from '../reports/corrections.js';
import { captureInboundMessage } from '../ingestion/capture.js';
import type { NormalizedMessage } from '../whatsapp/types.js';
import type { UUID } from '../shared/types/index.js';

export interface ReportCorrectionCoordinatorDeps {
  db: Client;
  correctionParser: CorrectionParser;
  identityResolver: IdentityResolver;
}

export async function handleReportCorrection(
  deps: ReportCorrectionCoordinatorDeps,
  versionId: UUID,
  message: NormalizedMessage,
  isOrganizer = false
): Promise<{ result: CorrectionResult; replyText: string }> {
  const { db, correctionParser, identityResolver } = deps;

  const version = await getReportVersion(db, versionId);
  if (!version) {
    throw new Error(`Report version not found: ${versionId}`);
  }

  const text = message.text_body || message.caption || '';
  const validatedData = JSON.parse(version.validated_data_json);

  const reportContext: ReportContext = {
    report_version_id: versionId,
    team_a: {
      id: validatedData.team_a_id,
      name: 'Team A',
      players: (validatedData.team_a_players || []).map((p: any, idx: number) => ({
        ordinal: idx + 1,
        nickname: p.nickname_raw,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense: p.defense_raw,
      })),
    },
    team_b: {
      id: validatedData.team_b_id,
      name: 'Team B',
      players: (validatedData.team_b_players || []).map((p: any, idx: number) => ({
        ordinal: idx + 1,
        nickname: p.nickname_raw,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense: p.defense_raw,
      })),
    },
    score_a: validatedData.team_a_score,
    score_b: validatedData.team_b_score,
  };

  const parseOutcome = await correctionParser.parse({
    message_text: text,
    report_context: reportContext,
  });

  if (parseOutcome.status !== 'PROPOSED') {
    return {
      result: {
        success: false,
        status: 'NEEDS_CLARIFICATION',
        clarification_reason: parseOutcome.clarification_reason,
      },
      replyText: `❓ *Perlu Klarifikasi:* ${parseOutcome.clarification_reason}`,
    };
  }

  // AUDIT-VERIFY (new-bug #2, fixed 21 Nov 2026): pass the chat context like
  // the CommandRouter does. resolveIdentity currently ignores its second
  // parameter (_sourceChatId), so this is a no-op today — but it keeps the
  // call-site consistent with the router so any future per-chat narrowing or
  // auditing in resolveIdentity applies identically here.
  const resolved = await identityResolver.resolveIdentity(
    message.sender_raw_address,
    message.chat_id
  );
  const senderId = resolved?.delegate?.id || message.sender_normalized_address;

  // Ensure inbound message is recorded in database
  let inboundMsgId = message.id;
  const msgRow = await db.execute({
    sql: 'SELECT id FROM inbound_messages WHERE provider_message_key = ? LIMIT 1',
    args: [message.provider_message_key],
  });
  if (msgRow.rows.length > 0) {
    inboundMsgId = String(msgRow.rows[0][0]);
  } else {
    const captured = await captureInboundMessage(db, {
      provider_message_key: message.provider_message_key,
      chat_id: message.chat_id,
      sender_raw_address: message.sender_raw_address,
      delegate_id: resolved?.delegate?.id || null,
      message_timestamp: message.message_timestamp,
      message_type: message.message_type,
      text_body: message.text_body,
      caption: message.caption,
      reply_to_key: message.reply_to_key,
      report_session_id: version.report_session_id,
    });
    inboundMsgId = captured.message.id;
  }

  const result = await applyReportCorrection(db, {
    target_report_version_id: versionId,
    sender_id: senderId,
    inbound_message_id: inboundMsgId,
    patch: parseOutcome.patch,
    // AUDIT-VERIFY-T6: forward the organizer flag resolved upstream by the
    // CommandRouter; without it verifyCorrectionAuthority rejected every
    // organizer correction as 'Unauthorized sender'.
    is_organizer: isOrganizer,
  });

  let replyText = '';
  if (result.success && result.newVersion) {
    replyText = `✅ *Koreksi Berhasil Diterapkan (Versi ${result.newVersion.version_number})*\nSemua persetujuan sebelumnya telah direset.\nSilakan review dan setujui kembali menggunakan *!approve*.`;
  } else {
    replyText = `❌ *Koreksi Gagal:* ${result.error || 'Perlu klarifikasi data.'}`;
  }

  return { result, replyText };
}
