/**
 * Flash Peak TMS - Fixture Resolution Service (Application Layer)
 * 
 * Resolves incoming WhatsApp match report messages to active tournament fixtures:
 * 1. Explicit Caption / Text match (Highest Priority)
 *    - Detects mentioned team names in captions via word-boundary regex
 *    - Evaluates explicit winner declarations ('pemenang', 'menang', 'win')
 * 2. Identity-based Auto-Lock (Fallback when caption has no team name)
 *    - Resolves verified sender delegate to their registered team
 *    - Finds the team's earliest active scheduled fixture
 * 3. Fallback for organizer or unattached submissions
 *    - Returns the earliest scheduled fixture in the active tournament
 */

import type { Client } from '@libsql/client';
import type { IdentityResolver } from '../identity/resolver.js';
import type { NormalizedMessage } from '../whatsapp/types.js';

export interface MatchedFixtureResult {
  id: string;
  team_a_id: string;
  submitting_team_id?: string;
}

/**
 * AUDIT-VERIFY-T4 (21 Nov 2026): the BO1 group-stage evidence pipeline must
 * never target a KNOCKOUT fixture. Knockout series are BO3/BO5 managed by the
 * dedicated !kogame per-game pipeline (ko-evidence-pipeline.ts); a plain photo
 * without a !kogame caption used to resolve to an active knockout fixture here
 * and produced a parallel BO1 draft for a series that already has its own
 * state machine. All queries below filter stage = 'GROUP'.
 */

export async function resolveFixtureForMessage(
  db: Client,
  identityResolver: IdentityResolver,
  message: NormalizedMessage
): Promise<MatchedFixtureResult | null> {
  const captionText = (message.caption || message.text_body || '').trim();

  // 1. Explicit Caption / Text match (Highest Priority)
  // When a team name is mentioned, that team is explicitly designated as the winner!
  if (captionText) {
    const teamsRes = await db.execute({
      sql: `
        SELECT t.id, t.team_name
        FROM teams t
        JOIN tournaments tr ON t.tournament_id = tr.id
        WHERE tr.status = 'ACTIVE'
      `,
      args: [],
    });

    const matchedTeams: Array<{ id: string; team_name: string }> = [];
    for (const row of teamsRes.rows) {
      const tId = String(row.id ?? row[0]);
      const tName = String(row.team_name ?? row[1]);
      const escaped = tName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|\\s|[^a-zA-Z0-9])${escaped}($|\\s|[^a-zA-Z0-9])`, 'i');
      if (pattern.test(captionText)) {
        matchedTeams.push({ id: tId, team_name: tName });
      }
    }

    if (matchedTeams.length === 1) {
      const winnerTeam = matchedTeams[0];
      const matchedFixture = await db.execute({
        sql: `
          SELECT f.id, f.team_a_id
          FROM fixtures f
          JOIN tournaments tr ON f.tournament_id = tr.id
          WHERE tr.status = 'ACTIVE'
            AND f.stage = 'GROUP'
            AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
            AND (f.team_a_id = ? OR f.team_b_id = ?)
          ORDER BY f.round_code ASC, f.created_at ASC
          LIMIT 1
        `,
        args: [winnerTeam.id, winnerTeam.id],
      });
      if (matchedFixture.rows.length > 0 && matchedFixture.rows[0]) {
        const mRow = matchedFixture.rows[0];
        return {
          id: String(mRow.id ?? mRow[0]),
          team_a_id: String(mRow.team_a_id ?? mRow[1]),
          submitting_team_id: winnerTeam.id,
        };
      }
    } else if (matchedTeams.length >= 2) {
      const team1 = matchedTeams[0];
      const team2 = matchedTeams[1];
      const matchedFixture = await db.execute({
        sql: `
          SELECT f.id, f.team_a_id, f.team_b_id
          FROM fixtures f
          JOIN tournaments tr ON f.tournament_id = tr.id
          WHERE tr.status = 'ACTIVE'
            AND f.stage = 'GROUP'
            AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
            AND ((f.team_a_id = ? AND f.team_b_id = ?) OR (f.team_a_id = ? AND f.team_b_id = ?))
          ORDER BY f.round_code ASC, f.created_at ASC
          LIMIT 1
        `,
        args: [team1.id, team2.id, team2.id, team1.id],
      });
      if (matchedFixture.rows.length > 0 && matchedFixture.rows[0]) {
        const mRow = matchedFixture.rows[0];
        let winnerId = team1.id;
        const lowerCaption = captionText.toLowerCase();
        const t2Escaped = team2.team_name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const t2WinPattern = new RegExp(`(pemenang|menang|win|juara)[:\\s]+${t2Escaped}|${t2Escaped}[:\\s]+(menang|win)`, 'i');
        if (t2WinPattern.test(lowerCaption)) {
          winnerId = team2.id;
        }
        return {
          id: String(mRow.id ?? mRow[0]),
          team_a_id: String(mRow.team_a_id ?? mRow[1]),
          submitting_team_id: winnerId,
        };
      }
    }
  }

  // 2. Identity-based Auto-Lock (Fallback when caption has no team name)
  let senderTeamId: string | null = null;
  try {
    const resolvedIdentity = await identityResolver.resolveIdentity(
      message.sender_raw_address,
      message.chat_id
    );

    if (resolvedIdentity.status === 'VERIFIED' && resolvedIdentity.team) {
      senderTeamId = resolvedIdentity.team.id;
    }
  } catch (err) {
    console.warn('[FixtureResolver] Error resolving identity for fixture lookup:', err);
  }

  if (senderTeamId) {
    const teamFixture = await db.execute({
      sql: `
        SELECT f.id, f.team_a_id
        FROM fixtures f
        JOIN tournaments t ON f.tournament_id = t.id
        WHERE t.status = 'ACTIVE'
          AND f.stage = 'GROUP'
          AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
          AND (f.team_a_id = ? OR f.team_b_id = ?)
        ORDER BY f.round_code ASC, f.created_at ASC
        LIMIT 1
      `,
      args: [senderTeamId, senderTeamId],
    });
    if (teamFixture.rows.length > 0 && teamFixture.rows[0]) {
      const row = teamFixture.rows[0];
      return {
        id: String(row.id ?? row[0]),
        team_a_id: String(row.team_a_id ?? row[1]),
        submitting_team_id: senderTeamId,
      };
    }
  }

  // 3. Fallback for organizer or unattached submissions: first scheduled match in active tournament
  const fallback = await db.execute({
    sql: `
      SELECT f.id, f.team_a_id
      FROM fixtures f
      JOIN tournaments tr ON f.tournament_id = tr.id
      WHERE tr.status = 'ACTIVE'
        AND f.stage = 'GROUP'
        AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
      ORDER BY f.round_code ASC, f.created_at ASC
      LIMIT 1
    `,
    args: [],
  });

  if (fallback.rows.length > 0 && fallback.rows[0]) {
    const fbRow = fallback.rows[0];
    return {
      id: String(fbRow.id ?? fbRow[0]),
      team_a_id: String(fbRow.team_a_id ?? fbRow[1]),
    };
  }

  return null;
}
