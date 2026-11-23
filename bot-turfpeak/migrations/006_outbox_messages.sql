-- Migration 006: Outbox Messages Table for Asynchronous Outbound Broadcasts
CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SENT', 'FAILED')),
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_messages_status ON outbox_messages (status, created_at);
