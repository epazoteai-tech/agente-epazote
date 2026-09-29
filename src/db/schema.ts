export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  contact_name TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  pending_message TEXT,
  pending_at TIMESTAMPTZ,
  pending_attachments JSONB DEFAULT '[]'::jsonb,
  last_activity TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_activity ON conversations(last_activity DESC);

-- Tracking de follow-ups (mensajes proactivos cuando el lead no responde)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_bot_message_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_ups_sent INT NOT NULL DEFAULT 0;

-- Lista negra + loop-guard (ver src/blocklist.ts y src/loop-guard.ts).
-- blocked_at != NULL  → el bot ignora por completo a este contacto.
-- turn_count          → turnos de la ráfaga actual (se reinicia tras una pausa larga).
-- fast_replies        → racha de respuestas con cadencia de máquina.
-- fast_reply_marker   → contra qué mensaje del bot ya se midió la cadencia,
--                       para no contar dos veces la misma ráfaga del contacto.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS turn_count INT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS fast_replies INT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS fast_reply_marker TIMESTAMPTZ;
`;
