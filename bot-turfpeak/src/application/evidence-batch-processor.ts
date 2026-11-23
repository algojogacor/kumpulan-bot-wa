/**
 * Flash Peak TMS - Evidence Batch Processor (Application Layer)
 * 
 * Coordinates the end-to-end evidence batch processing pipeline:
 * - Downloads media assets from Flash Peak media service
 * - Runs multi-provider AI vision classification (MAIN_MATCH_SUMMARY vs INDIVIDUAL_PLAYER_DETAIL)
 * - Extracts match scoreboard statistics via MatchSummaryExtractor
 * - Identifies explicit winner declaration in captions and performs Team A/B score and player swapping
 * - Validates extracted match data against backend deterministic business rules
 * - Creates immutable draft version (v1) in report_versions table
 * - Formats user-facing match report summary for WhatsApp
 * - Handles AI outages gracefully with standardized participant notifications
 * - Updates atomic debounce batch lifecycle state
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Client } from '@libsql/client';
import type { ClaimedBatch } from '../ingestion/debounce.js';
import { completeDebounceBatch, rescheduleDebounceRetry } from '../ingestion/debounce.js';
import type { FlashPeakMediaClient } from '../media/client.js';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';
import { AIMalformedResponseError } from '../ai/adapter.js';
import type { ImageClassifier } from '../ai/classifier.js';
import type { MatchSummaryExtractor } from '../ai/extractors/match.js';
import type { GoalkeeperDetailExtractor } from '../ai/extractors/goalkeeper.js';
import { resolveGoalkeeperIdentity, type RosterPlayerCandidate } from '../ai/extractors/gk-identity.js';
import { validateMatchReport, cleanSearchKey, matchPlayerToRoster } from '../reports/validation.js';
import type { Player } from '../shared/types/index.js';
import { createReportDraft } from '../reports/versioning.js';
import {
  formatMatchReportSummary,
  type MatchReportSummaryParams,
} from '../whatsapp/formatters.js';
import {
  formatAIFailureMessage,
  formatAIRetryPendingMessage,
  formatAIRetriesExhaustedMessage,
  formatUnreadableEvidenceMessage,
  formatGoalkeeperSuspendedMessage,
} from '../whatsapp/failure.js';
import type { UUID, ReportVersion } from '../shared/types/index.js';

export interface ProcessedBatchResult {
  sessionId: UUID;
  fixtureId: UUID;
  targetChatId?: string;
  status: 'DRAFT_CREATED' | 'NEEDS_CORRECTION' | 'AI_FAILED' | 'AI_RETRY_SCHEDULED' | 'NO_MEDIA';
  draftVersion?: ReportVersion;
  whatsappSummary?: string;
  error?: string;
  /** True when this result was an automatic AI retry attempt (provider outage). */
  isAIRetry?: boolean;
  /** True when the retry budget is exhausted and manual verification is required. */
  retriesExhausted?: boolean;
}

export interface EvidenceBatchProcessorDeps {
  db: Client;
  mediaClient?: FlashPeakMediaClient;
  providerRouter?: ProviderRouter;
  classifier?: ImageClassifier;
  matchExtractor?: MatchSummaryExtractor;
  gkExtractor?: GoalkeeperDetailExtractor;
  centralGroupJid?: string;
  /** Max automatic retries per session after AllProvidersFailedError (default 3). */
  aiMaxRetries?: number;
  /** Delay before the next automatic retry attempt (default 60s, aligned with router cooldown). */
  aiRetryDelayMs?: number;
}

export async function processClaimedBatch(
  deps: EvidenceBatchProcessorDeps,
  batch: ClaimedBatch
): Promise<ProcessedBatchResult> {
  const { db, mediaClient, providerRouter, classifier, matchExtractor, gkExtractor, centralGroupJid } = deps;
  const aiMaxRetries = deps.aiMaxRetries ?? 3;
  const aiRetryDelayMs = deps.aiRetryDelayMs ?? 60_000;
  const sessionId = batch.session.id;
  const fixtureId = batch.session.fixture_id;
  const retryCount = batch.session.ai_retry_count;

  const chatRes = await db.execute({
    sql: 'SELECT chat_id FROM inbound_messages WHERE report_session_id = ? ORDER BY message_timestamp DESC LIMIT 1',
    args: [sessionId],
  });
  const targetChatId = chatRes.rows.length > 0 && chatRes.rows[0][0]
    ? String(chatRes.rows[0][0])
    : centralGroupJid;

  try {
    if (batch.mediaAssets.length === 0) {
      await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'NO_MEDIA',
        whatsappSummary: '⚠️ Bukti foto pertandingan tidak terdeteksi atau gagal diunduh. Silakan kirim ulang screenshot skor akhir pertandingan.',
        error: 'No media attachments in claimed batch',
      };
    }

    if (!providerRouter || !classifier || !matchExtractor) {
      await completeDebounceBatch(db, sessionId, 'FAILED');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_FAILED',
        error: 'AI router not configured',
      };
    }

    let mainMatchBase64: string | null = null;
    const gkDetailAssets: Array<{ base64: string; mime_type: string; caption?: string }> = [];
    const gkWarnings: string[] = [];
    let downloadFailureCount = 0;

    for (const asset of batch.mediaAssets) {
      // B-2: a media asset that cannot be re-downloaded is SKIPPED. Placeholder
      // bytes (the old MOCK_BASE64_DATA fallback) must never be fed to the
      // vision pipeline — the participant is told below when this happens.
      let base64: string;
      if (mediaClient) {
        try {
          const filename = path.basename(asset.storage_key);
          const remoteId = filename.split('.')[0] || asset.id;
          const downloaded = await mediaClient.downloadMedia(remoteId, asset.sha256);
          base64 = downloaded.buffer.toString('base64');
        } catch (dlErr) {
          console.error(`[AI] Failed to download media asset ${asset.id}:`, dlErr);
          downloadFailureCount++;
          continue;
        }
      } else {
        // No media client configured: the stored bytes cannot be retrieved, so
        // this asset is unusable for AI processing. Production always wires a
        // media client (start.ts aborts without the media secret).
        downloadFailureCount++;
        continue;
      }

      const classification = await classifier.classify({
        mime_type: asset.mime_type,
        base64,
      });

      if (classification.screen_type === 'MAIN_MATCH_SUMMARY' && !mainMatchBase64) {
        mainMatchBase64 = base64;
      } else if (classification.screen_type === 'INDIVIDUAL_PLAYER_DETAIL') {
        const linkedMsg = batch.messages.find((m) => m.id === asset.source_message_id);
        const caption = linkedMsg?.caption || linkedMsg?.text_body || undefined;
        gkDetailAssets.push({ base64, mime_type: asset.mime_type, caption });
      } else if (classification.screen_type === 'UNREADABLE') {
        const linkedMsg = batch.messages.find((m) => m.id === asset.source_message_id);
        const caption = `${linkedMsg?.caption || ''} ${linkedMsg?.text_body || ''}`.toLowerCase();
        const mentionsGk = caption.includes('gk') || caption.includes('kiper') || caption.includes('keeper');
        if (mentionsGk) {
          await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
          return {
            sessionId,
            fixtureId,
            targetChatId,
            status: 'NEEDS_CORRECTION',
            whatsappSummary: formatGoalkeeperSuspendedMessage({ sessionId }),
            error: 'Goalkeeper statistics submission suspended by tournament regulations',
          };
        }

        // AI responded but could not read the image: participant-side fix needed.
        // Terminal for this attempt (no provider-outage retry): ask for a clearer photo.
        await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
        return {
          sessionId,
          fixtureId,
          targetChatId,
          status: 'NEEDS_CORRECTION',
          whatsappSummary: formatUnreadableEvidenceMessage({
            sessionId,
            reason: classification.reason || 'Klasifikasi AI: gambar tidak terbaca',
          }),
          error: `Screenshot classified UNREADABLE: ${classification.reason}`,
        };
      }
    }

    // B-2: when EVERY asset failed to re-download, no AI call happened at all.
    // Complete the session as INCOMPLETE and ask the participant to resend —
    // never fall through with placeholder bytes.
    if (downloadFailureCount > 0 && downloadFailureCount === batch.mediaAssets.length) {
      await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'NO_MEDIA',
        whatsappSummary: formatUnreadableEvidenceMessage({
          sessionId,
          reason:
            `Semua ${downloadFailureCount} foto bukti gagal diunduh ulang dari layanan media. ` +
            'Silakan kirim ulang screenshot skor akhir pertandingan.',
        }),
        error: `All ${downloadFailureCount} media assets failed to re-download from the media service`,
      };
    }

    // B-2 (partial failure): proceed with the assets that did download, but
    // surface the skipped ones so the summary never claims they were read.
    if (downloadFailureCount > 0) {
      gkWarnings.push(
        `ℹ️ ${downloadFailureCount} foto bukti gagal diunduh ulang dari layanan media dan dilewati.`
      );
    }

    if (!mainMatchBase64) {
      await completeDebounceBatch(db, sessionId, 'INCOMPLETE');

      const isGoalkeeperDetected =
        gkDetailAssets.length > 0 ||
        batch.messages.some((m) => {
          const text = `${m.caption || ''} ${m.text_body || ''}`.toLowerCase();
          return text.includes('gk') || text.includes('kiper') || text.includes('keeper');
        });

      if (isGoalkeeperDetected) {
        return {
          sessionId,
          fixtureId,
          targetChatId,
          status: 'NEEDS_CORRECTION',
          whatsappSummary: formatGoalkeeperSuspendedMessage({ sessionId }),
          error: 'Goalkeeper statistics submission suspended by tournament regulations',
        };
      }

      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'NEEDS_CORRECTION',
        whatsappSummary: formatUnreadableEvidenceMessage({
          sessionId,
          reason:
            'Screenshot skor akhir pertandingan (main match summary) tidak terdeteksi di laporan ini. ' +
            'Pastikan kamu mengirim screenshot halaman skor akhir, bukan hanya halaman detail pemain.' +
            (downloadFailureCount > 0
              ? ` (${downloadFailureCount} foto juga gagal diunduh ulang dari layanan media.)`
              : ''),
        }),
        error: 'Main match summary screenshot missing',
      };
    }

    const fixtureRes = await db.execute({
      sql: `SELECT f.id, f.team_a_id, f.team_b_id, f.left_side_team_id, g.id AS game_id, ta.team_name, tb.team_name
            FROM fixtures f
            LEFT JOIN games g ON g.fixture_id = f.id
            LEFT JOIN teams ta ON f.team_a_id = ta.id
            LEFT JOIN teams tb ON f.team_b_id = tb.id
            WHERE f.id = ? LIMIT 1`,
      args: [fixtureId],
    });

    if (fixtureRes.rows.length === 0) {
      throw new Error(`Fixture not found: ${fixtureId}`);
    }

    const fRow = fixtureRes.rows[0];
    const teamAId = String(fRow[1]);
    const teamBId = String(fRow[2]);
    const leftSideTeamId = fRow[3] ? String(fRow[3]) : teamAId;
    const gameId = fRow[4] ? String(fRow[4]) : randomUUID();
    const teamAName = String(fRow[5] || 'Tim A');
    const teamBName = String(fRow[6] || 'Tim B');

    // Query active roster for both teams to supply grounded trusted_context (FIX-CTX-001)
    const playersRes = await db.execute({
      sql: `SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status
            FROM players
            WHERE team_id IN (?, ?) AND status = 'ACTIVE'`,
      args: [teamAId, teamBId],
    });

    const expectedRoster: Array<{ nickname: string; team_id?: string }> = playersRes.rows.map((row: any) => ({
      nickname: String(row.nickname_raw ?? row[3]),
      team_id: String(row.team_id ?? row[2]),
    }));

    const registeredPlayers: Player[] = playersRes.rows.map((row: any) => ({
      id: String(row.id ?? row[0]),
      tournament_id: String(row.tournament_id ?? row[1]),
      team_id: String(row.team_id ?? row[2]),
      nickname_raw: String(row.nickname_raw ?? row[3]),
      nickname_nfc: String(row.nickname_nfc ?? row[4]),
      nickname_search_key: String(row.nickname_search_key ?? row[5]),
      position: String(row.position ?? row[6]) as Player['position'],
      roster_slot: Number(row.roster_slot ?? row[7]),
      roster_type: String(row.roster_type ?? row[8]) as Player['roster_type'],
      status: String(row.status ?? row[9]) as Player['status'],
      created_at: '',
      updated_at: '',
    }));

    const rosterA = registeredPlayers.filter((p) => p.team_id === teamAId);
    const rosterB = registeredPlayers.filter((p) => p.team_id === teamBId);

    const matchExtraction = await matchExtractor.extract(
      {
        mime_type: 'image/jpeg',
        base64: mainMatchBase64,
      },
      {
        trusted_context: {
          fixture_id: fixtureId,
          team_a_name: teamAName,
          team_b_name: teamBName,
          expected_roster: expectedRoster,
        },
        correlation_id: `session-${sessionId}`,
      }
    );

    const sessionRowRes = await db.execute({
      sql: `SELECT submitting_team_id FROM report_sessions WHERE id = ? LIMIT 1`,
      args: [sessionId],
    });
    let submittingTeamId = sessionRowRes.rows.length > 0 ? String(sessionRowRes.rows[0][0]) : null;

    // Check if any message in the debounce batch explicitly specified a winning team
    for (const msg of batch.messages) {
      const text = (msg.caption || msg.text_body || '').trim().toLowerCase();
      if (!text) continue;
      const bName = teamBName.toLowerCase();
      const aName = teamAName.toLowerCase();
      const bMatch = text.includes(bName);
      const aMatch = text.includes(aName);

      if (bMatch && !aMatch) {
        submittingTeamId = teamBId;
        await db.execute({
          sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
          args: [teamBId, sessionId],
        });
        break;
      } else if (aMatch && !bMatch) {
        submittingTeamId = teamAId;
        await db.execute({
          sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
          args: [teamAId, sessionId],
        });
        break;
      } else if (aMatch && bMatch) {
        const bWinPattern = new RegExp(`(pemenang|menang|win|juara)[:\\s]+${bName}|${bName}[:\\s]+(menang|win)`, 'i');
        if (bWinPattern.test(text)) {
          submittingTeamId = teamBId;
          await db.execute({
            sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
            args: [teamBId, sessionId],
          });
          break;
        }
      }
    }

    const leftExtractedPlayers = matchExtraction.summary_data.team_a_players || [];
    const rightExtractedPlayers = matchExtraction.summary_data.team_b_players || [];
    const rawLeftScore = matchExtraction.summary_data.team_a_score ?? 0;
    const rawRightScore = matchExtraction.summary_data.team_b_score ?? 0;

    let leftMatchesA = 0;
    let leftMatchesB = 0;
    for (const p of leftExtractedPlayers) {
      if (matchPlayerToRoster(p, rosterA)) leftMatchesA++;
      if (matchPlayerToRoster(p, rosterB)) leftMatchesB++;
    }

    let rightMatchesA = 0;
    let rightMatchesB = 0;
    for (const p of rightExtractedPlayers) {
      if (matchPlayerToRoster(p, rosterA)) rightMatchesA++;
      if (matchPlayerToRoster(p, rosterB)) rightMatchesB++;
    }

    // Determine if screenshot sides are inverted (Left is Team B and Right is Team A)
    let isSidesSwapped = false;
    const normalScore = leftMatchesA + rightMatchesB;
    const invertedScore = leftMatchesB + rightMatchesA;

    if (invertedScore > normalScore) {
      isSidesSwapped = true;
    } else if (normalScore === 0 && invertedScore === 0) {
      // Fallback: use fixture left_side_team_id if no players matched
      if (leftSideTeamId === teamBId) {
        isSidesSwapped = true;
      }
    }

    const teamAScore = isSidesSwapped ? rawRightScore : rawLeftScore;
    const teamBScore = isSidesSwapped ? rawLeftScore : rawRightScore;

    const rawPlayersForA = isSidesSwapped ? rightExtractedPlayers : leftExtractedPlayers;
    const rawPlayersForB = isSidesSwapped ? leftExtractedPlayers : rightExtractedPlayers;

    // --- Goalkeeper Extraction, Caption Matching & Quota Validation (FIX-GK-001, FIX-GK-002) ---
    // 1. Determine series format and expected GK screenshots (FR-GK-007)
    const seriesRes = await db.execute({
      sql: `SELECT s.format, s.target_wins, f.stage
            FROM fixtures f
            LEFT JOIN series s ON s.fixture_id = f.id
            WHERE f.id = ? LIMIT 1`,
      args: [fixtureId],
    });

    let expectedGkCount = 0;
    let seriesFormat: string | null = null;
    let isKnockoutSeries = false;

    // Catatan: Verifikasi bukti screenshot kiper ditangguhkan sementara jika SUSPEND_GOALKEEPER aktif
    const isGkSuspended = process.env.SUSPEND_GOALKEEPER === 'true';

    if (seriesRes.rows.length > 0) {
      const sRow = seriesRes.rows[0];
      const stage = String(sRow.stage || '');
      seriesFormat = sRow.format ? String(sRow.format) : null;
      if (!isGkSuspended) {
        if (seriesFormat === 'BO3') {
          expectedGkCount = 2; // BO3 winner won 2 games -> exactly 2 GK screenshots required
          isKnockoutSeries = true;
        } else if (seriesFormat === 'BO5') {
          expectedGkCount = 3; // BO5 winner won 3 games -> exactly 3 GK screenshots required
          isKnockoutSeries = true;
        } else if (stage === 'GROUP') {
          expectedGkCount = teamAScore === teamBScore ? 0 : 1;
        }
      }
    }

    // Check GK screenshot quota completeness
    let isGkCountValid = true;
    if (expectedGkCount > 0) {
      if (gkDetailAssets.length < expectedGkCount) {
        isGkCountValid = false;
        gkWarnings.push(
          `⚠️ Bukti kiper belum lengkap: Format ${seriesFormat || 'pertandingan'} mewajibkan ${expectedGkCount} screenshot detail kiper pemenang (berdasarkan game yang dimenangkan), tetapi baru terdeteksi ${gkDetailAssets.length} screenshot kiper.`
        );
      } else if (gkDetailAssets.length > expectedGkCount) {
        gkWarnings.push(
          `ℹ️ Screenshot kiper (${gkDetailAssets.length}) melebihi kuota format ${seriesFormat || 'pertandingan'} (${expectedGkCount}).`
        );
      }
    }

    // 2. Extract goalkeeper detail screenshots & match identity via caption fuzzy match (FR-GK-005, D-030)
    const winningTeamId = teamAScore > teamBScore ? teamAId : (teamBScore > teamAScore ? teamBId : null);
    const targetGkTeamId = winningTeamId || submittingTeamId || teamAId;
    const rosterRes = await db.execute({
      sql: `SELECT id, nickname_raw, position, team_id FROM players WHERE team_id IN (?, ?) AND status = 'ACTIVE'`,
      args: [teamAId, teamBId],
    });

    const rosterCandidates: RosterPlayerCandidate[] = rosterRes.rows
      .filter((r: any) => String(r.team_id) === targetGkTeamId)
      .map((r: any) => ({
        id: String(r.id),
        nickname: String(r.nickname_raw),
        is_goalkeeper: String(r.position) === 'GOALKEEPER',
      }));

    const gkSavesByNickname = new Map<string, number>();

    if (gkExtractor && gkDetailAssets.length > 0) {
      for (const gkAsset of gkDetailAssets) {
        try {
          const gkResult = await gkExtractor.extract({
            mime_type: gkAsset.mime_type,
            base64: gkAsset.base64,
          });

          const extractedSaves = gkResult.summary.defense_raw ?? 0;

          // Match identity using caption fuzzy match against roster
          const idRes = resolveGoalkeeperIdentity({
            caption: gkAsset.caption,
            submitting_team_roster: rosterCandidates,
          });

          let matchedNick: string | null = null;
          if (idRes.status === 'UNIQUE' && idRes.candidate_nickname) {
            matchedNick = idRes.candidate_nickname;
          } else {
            // Fallback: If only 1 designated keeper in roster, match to them
            const regKeepers = rosterCandidates.filter((p) => p.is_goalkeeper);
            if (regKeepers.length === 1) {
              matchedNick = regKeepers[0].nickname;
            } else {
              gkWarnings.push(
                `Identitas kiper pada screenshot detail (${gkAsset.caption || 'tanpa caption'}) ambigu: ${idRes.reason}.`
              );
            }
          }

          if (matchedNick) {
            const current = gkSavesByNickname.get(matchedNick) || 0;
            gkSavesByNickname.set(matchedNick, Math.max(current, extractedSaves));
          }
        } catch (err) {
          console.error('[AI] Error extracting goalkeeper detail screen:', err);
          gkWarnings.push('Gagal mengekstrak metrik kiper dari screenshot detail.');
        }
      }
    }

    const resolvePlayerSaves = (nick: string, teamPlayers: any[]): number | null => {
      const lower = nick.toLowerCase();
      const clean = cleanSearchKey(nick);
      for (const [gNick, saves] of gkSavesByNickname.entries()) {
        const gClean = cleanSearchKey(gNick);
        if (
          lower.includes(gNick.toLowerCase()) ||
          gNick.toLowerCase().includes(lower) ||
          (clean.length >= 3 && clean === gClean)
        ) {
          return saves;
        }
      }
      return null;
    };

    const buildFullLineup = (
      players: typeof rawPlayersForA,
      roster: Player[],
      opponentScore: number
    ) => {
      if (players.length >= 5) return players;
      const gk = roster.find((p) => p.position === 'GOALKEEPER') ||
        roster.find((p) => !players.some((pl) => pl.nickname_raw === p.nickname_raw));
      if (gk && !players.some((pl) => pl.nickname_raw === gk.nickname_raw)) {
        return [
          {
            nickname_raw: gk.nickname_raw,
            rating: 10.0,
            goals: 0,
            assists: 0,
            passes: 0,
            defense: opponentScore,
          },
          ...players,
        ];
      }
      return players;
    };

    const fullPlayersForA = buildFullLineup(rawPlayersForA, rosterA, teamBScore);
    const fullPlayersForB = buildFullLineup(rawPlayersForB, rosterB, teamAScore);

    const validation = await validateMatchReport(db, {
      fixture_id: fixtureId,
      game_id: gameId,
      team_a_id: teamAId,
      team_b_id: teamBId,
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      team_a_players: fullPlayersForA.map((p) => ({
        nickname_raw: p.nickname_raw,
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense_raw: p.defense,
        goalkeeper_saves: resolvePlayerSaves(p.nickname_raw, fullPlayersForA),
      })),
      team_b_players: fullPlayersForB.map((p) => ({
        nickname_raw: p.nickname_raw,
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense_raw: p.defense,
        goalkeeper_saves: resolvePlayerSaves(p.nickname_raw, fullPlayersForB),
      })),
    });

    // Append goalkeeper warnings to validation output
    if (gkWarnings.length > 0) {
      validation.warnings.push(...gkWarnings);
    }
    if (gkDetailAssets.length > 0) {
      validation.warnings.push(
        'ℹ️ Foto kiper diabaikan karena penghargaan Best Goalkeeper ditangguhkan oleh panitia untuk season ini.'
      );
    }

    // If Knockout BO3/BO5 GK screenshot count is deficient, flag as NEEDS_CORRECTION
    if (isKnockoutSeries && !isGkCountValid) {
      validation.isValid = false;
      validation.errors.push(...gkWarnings.filter((w) => w.startsWith('⚠️')));
    }

    const draftStatus = validation.isValid ? 'PENDING_APPROVAL' : 'NEEDS_CORRECTION';

    const draftVersion = await createReportDraft(db, {
      report_session_id: sessionId,
      fixture_id: fixtureId,
      extraction_json: JSON.stringify(matchExtraction),
      validated_data_json: JSON.stringify(validation.validatedData || {}),
      provenance: 'AI',
      status: draftStatus,
    });

    await completeDebounceBatch(db, sessionId, 'DRAFT_READY');

    const summaryParams: MatchReportSummaryParams = {
      status: draftStatus,
      versionNumber: draftVersion.version_number,
      teamAName,
      teamBName,
      teamAScore,
      teamBScore,
      teamAPlayers: fullPlayersForA.map((p, idx) => {
        const valRating = validation.validatedData?.team_a_players?.[idx]?.rating;
        let r = valRating !== undefined && valRating !== null ? valRating : p.rating;
        if (r !== null && r !== undefined && r > 10.0) {
          r = Number((r / 10).toFixed(1));
        }
        return {
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: r,
        };
      }),
      teamBPlayers: fullPlayersForB.map((p, idx) => {
        const valRating = validation.validatedData?.team_b_players?.[idx]?.rating;
        let r = valRating !== undefined && valRating !== null ? valRating : p.rating;
        if (r !== null && r !== undefined && r > 10.0) {
          r = Number((r / 10).toFixed(1));
        }
        return {
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: r,
        };
      }),
      uncertainties: [
        ...validation.errors.map((e) => `❌ ${e}`),
        ...validation.warnings,
      ],
      rejectionReason:
        validation.errors.length > 0
          ? validation.errors.join('\n')
          : undefined,
      pendingApprovers:
        draftStatus !== 'PENDING_APPROVAL'
          ? []
          : teamAScore > teamBScore
          ? ['TEAM_A', 'ORGANIZER']
          : teamBScore > teamAScore
          ? ['TEAM_B', 'ORGANIZER']
          : ['TEAM_A', 'TEAM_B', 'ORGANIZER'],
    };

    const whatsappSummary = formatMatchReportSummary(summaryParams);

    return {
      sessionId,
      fixtureId,
      targetChatId,
      status: validation.isValid ? 'DRAFT_CREATED' : 'NEEDS_CORRECTION',
      draftVersion,
      whatsappSummary,
    };
  } catch (err) {
    // ── Failure cause differentiation ──────────────────────────────────────────
    // The router wraps every adapter error into AllProvidersFailedError, so the
    // true cause lives in its `errors[]` entries. Classify by the inner errors:
    // an outage (network/5xx/timeout on all providers) is retryable, while an
    // AIMalformedResponseError means at least one provider ANSWERED but produced
    // an unusable extraction for this screenshot — a participant-side resend is
    // the actionable fix, not a retry.
    const innerErrors =
      err instanceof AllProvidersFailedError
        ? err.errors.map((e) => e.error).filter((e): e is Error => e instanceof Error)
        : [];
    const allMalformed =
      innerErrors.length > 0 && innerErrors.every((e) => e instanceof AIMalformedResponseError);
    const isOutage = err instanceof AllProvidersFailedError && !allMalformed;

    // (d) Every provider answered but none could produce a valid extraction for
    //     this screenshot: ask for a clearer photo. Not an outage, no retry loop.
    if (allMalformed) {
      await completeDebounceBatch(db, sessionId, 'FAILED');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_FAILED',
        whatsappSummary: formatUnreadableEvidenceMessage({
          sessionId,
          reason: `Hasil pembacaan AI tidak valid: ${innerErrors[0].message}`,
        }),
        error: String(err),
      };
    }

    // (b) All providers failed (outage) but the retry budget is not exhausted:
    //     reschedule via the existing debounce queue and tell the participant the
    //     system will retry automatically (no manual action yet).
    if (isOutage && retryCount < aiMaxRetries) {
      const rescheduled = await rescheduleDebounceRetry(db, sessionId, aiRetryDelayMs);
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_RETRY_SCHEDULED',
        whatsappSummary: formatAIRetryPendingMessage({
          sessionId,
          attemptNumber: rescheduled.ai_retry_count,
          maxRetries: aiMaxRetries,
          nextRetryAt: new Date(rescheduled.debounce_due_at),
        }),
        error: String(err),
        isAIRetry: true,
      };
    }

    // (c) All providers failed AND the retry budget is exhausted: terminal.
    //     This is the only path that asks for manual verification (FR-FAIL-002).
    if (isOutage) {
      await completeDebounceBatch(db, sessionId, 'FAILED');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_FAILED',
        whatsappSummary: formatAIRetriesExhaustedMessage({
          sessionId,
          attemptNumber: retryCount,
          includeAdminCommandHint: true,
        }),
        error: String(err),
        retriesExhausted: true,
      };
    }

    // Direct AIMalformedResponseError (thrown without router wrapping, e.g. by
    // schema validation right after a successful response).
    if (err instanceof AIMalformedResponseError) {
      await completeDebounceBatch(db, sessionId, 'FAILED');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_FAILED',
        whatsappSummary: formatUnreadableEvidenceMessage({
          sessionId,
          reason: `Hasil pembacaan AI tidak valid: ${err.message}`,
        }),
        error: String(err),
      };
    }

    // Unexpected error (DB failure, media service down, bug): keep the previous
    // standardized failure notice so nothing silently disappears.
    await completeDebounceBatch(db, sessionId, 'FAILED');
    const failMsg = formatAIFailureMessage({
      sessionId,
      includeAdminCommandHint: true,
    });

    return {
      sessionId,
      fixtureId,
      targetChatId,
      status: 'AI_FAILED',
      whatsappSummary: failMsg,
      error: String(err),
    };
  }
}
