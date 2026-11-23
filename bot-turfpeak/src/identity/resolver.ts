/**
 * Flash Peak TMS - WhatsApp Identity & Delegate Resolver
 * 
 * Maps incoming WhatsApp addresses (JID, LID, Phone) to canonical delegates,
 * prevents duplicate registrations from linked devices, and handles identity ambiguity.
 */

import { randomUUID } from 'node:crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { Client } from '@libsql/client';
import { getDb } from '../db/client.js';
import type {
  Delegate,
  WhatsAppIdentity,
  WhatsAppAddressType,
  Team,
  UUID,
} from '../shared/types/index.js';
import { getAddressType } from '../whatsapp/normalizer.js';

export type IdentityResolutionStatus =
  | 'VERIFIED'
  | 'UNREGISTERED'
  | 'INACTIVE'
  | 'SUSPENDED'
  | 'AMBIGUOUS';

export interface IdentityResolutionResult {
  status: IdentityResolutionStatus;
  rawAddress: string;
  normalizedAddress: string;
  addressType: WhatsAppAddressType;
  delegate?: Delegate;
  identity?: WhatsAppIdentity;
  team?: Team;
  /** Name of the tournament the resolved team belongs to (UX-ID-001). */
  tournament_name?: string;
  error?: string;
}

export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

export class IdentityResolver {
  private db: Client;

  constructor(db?: Client) {
    this.db = db || getDb();
  }

  /**
   * Resolves an observed WhatsApp address to a registered delegate and team.
   */
  public async resolveIdentity(
    rawAddress: string,
    _sourceChatId?: string
  ): Promise<IdentityResolutionResult> {
    const normalized = jidNormalizedUser(rawAddress);
    const addressType = getAddressType(rawAddress);

    // 1. Query identity by raw_address or normalized user address
    const identityResult = await this.db.execute({
      sql: `SELECT id, delegate_id, raw_address, address_type, is_primary, verified_at, source_chat_id, created_at
            FROM whatsapp_identities
            WHERE raw_address = ? OR raw_address = ?
            LIMIT 1`,
      args: [rawAddress, normalized],
    });

    if (identityResult.rows.length === 0) {
      return {
        status: 'UNREGISTERED',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
      };
    }

    const row = identityResult.rows[0];
    if (!row) {
      return {
        status: 'UNREGISTERED',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
      };
    }

    const identity: WhatsAppIdentity = {
      id: String(row[0]),
      delegate_id: String(row[1]),
      raw_address: String(row[2]),
      address_type: String(row[3]) as WhatsAppAddressType,
      is_primary: Number(row[4]),
      verified_at: row[5] ? String(row[5]) : null,
      source_chat_id: row[6] ? String(row[6]) : null,
      created_at: String(row[7]),
    };

    // 2. Fetch associated delegate
    const delegateResult = await this.db.execute({
      sql: `SELECT id, display_name, status, created_at, updated_at
            FROM delegates
            WHERE id = ?
            LIMIT 1`,
      args: [identity.delegate_id],
    });

    if (delegateResult.rows.length === 0) {
      return {
        status: 'AMBIGUOUS',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
        identity,
        error: `Delegate record ${identity.delegate_id} missing in database`,
      };
    }

    const dRow = delegateResult.rows[0];
    if (!dRow) {
      return {
        status: 'AMBIGUOUS',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
        identity,
        error: `Delegate record ${identity.delegate_id} missing in database`,
      };
    }

    const delegate: Delegate = {
      id: String(dRow[0]),
      display_name: String(dRow[1]),
      status: String(dRow[2]) as Delegate['status'],
      created_at: String(dRow[3]),
      updated_at: String(dRow[4]),
    };

    if (delegate.status === 'SUSPENDED') {
      return {
        status: 'SUSPENDED',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
        delegate,
        identity,
      };
    }

    if (delegate.status === 'INACTIVE') {
      return {
        status: 'INACTIVE',
        rawAddress,
        normalizedAddress: normalized,
        addressType,
        delegate,
        identity,
      };
    }

    // 3. Fetch active team linked to this delegate
    // AUDIT-VERIFY-T14 (21 Nov 2026): restrict to the ACTIVE tournament.
    // Teams of past/completed tournaments stay in the database, and the old
    // unfiltered query resolved a delegate to their OLD team after a new
    // tournament was created — fixture resolution and corrections then
    // targeted the wrong tournament. Preference order:
    //   a) team in an ACTIVE tournament
    //   b) team in any not-yet-completed tournament (DRAFT/REGISTRATION/...)
    //   c) most recent team (fallback for admin tooling on archived data)
    let team: Team | undefined;
    let tournamentName: string | undefined;
    const teamResult = await this.db.execute({
      sql: `SELECT t.id, t.tournament_id, t.organization_name, t.division_name, t.team_name, t.team_code, t.delegate_id, t.registration_status, t.created_at, t.updated_at, tr.name
            FROM teams t
            JOIN tournaments tr ON t.tournament_id = tr.id
            WHERE t.delegate_id = ?
            ORDER BY CASE tr.status
                WHEN 'ACTIVE' THEN 0
                WHEN 'COMPLETED' THEN 2
                WHEN 'ARCHIVED' THEN 3
                ELSE 1
              END ASC,
              tr.created_at DESC
            LIMIT 1`,
      args: [delegate.id],
    });

    if (teamResult.rows.length > 0 && teamResult.rows[0]) {
      const tRow = teamResult.rows[0];
      team = {
        id: String(tRow[0]),
        tournament_id: String(tRow[1]),
        organization_name: tRow[2] ? String(tRow[2]) : null,
        division_name: tRow[3] ? String(tRow[3]) : null,
        team_name: String(tRow[4]),
        team_code: tRow[5] ? String(tRow[5]) : null,
        delegate_id: tRow[6] ? String(tRow[6]) : null,
        registration_status: String(tRow[7]) as Team['registration_status'],
        created_at: String(tRow[8]),
        updated_at: String(tRow[9]),
      };
      tournamentName = tRow[10] ? String(tRow[10]) : undefined;
    }

    return {
      status: 'VERIFIED',
      rawAddress,
      normalizedAddress: normalized,
      addressType,
      delegate,
      identity,
      team,
      tournament_name: tournamentName,
    };
  }

  /**
   * Links an observed address (e.g. LID or linked device) to an existing delegate.
   * Throws IdentityConflictError if the address is already claimed by a different delegate.
   */
  public async linkIdentity(
    delegateId: UUID,
    rawAddress: string,
    addressType: WhatsAppAddressType,
    options?: {
      isPrimary?: boolean;
      sourceChatId?: string;
      verifiedAt?: string;
    }
  ): Promise<WhatsAppIdentity> {
    const normalized = jidNormalizedUser(rawAddress);

    // Check if this address or normalized variant is already registered
    const existing = await this.db.execute({
      sql: `SELECT id, delegate_id, raw_address, address_type, is_primary, verified_at, source_chat_id, created_at
            FROM whatsapp_identities
            WHERE raw_address = ? OR raw_address = ?
            LIMIT 1`,
      args: [rawAddress, normalized],
    });

    if (existing.rows.length > 0 && existing.rows[0]) {
      const row = existing.rows[0];
      const existingDelegateId = String(row[1]);

      if (existingDelegateId !== delegateId) {
        throw new IdentityConflictError(
          `Address ${rawAddress} is already registered to a different delegate (${existingDelegateId})`
        );
      }

      // Address is already linked to the same delegate; update if needed
      const identityId = String(row[0]);

      if (options?.isPrimary) {
        await this.db.execute({
          sql: `UPDATE whatsapp_identities SET is_primary = 1, source_chat_id = COALESCE(?, source_chat_id) WHERE id = ?`,
          args: [options.sourceChatId || null, identityId],
        });
      }

      return {
        id: identityId,
        delegate_id: delegateId,
        raw_address: String(row[2]),
        address_type: String(row[3]) as WhatsAppAddressType,
        is_primary: options?.isPrimary ? 1 : Number(row[4]),
        verified_at: row[5] ? String(row[5]) : null,
        source_chat_id: options?.sourceChatId || (row[6] ? String(row[6]) : null),
        created_at: String(row[7]),
      };
    }

    // Insert new identity alias
    const id = randomUUID();
    const now = new Date().toISOString();
    const verifiedAt = options?.verifiedAt || now;
    const isPrimary = options?.isPrimary ? 1 : 0;
    const sourceChatId = options?.sourceChatId || null;

    // Use normalized address for storage consistency if JID/LID
    const addressToStore = normalized;

    await this.db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, verified_at, source_chat_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        delegateId,
        addressToStore,
        addressType,
        isPrimary,
        verifiedAt,
        sourceChatId,
        now,
      ],
    });

    return {
      id,
      delegate_id: delegateId,
      raw_address: addressToStore,
      address_type: addressType,
      is_primary: isPrimary,
      verified_at: verifiedAt,
      source_chat_id: sourceChatId,
      created_at: now,
    };
  }

  /**
   * Creates a new delegate and their primary WhatsApp identity atomically.
   */
  public async createDelegateWithIdentity(
    displayName: string,
    rawAddress: string,
    addressType: WhatsAppAddressType,
    options?: {
      sourceChatId?: string;
      isPrimary?: boolean;
    }
  ): Promise<{ delegate: Delegate; identity: WhatsAppIdentity }> {
    const delegateId = randomUUID();
    const now = new Date().toISOString();

    const delegate: Delegate = {
      id: delegateId,
      display_name: displayName,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    };

    // Insert delegate
    await this.db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [delegate.id, delegate.display_name, delegate.status, delegate.created_at, delegate.updated_at],
    });

    // Link primary identity
    const identity = await this.linkIdentity(delegateId, rawAddress, addressType, {
      isPrimary: options?.isPrimary ?? true,
      sourceChatId: options?.sourceChatId,
      verifiedAt: now,
    });

    return { delegate, identity };
  }

  /**
   * Binds a delegate to a team. Updates registration status to VERIFIED.
   */
  public async bindDelegateToTeam(teamId: UUID, delegateId: UUID): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.db.execute({
      sql: `UPDATE teams
            SET delegate_id = ?, registration_status = 'VERIFIED', updated_at = ?
            WHERE id = ?`,
      args: [delegateId, now, teamId],
    });

    if (result.rowsAffected === 0) {
      throw new Error(`Team ${teamId} not found`);
    }
  }

  /**
   * Retrieves delegate details and all linked aliases for a given team.
   */
  public async getDelegateByTeam(
    teamId: UUID
  ): Promise<{ delegate: Delegate; identities: WhatsAppIdentity[] } | null> {
    const teamResult = await this.db.execute({
      sql: `SELECT delegate_id FROM teams WHERE id = ?`,
      args: [teamId],
    });

    if (teamResult.rows.length === 0 || !teamResult.rows[0]?.[0]) {
      return null;
    }

    const delegateId = String(teamResult.rows[0][0]);
    const dRes = await this.db.execute({
      sql: `SELECT id, display_name, status, created_at, updated_at FROM delegates WHERE id = ?`,
      args: [delegateId],
    });

    if (dRes.rows.length === 0 || !dRes.rows[0]) return null;
    const dRow = dRes.rows[0];
    const delegate: Delegate = {
      id: String(dRow[0]),
      display_name: String(dRow[1]),
      status: String(dRow[2]) as Delegate['status'],
      created_at: String(dRow[3]),
      updated_at: String(dRow[4]),
    };

    const iRes = await this.db.execute({
      sql: `SELECT id, delegate_id, raw_address, address_type, is_primary, verified_at, source_chat_id, created_at
            FROM whatsapp_identities WHERE delegate_id = ?`,
      args: [delegateId],
    });

    const identities: WhatsAppIdentity[] = iRes.rows.map((r) => ({
      id: String(r[0]),
      delegate_id: String(r[1]),
      raw_address: String(r[2]),
      address_type: String(r[3]) as WhatsAppAddressType,
      is_primary: Number(r[4]),
      verified_at: r[5] ? String(r[5]) : null,
      source_chat_id: r[6] ? String(r[6]) : null,
      created_at: String(r[7]),
    }));

    return { delegate, identities };
  }
}
