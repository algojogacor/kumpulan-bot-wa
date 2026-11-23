/**
 * Flash Peak TMS - WhatsApp Inbound Event Normalizer
 * 
 * Normalizes raw Baileys WAMessage protobuf events into authoritative internal
 * NormalizedMessage formats, unwrapping nested containers and standardizing addresses.
 */

import { randomUUID } from 'node:crypto';
import {
  jidNormalizedUser,
  type proto,
} from '@whiskeysockets/baileys';
import type {
  NormalizedMessage,
  InboundMessageType,
  WhatsAppAddressType,
} from './types.js';

/**
 * Normalizes a raw Baileys message event into our domain format.
 * Returns null if the message payload is empty or not processable.
 */
export function normalizeWAMessage(
  msg: proto.IWebMessageInfo,
  receivedAt: Date = new Date()
): NormalizedMessage | null {
  if (!msg.key) {
    return null;
  }

  const rawChatId = msg.key.remoteJid || '';
  if (!rawChatId) {
    return null;
  }
  const chatId = jidNormalizedUser(rawChatId);

  // Determine sender raw and normalized address
  const isFromMe = Boolean(msg.key.fromMe);
  const rawSender = msg.key.participant || msg.key.remoteJid || '';
  const normalizedSender = jidNormalizedUser(rawSender);
  const participant = msg.key.participant ? jidNormalizedUser(msg.key.participant) : null;

  // Determine WhatsApp address type
  const addressType = getAddressType(rawSender || normalizedSender);

  // Unwrap potential nested messages (ephemeral, view-once, etc.)
  const content = unwrapMessageContent(msg.message);
  if (!content) {
    return null;
  }

  // Extract message type, text body, caption, and media metadata
  const { messageType, textBody, caption, mediaMetadata, contextInfo } = extractMessagePayload(content);

  // Extract quoted reply context
  const replyToKey = contextInfo?.stanzaId || null;
  const quotedParticipant = contextInfo?.participant
    ? jidNormalizedUser(contextInfo.participant)
    : null;
  const quotedText = extractQuotedText(contextInfo?.quotedMessage);

  // Parse message timestamp
  const messageTimestamp = parseBaileysTimestamp(msg.messageTimestamp);

  const providerMessageKey = msg.key.id || randomUUID();

  return {
    id: randomUUID(),
    provider_message_key: providerMessageKey,
    chat_id: chatId,
    sender_raw_address: rawSender,
    sender_normalized_address: normalizedSender,
    address_type: addressType,
    is_from_me: isFromMe,
    participant,
    push_name: msg.pushName || null,
    message_timestamp: messageTimestamp,
    received_at: receivedAt.toISOString(),
    message_type: messageType,
    text_body: textBody,
    caption,
    reply_to_key: replyToKey,
    quoted_participant: quotedParticipant,
    quoted_text: quotedText,
    media_metadata: mediaMetadata,
    raw_message: msg,
  };
}

/**
 * Determines the WhatsApp address type from the raw address string.
 */
export function getAddressType(address: string): WhatsAppAddressType {
  const clean = address.toLowerCase().trim();
  if (clean.endsWith('@lid')) {
    return 'LID';
  }
  if (clean.endsWith('@s.whatsapp.net')) {
    return 'JID';
  }
  if (/^\+?\d{8,16}$/.test(clean)) {
    return 'PHONE';
  }
  return 'UNKNOWN';
}

/**
 * Recursively unwraps ephemeral, view-once, and caption-wrapped messages.
 */
export function unwrapMessageContent(
  message?: proto.IMessage | null
): proto.IMessage | null | undefined {
  if (!message) return null;

  let current: proto.IMessage = message;

  // Keep unwrapping while wrapped inside wrapper containers
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }

  return current;
}

interface ExtractedPayload {
  messageType: InboundMessageType;
  textBody: string | null;
  caption: string | null;
  mediaMetadata: NormalizedMessage['media_metadata'];
  contextInfo?: proto.IContextInfo | null;
}

/**
 * Extracts normalized text, caption, and media properties from unwrapped IMessage.
 */
function extractMessagePayload(content: proto.IMessage): ExtractedPayload {
  if (content.conversation) {
    return {
      messageType: 'TEXT',
      textBody: content.conversation,
      caption: null,
      mediaMetadata: null,
    };
  }

  if (content.extendedTextMessage) {
    return {
      messageType: 'TEXT',
      textBody: content.extendedTextMessage.text || null,
      caption: null,
      mediaMetadata: null,
      contextInfo: content.extendedTextMessage.contextInfo,
    };
  }

  if (content.imageMessage) {
    const img = content.imageMessage;
    return {
      messageType: 'IMAGE',
      textBody: null,
      caption: img.caption || null,
      mediaMetadata: {
        mimetype: img.mimetype || 'image/jpeg',
        fileLength: typeof img.fileLength === 'object' && img.fileLength !== null ? Number(img.fileLength) : img.fileLength,
      },
      contextInfo: img.contextInfo,
    };
  }

  if (content.videoMessage) {
    const vid = content.videoMessage;
    return {
      messageType: 'VIDEO',
      textBody: null,
      caption: vid.caption || null,
      mediaMetadata: {
        mimetype: vid.mimetype || 'video/mp4',
        fileLength: typeof vid.fileLength === 'object' && vid.fileLength !== null ? Number(vid.fileLength) : vid.fileLength,
        seconds: vid.seconds || null,
      },
      contextInfo: vid.contextInfo,
    };
  }

  if (content.audioMessage) {
    const aud = content.audioMessage;
    return {
      messageType: 'AUDIO',
      textBody: null,
      caption: null,
      mediaMetadata: {
        mimetype: aud.mimetype || 'audio/ogg',
        fileLength: typeof aud.fileLength === 'object' && aud.fileLength !== null ? Number(aud.fileLength) : aud.fileLength,
        seconds: aud.seconds || null,
      },
      contextInfo: aud.contextInfo,
    };
  }

  if (content.documentMessage) {
    const doc = content.documentMessage;
    return {
      messageType: 'DOCUMENT',
      textBody: null,
      caption: doc.caption || null,
      mediaMetadata: {
        mimetype: doc.mimetype || 'application/octet-stream',
        fileLength: typeof doc.fileLength === 'object' && doc.fileLength !== null ? Number(doc.fileLength) : doc.fileLength,
        fileName: doc.fileName || null,
      },
      contextInfo: doc.contextInfo,
    };
  }

  return {
    messageType: 'OTHER',
    textBody: null,
    caption: null,
    mediaMetadata: null,
  };
}

/**
 * Extracts snippet text from a quoted message.
 */
function extractQuotedText(quoted?: proto.IMessage | null): string | null {
  if (!quoted) return null;
  const unwrapped = unwrapMessageContent(quoted);
  if (!unwrapped) return null;

  if (unwrapped.conversation) return unwrapped.conversation;
  if (unwrapped.extendedTextMessage?.text) return unwrapped.extendedTextMessage.text;
  if (unwrapped.imageMessage?.caption) return unwrapped.imageMessage.caption;
  if (unwrapped.videoMessage?.caption) return unwrapped.videoMessage.caption;
  if (unwrapped.documentMessage?.caption) return unwrapped.documentMessage.caption;

  return null;
}

/**
 * Parses Baileys numeric/Long timestamp to ISO-8601 string.
 */
function parseBaileysTimestamp(ts?: number | { low?: number; high?: number; unsigned?: boolean } | null): string {
  if (ts === null || ts === undefined) {
    return new Date().toISOString();
  }

  let epochMs: number;
  if (typeof ts === 'object' && 'low' in ts) {
    epochMs = Number(ts.low) * 1000;
  } else if (typeof ts === 'number') {
    epochMs = ts < 10000000000 ? ts * 1000 : ts;
  } else {
    epochMs = Number(ts) * 1000;
  }

  if (isNaN(epochMs) || epochMs <= 0) {
    return new Date().toISOString();
  }

  return new Date(epochMs).toISOString();
}
