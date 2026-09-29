import PgBoss from 'pg-boss';
import { MessageJobData } from './types';
import { getConfig } from './config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const QUEUE_NAME = 'messages';

/**
 * Encola un mensaje con debounce por contacto.
 * singletonKey garantiza un solo job pendiente por contacto, así
 * cuando alguien manda 5 mensajes seguidos solo se procesa una vez.
 *
 * El debounce se lee de configuracion/bot.config.yaml en cada llamada para
 * que cambios al yaml apliquen sin reiniciar (getConfig cachea la primera
 * lectura, así que el costo es trivial).
 */
export async function enqueueMessage(data: MessageJobData): Promise<string | null> {
  const debounceSeconds = getConfig().behavior.message_debounce_seconds;

  const id = await boss.send(
    QUEUE_NAME,
    {
      contactId: data.contactId,
      phone: data.phone,
      contactName: data.contactName,
      message: data.message,
      channel: data.channel,
    },
    {
      singletonKey: data.contactId,
      startAfter: debounceSeconds,
      // Reintentos moderados con backoff (10s, 20s, 40s). Muchos reintentos
      // agresivos amplifican el volumen contra el edge de Anthropic y pueden
      // disparar rate-limiting de la IP de salida del hosting.
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
    }
  );

  // `null` = no se encoló porque ya hay un job de este contacto encolado o
  // CORRIENDO (el singletonKey de pg-boss cubre los dos). Si está encolado no
  // pasa nada: agarra el pendiente. Si está corriendo, el worker ya vació la
  // columna de pendientes y no la vuelve a mirar: el mensaje se quedaba sin
  // contestar hasta que el paciente escribiera otra vez (E150). Lo levanta el
  // barredor de pendientes (ver barrerPendientes); este WARN es para que deje
  // de ser invisible.
  if (!id) {
    console.warn(`[queue] no se encoló (ya hay un turno de este contacto) — lo levanta el barredor | contact=${data.contactId}`);
  }
  return id;
}

/**
 * Re-encola los mensajes que quedaron pendientes sin job que los atienda.
 *
 * Pasa cuando el mensaje llega mientras el bot está generando la respuesta
 * anterior (ver enqueueMessage), cuando el proceso murió a media respuesta o
 * cuando el job agotó sus reintentos. Corre por fuera del worker a propósito:
 * desde dentro, el propio job activo vuelve a bloquear el encolado.
 *
 * Con cota superior de 6 horas: contestar un mensaje de hace días como si
 * acabara de llegar es peor que no contestarlo.
 */
export async function barrerPendientes(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
): Promise<void> {
  try {
    const r = await query(
      `SELECT c.contact_id, c.phone, c.contact_name, c.pending_message, c.metadata->>'channel' AS channel
         FROM conversations c
        WHERE c.pending_message IS NOT NULL AND c.pending_message <> ''
          AND c.pending_at < now() - interval '90 seconds'
          AND c.pending_at > now() - interval '6 hours'
          AND NOT EXISTS (
            SELECT 1 FROM pgboss.job j
             WHERE j.name = $1 AND j.singletonkey = c.contact_id
               AND j.state IN ('created', 'retry', 'active')
          )
        LIMIT 20`,
      [QUEUE_NAME]
    );
    for (const row of r.rows) {
      console.warn(`[barredor] mensaje pendiente sin turno — se re-encola | contact=${row.contact_id}`);
      await enqueueMessage({
        contactId: String(row.contact_id),
        phone: String(row.phone ?? ''),
        contactName: (row.contact_name as string | null) ?? null,
        message: String(row.pending_message ?? ''),
        channel: ((row.channel as MessageJobData['channel']) ?? 'WhatsApp'),
      });
    }
  } catch (err) {
    console.warn(`[barredor] falló: ${(err as Error).message}`);
  }
}

export { QUEUE_NAME };
