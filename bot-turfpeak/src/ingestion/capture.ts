import crypto from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  InboundMessage,
  InboundMessageType,
} from '../shared/types/index.js';

export interface CaptureMessageParams {
  provider_message_key: string;
  chat_id: string;
  sender_raw_address: string;
  delegate_id?: string | null;
  message_timestamp: string;
  received_at?: string;
  message_type: InboundMessageType;
  text_body?: string | null;
  caption?: string | null;
  reply_to_key?: string | null;
  report_session_id?: string | null;
  raw_metadata_json?: string;
}

export interface CaptureMessageResult {
  message: InboundMessage;
  isDuplicate: boolean;
}

export function mapRowToInboundMessage(row: Record<string, unknown>): InboundMessage {
  return {
    id: String(row.id),
    provider_message_key: String(row.provider_message_key),
    chat_id: String(row.chat_id),
    sender_raw_address: String(row.sender_raw_address),
    delegate_id: row.delegate_id ? String(row.delegate_id) : null,
    message_timestamp: String(row.message_timestamp),
    received_at: String(row.received_at),
    message_type: row.message_type as InboundMessageType,
    text_body: row.text_body ? String(row.text_body) : null,
    caption: row.caption ? String(row.caption) : null,
    reply_to_key: row.reply_to_key ? String(row.reply_to_key) : null,
    report_session_id: row.report_session_id ? String(row.report_session_id) : null,
    raw_metadata_json: String(row.raw_metadata_json || '{}'),
    created_at: String(row.created_at),
  };
}

/**
 * Captures an inbound WhatsApp message, guaranteeing idempotency and deduplication
 * via the stable provider_message_key constraint (FR-ING-006).
 */
export async function captureInboundMessage(
  db: Client,
  params: CaptureMessageParams
): Promise<CaptureMessageResult> {
  // 1. Check if message with provider_message_key already exists
  const existing = await db.execute({
    sql: 'SELECT * FROM inbound_messages WHERE provider_message_key = ? LIMIT 1',
    args: [params.provider_message_key],
  });

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as Record<string, unknown>;
    return {
      message: mapRowToInboundMessage(row),
      isDuplicate: true,
    };
  }

  // 2. Insert new message record
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const receivedAt = params.received_at || now;

  const newMessage: InboundMessage = {
    id,
    provider_message_key: params.provider_message_key,
    chat_id: params.chat_id,
    sender_raw_address: params.sender_raw_address,
    delegate_id: params.delegate_id ?? null,
    message_timestamp: params.message_timestamp,
    received_at: receivedAt,
    message_type: params.message_type,
    text_body: params.text_body ?? null,
    caption: params.caption ?? null,
    reply_to_key: params.reply_to_key ?? null,
    report_session_id: params.report_session_id ?? null,
    raw_metadata_json: params.raw_metadata_json || '{}',
    created_at: now,
  };

  try {
    await db.execute({
      sql: `INSERT INTO inbound_messages (
        id, provider_message_key, chat_id, sender_raw_address,
        delegate_id, message_timestamp, received_at, message_type,
        text_body, caption, reply_to_key, report_session_id,
        raw_metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newMessage.id,
        newMessage.provider_message_key,
        newMessage.chat_id,
        newMessage.sender_raw_address,
        newMessage.delegate_id,
        newMessage.message_timestamp,
        newMessage.received_at,
        newMessage.message_type,
        newMessage.text_body,
        newMessage.caption,
        newMessage.reply_to_key,
        newMessage.report_session_id,
        newMessage.raw_metadata_json,
        newMessage.created_at,
      ],
    });

    return {
      message: newMessage,
      isDuplicate: false,
    };
  } catch (err) {
    // In case of concurrent race on unique index constraint, re-read existing
    const retryExisting = await db.execute({
      sql: 'SELECT * FROM inbound_messages WHERE provider_message_key = ? LIMIT 1',
      args: [params.provider_message_key],
    });

    if (retryExisting.rows.length > 0) {
      const row = retryExisting.rows[0] as unknown as Record<string, unknown>;
      return {
        message: mapRowToInboundMessage(row),
        isDuplicate: true,
      };
    }

    throw err;
  }
}

export async function getInboundMessagesBySession(
  db: Client,
  sessionId: string
): Promise<InboundMessage[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM inbound_messages WHERE report_session_id = ? ORDER BY message_timestamp ASC',
    args: [sessionId],
  });

  return result.rows.map((r) => mapRowToInboundMessage(r as unknown as Record<string, unknown>));
}
