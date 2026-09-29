import { db } from '../db/client';
import { getLatestMessageInfo, type MensajeInbound } from './ghl';
import type { GhlChannel } from '../types';

/**
 * Incorporación de mensajes entrantes desde GHL — el único punto por donde
 * entra lo que el cliente escribió (E144 de errores-bot).
 *
 * ## Por qué existe
 *
 * El webhook de GHL NO entrega todos los mensajes. Medido en Viking Food el 22
 * sep 2026: 25 entrantes en GHL, 20 webhooks, 5 perdidos (20%), y la regla fue
 * exacta: **todo lo perdido llegó dentro de 6 segundos del mensaje anterior**.
 * Es justo lo que alguien escribe después de "hola": qué quiere, para cuándo.
 * En Epazote se porta antes de conectar WhatsApp: con pauta llegan ráfagas
 * ("hola" + "mesa para 4 mañana a las 9") y el defecto es de la plataforma,
 * no del giro.
 *
 * ## La forma del arreglo
 *
 * No se le pide a GHL que entregue bien: se le pregunta qué tiene. El webhook
 * pasa de mensajero a timbre — solo dice "pasó algo con este contacto" — y lo
 * que pasó sale de la API. Tres puertas, las tres convergen aquí:
 *   - el webhook, cuando GHL sí avisa (`routes/webhook.ts`);
 *   - el inicio del turno, después del debounce (`workers/messageWorker.ts`);
 *   - el barrido de cada minuto, para cuando GHL no avisa de NADA
 *     (`workers/reconciliadorWorker.ts`).
 *
 * Es idempotente y seguro entre réplicas: quién procesa cada mensaje lo decide
 * el `INSERT ... ON CONFLICT DO NOTHING` sobre el id real de GHL.
 *
 * Portado de Viking Food, donde ya corre y recuperó 30 mensajes en su primer
 * día. Diferencia a propósito: este bot solo atiende los canales de
 * `CANALES_ATENDIDOS`. El barrido ve TODA la location, y sin ese filtro el bot
 * empezaría a contestar correos o mensajes de Facebook que hoy no contesta.
 */

/**
 * Los canales que este bot contesta: los que tienen workflow de webhook en GHL.
 * Hoy solo WhatsApp. Si algún día se conecta Facebook o Instagram, se agregan
 * aquí además de en GHL.
 */
export const CANALES_ATENDIDOS: ReadonlySet<GhlChannel> = new Set<GhlChannel>(['WhatsApp']);

/**
 * Cuánto hacia atrás se considera "nuevo". Acota que el primer barrido tras un
 * deploy no resucite conversaciones de ayer, y que un mensaje que GHL perdió
 * se recupere mientras todavía le sirve a el cliente.
 */
export const VENTANA_INCORPORACION_MS = 10 * 60 * 1000;

/**
 * Cuáles de los entrantes de GHL califican como "de ahora". Pura y exportada
 * para poder probarla: equivocarse por cualquiera de los dos lados se ve igual
 * de mal (resucitar la conversación de ayer, o dejar fuera lo que el cliente
 * está esperando que le contesten).
 */
export function candidatosParaIncorporar(
  inbound: MensajeInbound[],
  ahora: number = Date.now()
): MensajeInbound[] {
  const corte = ahora - VENTANA_INCORPORACION_MS;
  return inbound
    .filter((m) => {
      if (!CANALES_ATENDIDOS.has(m.channel)) return false;
      if (!m.body && !m.attachment) return false;
      const t = Date.parse(m.dateAdded);
      // Sin fecha utilizable no se sabe si es de ahora o de la semana pasada.
      // Se deja pasar: el id evita el duplicado, y callar es peor.
      return Number.isNaN(t) ? true : t >= corte;
    })
    // El orden en que el cliente escribió es el que el modelo necesita leer,
    // y el que deja alineados los marcadores de audio con sus adjuntos.
    .sort((a, b) => a.dateAdded.localeCompare(b.dateAdded));
}

/** Un texto que entró por el camino degradado del webhook, sin id de GHL. */
export interface TextoSinId {
  texto: string;
  /** ISO. Pasada `VENTANA_TEXTO_SIN_ID_MS` ya no descarta nada. */
  at: string;
}

export const VENTANA_TEXTO_SIN_ID_MS = 30 * 60 * 1000;

const normalizar = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * Quita los mensajes que YA entraron sin id por el camino degradado del webhook
 * (GHL no contestó y se usó el texto del payload). Compara SOLO contra esas
 * marcas, por texto IDÉNTICO, y cada marca descarta a lo más UN mensaje.
 *
 * Nunca contra el historial ni con `includes` (E161): en Viking Food eso tiraba
 * en silencio el mensaje que el cliente repetía porque no le contestaron, y
 * cualquier "sí" u "ok" cuya palabra ya hubiera salido antes.
 */
export function descartarYaConocidos(
  nuevos: MensajeInbound[],
  sinId: TextoSinId[],
  ahora: number = Date.now()
): { quedan: MensajeInbound[]; restantes: TextoSinId[] } {
  const vigentes = sinId.filter((e) => {
    const t = Date.parse(e.at);
    return typeof e.texto === 'string' && !Number.isNaN(t) && ahora - t < VENTANA_TEXTO_SIN_ID_MS;
  });
  const disponibles = [...vigentes];
  const quedan = nuevos.filter((m) => {
    if (!m.body) return true;
    const i = disponibles.findIndex((e) => normalizar(e.texto) === normalizar(m.body));
    if (i < 0) return true;
    disponibles.splice(i, 1); // cada marca se consume una sola vez
    return false;
  });
  return { quedan, restantes: disponibles };
}

/**
 * El marcador que le dice al modelo que hay algo que mirar. El de audio es el
 * que el worker sustituye por la transcripción, en orden.
 */
export function marcadorDeMedia(kind: string): string {
  switch (kind) {
    case 'image':
      return '[el contacto envió una imagen]';
    case 'pdf':
      return '[el contacto envió un PDF]';
    case 'audio':
      return '[el contacto envió un audio]';
    default:
      return '[el contacto envió un archivo]';
  }
}

/** El texto de UN mensaje como lo tiene que leer el modelo. */
export function textoDeMensaje(m: MensajeInbound): string {
  if (!m.attachment) return m.body;
  const marcador = marcadorDeMedia(m.attachment.kind);
  return m.body ? `${marcador}\n${m.body}` : marcador;
}

/**
 * Primer arranque con la tabla vacía (ver reconciliadorWorker.sembrarSiHaceFalta):
 * todo entrante anterior a este instante lo contestó el código viejo, que no
 * marcaba nada — incluido lo que le llegó al servicio viejo mientras el nuevo
 * arrancaba. Se marca como visto sin volver a contestarlo. 0 = no aplica.
 */
let contestadoPorElCodigoViejoHasta = 0;
export function marcarComoContestadoHasta(ms: number): void {
  contestadoPorElCodigoViejoHasta = ms;
}

export interface Incorporacion {
  canal: GhlChannel;
  incorporados: MensajeInbound[];
  /** El texto que se agregó al pending, ya con los marcadores de media. */
  texto: string;
}

async function textosSinId(contactId: string): Promise<TextoSinId[]> {
  const { rows } = await db.query(
    `SELECT COALESCE(metadata->'textos_sin_id', '[]'::jsonb) AS sin_id FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  const v = rows[0]?.sin_id;
  return Array.isArray(v) ? (v as TextoSinId[]) : [];
}

/**
 * Trae de GHL los entrantes que el bot todavía no tiene y los deja en el
 * pending del contacto.
 *
 * RELANZA si no se puede hablar con GHL: el que llama decide (el webhook cae
 * al texto de su payload; el barrido reintenta al minuto). Devolver vacío haría
 * creer que no había nada nuevo, que es la mentira que causa todo esto.
 */
export async function incorporarInboundNuevos(
  contactId: string,
  datos: { phone?: string | null; contactName?: string | null; channel?: GhlChannel } = {}
): Promise<Incorporacion> {
  const info = await getLatestMessageInfo(contactId);
  const canal = info?.channel ?? datos.channel ?? 'WhatsApp';
  const vacio: Incorporacion = { canal, incorporados: [], texto: '' };
  if (!info) return vacio;

  const candidatos = candidatosParaIncorporar(info.inbound);
  if (candidatos.length === 0) return vacio;

  // Claim atómico sobre el id REAL de GHL. Lo que devuelve el RETURNING es lo
  // que ganó este proceso; lo demás ya lo tiene alguien más.
  const { rows: ganadas } = await db.query(
    `INSERT INTO mensajes_incorporados (message_id, contact_id)
     SELECT id, $2 FROM UNNEST($1::text[]) AS id
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [candidatos.map((m) => m.id), contactId]
  );
  if (ganadas.length === 0) return vacio;

  const mias = new Set(ganadas.map((r) => r.message_id as string));
  let nuevos = candidatos.filter((m) => mias.has(m.id));

  if (contestadoPorElCodigoViejoHasta > 0) {
    // El id se queda marcado: ya está contestado, no debe volver a salir.
    const antes = nuevos.length;
    nuevos = nuevos.filter((m) => {
      const t = Date.parse(m.dateAdded);
      return Number.isNaN(t) || t >= contestadoPorElCodigoViejoHasta;
    });
    if (nuevos.length < antes) {
      console.log(
        `[inbound] ${antes - nuevos.length} de antes del deploy, ya contestados por el código viejo | contact=${contactId}`
      );
    }
  }

  const sinId = await textosSinId(contactId);
  if (sinId.length > 0) {
    const { quedan, restantes } = descartarYaConocidos(nuevos, sinId);
    if (quedan.length < nuevos.length) {
      console.log(
        `[inbound] ${nuevos.length - quedan.length} ya habían entrado sin id por el webhook | contact=${contactId}`
      );
    }
    nuevos = quedan;
    await db
      .query(
        `UPDATE conversations
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('textos_sin_id', $2::jsonb)
         WHERE contact_id = $1`,
        [contactId, JSON.stringify(restantes)]
      )
      .catch(() => {});
  }
  if (nuevos.length === 0) return vacio;

  const texto = nuevos.map(textoDeMensaje).join('\n');
  const adjuntos = nuevos
    .filter((m) => m.attachment)
    .map((m) => ({ url: m.attachment!.url, kind: m.attachment!.kind }));

  try {
    await db.query(
      `INSERT INTO conversations (contact_id, phone, contact_name, messages, metadata, pending_message, pending_at, pending_attachments)
       VALUES ($1, $2, $3, '[]'::jsonb, jsonb_build_object('channel', $6::text), $4, now(), COALESCE($5::jsonb, '[]'::jsonb))
       ON CONFLICT (contact_id)
       DO UPDATE SET
         pending_message = CASE
           WHEN conversations.pending_message IS NULL OR conversations.pending_message = ''
             THEN $4
           ELSE conversations.pending_message || E'\\n' || $4
         END,
         -- Deduplica por URL: no mandar la misma imagen dos veces a Vision.
         pending_attachments = (
           SELECT COALESCE(jsonb_agg(DISTINCT a), '[]'::jsonb)
             FROM jsonb_array_elements(
                    COALESCE(conversations.pending_attachments, '[]'::jsonb)
                    || COALESCE($5::jsonb, '[]'::jsonb)
                  ) AS a
         ),
         metadata = COALESCE(conversations.metadata, '{}'::jsonb) || jsonb_build_object('channel', $6::text),
         pending_at = now(),
         last_activity = now()`,
      [
        contactId,
        datos.phone ?? '',
        datos.contactName ?? null,
        texto,
        adjuntos.length ? JSON.stringify(adjuntos) : null,
        canal,
      ]
    );
  } catch (err) {
    // Se sueltan los ids para que el siguiente intento SÍ los tome. Dejarlos
    // marcados convertiría un hipo de Postgres en mensajes perdidos para siempre.
    await db
      .query('DELETE FROM mensajes_incorporados WHERE message_id = ANY($1::text[])', [
        nuevos.map((m) => m.id),
      ])
      .catch((e) => console.error(`[inbound] no se pudieron soltar los ids: ${(e as Error).message}`));
    throw err;
  }

  return { canal, incorporados: nuevos, texto };
}

/**
 * Marca como ya incorporados, SIN encolar nada, los entrantes recientes de
 * estos contactos. Solo para el primer arranque con la tabla vacía (ver
 * reconciliadorWorker): lo de antes del deploy ya lo contestó el código viejo,
 * y sin esto el primer barrido se lo volvería a contestar a el cliente.
 */
export async function marcarComoYaIncorporados(contactId: string): Promise<number> {
  const info = await getLatestMessageInfo(contactId);
  if (!info) return 0;
  const candidatos = candidatosParaIncorporar(info.inbound);
  if (candidatos.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO mensajes_incorporados (message_id, contact_id)
     SELECT id, $2 FROM UNNEST($1::text[]) AS id
     ON CONFLICT (message_id) DO NOTHING`,
    [candidatos.map((m) => m.id), contactId]
  );
  return rowCount ?? 0;
}
