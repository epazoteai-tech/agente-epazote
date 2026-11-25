/**
 * IDs de GHL de los mensajes que mandó el bot, por contacto (en
 * conversations.metadata.enviados_bot).
 *
 * Para qué: la revisión de "una persona está atendiendo" (atencion-humana.ts)
 * reconocía los mensajes del bot por `meta.marketplace.appId` o por el texto
 * guardado en el historial. El 24/11/2026 GHL regresó la lista sin `meta` en
 * la mitad de las consultas, y las fotos de posadas con su pie (que no van al
 * historial) contaron como escritas por una persona: el bot se calló 2 horas.
 * El id que GHL da al mandar no depende de ninguna de las dos cosas.
 */

import { db } from '../db/client';

/** Cuántos ids se guardan por contacto (de sobra para la ventana de 2 h). */
const MAX_IDS = 80;

export async function registrarEnviado(contactId: string, messageId: string | null): Promise<void> {
  if (!messageId) return;
  try {
    await db.query(
      `UPDATE conversations
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'enviados_bot',
         (SELECT COALESCE(jsonb_agg(x ORDER BY n), '[]'::jsonb)
            FROM (SELECT x, n FROM jsonb_array_elements(
                    COALESCE(metadata->'enviados_bot', '[]'::jsonb) || to_jsonb($2::text)
                  ) WITH ORDINALITY AS e(x, n)
                  ORDER BY n DESC LIMIT ${MAX_IDS}) ultimos))
       WHERE contact_id = $1`,
      [contactId, messageId]
    );
  } catch (e) {
    console.warn(`[enviados] no se pudo guardar el id | contact=${contactId}: ${(e as Error).message}`);
  }
}

/** Ids guardados del contacto. Vacío si la base no responde (no bloquea nada). */
export async function idsEnviados(contactId: string): Promise<Set<string>> {
  try {
    const r = await db.query(`SELECT metadata->'enviados_bot' AS ids FROM conversations WHERE contact_id = $1`, [contactId]);
    const ids = r.rows[0]?.ids;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}
