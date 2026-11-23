/**
 * Flash Peak TMS - WhatsApp Adapter Types & Interfaces
 * 
 * Defines normalized event models, sender options, and router contracts.
 */

import type { proto } from '@whiskeysockets/baileys';
import type {
  InboundMessageType,
  WhatsAppAddressType,
  ISODateString,
  UUID,
} from '../shared/types/index.js';

export type { InboundMessageType, WhatsAppAddressType };

/**
 * Normalized representation of an incoming WhatsApp message.
 * Decouples domain logic from Baileys-specific protobuf structures.
 */
export interface NormalizedMessage {
  id: UUID;
  provider_message_key: string; // Unique Baileys message ID (e.g. stanza id)
  chat_id: string; // WhatsApp chat JID (e.g. 120363000000000000@g.us or user JID)
  sender_raw_address: string; // Raw participant or remote JID
  sender_normalized_address: string; // jidNormalizedUser representation
  address_type: WhatsAppAddressType; // 'JID' | 'LID' | 'PHONE' | 'UNKNOWN'
  is_from_me: boolean;
  participant: string | null; // Participant JID inside group, if applicable
  push_name: string | null; // Push name reported by sender
  message_timestamp: ISODateString; // Timestamp from WhatsApp server
  received_at: ISODateString; // Local machine receipt time
  message_type: InboundMessageType; // 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'OTHER'
  text_body: string | null; // Extracted text body
  caption: string | null; // Media caption if applicable
  reply_to_key: string | null; // Quoted message ID (stanzaId) if replying
  quoted_participant: string | null; // Participant JID of the quoted message
  quoted_text: string | null; // Text snippet of quoted message
  media_metadata?: {
    mimetype?: string | null;
    fileLength?: number | string | null;
    fileName?: string | null;
    seconds?: number | null;
  } | null;
  raw_message: proto.IWebMessageInfo; // Original Baileys message for full auditability
}

/**
 * Options for sending outbound WhatsApp messages.
 */
export interface SendOptions {
  quoted?: proto.IWebMessageInfo | { key: { remoteJid?: string; id?: string; participant?: string } };
  mentions?: string[];
  ephemeralExpiration?: number;
}

/**
 * Authorization roles for WhatsApp command execution.
 */
export type UserRole = 'ORGANIZER' | 'DELEGATE' | 'UNKNOWN';

/**
 * Execution context supplied to WhatsApp command handlers.
 */
export interface CommandContext {
  message: NormalizedMessage;
  command: string;
  args: string[];
  rawArgs: string;
  role: UserRole;
  delegateId: UUID | null;
  teamId: UUID | null;
  isOrganizer: boolean;
  isCentralGroup: boolean;
  isAdminChat: boolean;
}

/**
 * Result returned by a command handler.
 */
export interface CommandResult {
  success: boolean;
  responseText?: string;
  replyToMessage?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Handler function signature for command registration.
 */
export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult> | CommandResult;

/**
 * Command definition and security constraints.
 */
export interface CommandDefinition {
  command: string;
  handler: CommandHandler;
  requiredRole: 'ORGANIZER' | 'DELEGATE' | 'ANY';
  description?: string;
  allowedInDm?: boolean; // Default: true for organizer, false for delegates
  allowedInGroup?: boolean; // Default: true
  allowOutsideCentralGroup?: boolean; // Default: false; allow command execution outside central group (e.g. !id)
}
