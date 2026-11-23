/**
 * Flash Peak TMS - CLI Announcement Dispatcher
 *
 * Enqueues an announcement into the outbox_messages table.
 * The running bot process picks it up and sends it to the central tournament group
 * via WhatsApp using its authoritative session.
 *
 * Usage:
 *   npx tsx src/cli/announce.ts "Isi pesan pengumuman..."
 *   npx tsx src/cli/announce.ts --chat "120363412423738009@g.us" "Isi pesan..."
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

async function main() {
  const args = process.argv.slice(2);
  let chatId = process.env.WA_CENTRAL_GROUP_JID || '120363412423738009@g.us';
  let messageText = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chat' && args[i + 1]) {
      chatId = args[i + 1];
      i++;
    } else {
      messageText = messageText ? `${messageText} ${args[i]}` : args[i];
    }
  }

  if (!messageText) {
    console.error('Usage: tsx src/cli/announce.ts [--chat <chatId>] "<messageText>"');
    process.exit(1);
  }

  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const dbToken = process.env.TURSO_AUTH_TOKEN;
  const db = createClient({
    url: dbUrl,
    authToken: dbToken,
  });

  const id = randomUUID();
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO outbox_messages (id, chat_id, message_text, status, created_at)
          VALUES (?, ?, ?, 'PENDING', ?)`,
    args: [id, chatId, messageText, now],
  });

  console.log(`✅ Announcement queued in outbox (ID: ${id}) for chat ${chatId}.`);
  console.log(`The running bot will deliver this message within seconds.`);
  db.close();
}

main().catch((err) => {
  console.error('[Announce Error]', err);
  process.exit(1);
});
