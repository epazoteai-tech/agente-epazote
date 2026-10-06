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

-- Qué mensajes de GHL ya entraron a la conversación, por su id real (E144).
-- Es lo que deja que el webhook, el inicio del turno y el barrido de cada
-- minuto pregunten a GHL sin pisarse. Si esta tabla se queda VACÍA con tráfico,
-- la deduplicación está apagada (E145): hay que contar sus filas, no leer logs.
CREATE TABLE IF NOT EXISTS mensajes_incorporados (
  message_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  recibido_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mensajes_incorporados_recibido
  ON mensajes_incorporados(recibido_at);
-- La ventana de incorporación es de 10 minutos: una semana sobra.
DELETE FROM mensajes_incorporados WHERE recibido_at < now() - INTERVAL '7 days';

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

-- ===========================================================================
-- MESA DE CONTROL (fase 1, 30/09/2026)
-- ---------------------------------------------------------------------------
-- La cadena que cierra el embudo de Epazote: origen de campaña → solicitud
-- (la registra el bot) → confirmada → llegó / no llegó → consumo. Vive en la
-- misma base del bot a propósito (patrón del KDS de Viking Food): las reservas
-- del bot ya nacen aquí, sin webhook entre sistemas. Si Epazote compra el
-- producto y crece, se migra.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS reservas (
  id BIGSERIAL PRIMARY KEY,
  -- NULL en walk-ins y reservas por teléfono capturadas a mano.
  contact_id TEXT,
  nombre TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  fecha DATE NOT NULL,
  hora TEXT NOT NULL,                      -- "HH:MM", hora de pared del restaurante
  personas INT NOT NULL CHECK (personas > 0),
  ocasion TEXT NOT NULL DEFAULT '',
  turno TEXT NOT NULL DEFAULT '',
  -- Texto crudo con el que abrió la conversación (el precargado del wa.link).
  origen_mensaje TEXT NOT NULL DEFAULT '',
  canal TEXT NOT NULL DEFAULT 'bot' CHECK (canal IN ('bot', 'telefono', 'walk-in')),
  como_se_entero TEXT CHECK (como_se_entero IN ('redes_anuncio', 'recomendacion', 'ya_conocia', 'pasaba_por_aqui')),
  estado TEXT NOT NULL DEFAULT 'solicitada'
    CHECK (estado IN ('solicitada', 'confirmada', 'llego', 'no_llego', 'cancelada')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmada_at TIMESTAMPTZ,
  llegada_at TIMESTAMPTZ,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha, hora);
-- Atribución del anuncio Click-to-WhatsApp (lastAttributionSource del contacto
-- en GHL): ctwa_clid identifica el clic exacto; con él el Purchase a Meta se
-- atribuye al anuncio y no solo por teléfono (services/capi.ts).
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS ad_id TEXT;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS ad_name TEXT;
CREATE INDEX IF NOT EXISTS idx_reservas_contacto ON reservas(contact_id, fecha);
-- Solicitudes que el bot escaló a una persona (grupo grande, evento, reserva
-- que no se pudo registrar): entran a la Mesa con lo que el cliente alcanzó a
-- dar. Por eso fecha, hora y personas pueden venir vacías; el host las
-- completa antes de confirmar (la ruta de estado lo exige).
ALTER TABLE reservas ALTER COLUMN fecha DROP NOT NULL;
ALTER TABLE reservas ALTER COLUMN hora DROP NOT NULL;
ALTER TABLE reservas ALTER COLUMN personas DROP NOT NULL;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS escalada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS motivo_escalacion TEXT;

-- Lo que consumió la mesa. Fase 1: total capturado a mano. Fase 2: foto del
-- ticket leída con Vision (foto_url, parse_json) y evento Purchase a Meta
-- (capi_*). Una sola fila por reserva: cerrar la mesa otra vez la corrige.
CREATE TABLE IF NOT EXISTS consumos (
  id BIGSERIAL PRIMARY KEY,
  reserva_id BIGINT REFERENCES reservas(id) ON DELETE SET NULL,
  total NUMERIC(10, 2) NOT NULL CHECK (total >= 0),
  turno TEXT NOT NULL DEFAULT '',
  metodo TEXT NOT NULL DEFAULT 'manual' CHECK (metodo IN ('manual', 'foto')),
  foto_url TEXT,
  parse_json JSONB,
  capi_enviado_at TIMESTAMPTZ,
  capi_respuesta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumos_reserva ON consumos(reserva_id) WHERE reserva_id IS NOT NULL;
-- Reintentos del Purchase a Meta (services/capi.ts): tope para no martillar.
ALTER TABLE consumos ADD COLUMN IF NOT EXISTS capi_intentos INT NOT NULL DEFAULT 0;

-- Campañas: cada creativo con su wa.link trae un mensaje precargado distinto.
-- palabra_clave es un pedazo de ese texto ("cabrito", "machacado"): la
-- reserva cuyo origen la contenga se atribuye a esa campaña. El gasto se
-- captura a mano por ahora (v2: del MCP de Meta).
CREATE TABLE IF NOT EXISTS campanas (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  palabra_clave TEXT NOT NULL,
  gasto_mensual NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (gasto_mensual >= 0),
  activa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Freno de fuerza bruta del PIN de la Mesa de Control, compartido entre
-- instancias (E71 de errores-bot; portado del KDS de Viking Food). Solo se
-- escribe cuando alguien falla el PIN: el camino feliz no consulta nada.
CREATE TABLE IF NOT EXISTS mesa_intentos (
  llave TEXT PRIMARY KEY,
  fallos INT NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DELETE FROM mesa_intentos WHERE actualizado_at < now() - INTERVAL '1 day';
`;
