/**
 * ¿Hay una persona del consultorio atendiendo esta conversación ahorita?
 *
 * Antes el bot contestaba siempre: después de escalar, y encima de quien del
 * equipo se pusiera a escribir en GHL (E44/E85/E134). Hoy nadie de la clínica
 * contesta desde GHL (0 mensajes a mano en 60 conversaciones, auditoría del
 * 23/09/2026), así que no se veía — pero el día que el doctor o su asistente
 * respondan ahí, el bot les hablaría encima.
 *
 * NO se decide con el tag de escalación: ese tag es permanente y el bot escala
 * en caminos frecuentes (cada comprobante de pago), así que callar por el tag
 * dejaría mudo al bot para todo paciente que alguna vez pagó. La señal que
 * caduca sola es "el último mensaje escrito A MANO es de hace poco".
 *
 * Cómo se distingue un mensaje escrito a mano: los que manda el bot salen por
 * la app de marketplace y traen `meta.marketplace.appId`; los escritos en la UI
 * de GHL no. Ese campo no está documentado, así que además se compara el texto
 * contra lo que el bot tiene guardado como propio: cuenta como humano solo si
 * falla por los dos lados.
 */

import { ChatMessage } from '../types';
import { getConversationMessages } from './ghl';
import { fechaGhlAMs } from '../fechas';

/** Minutos que el bot se calla después del último mensaje escrito por una persona. */
export const VENTANA_HUMANO_MIN = 120;

export const PREFIJO_HUMANO = '[Escrito a mano por una persona del equipo]: ';

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[*_¿¡]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Segundos máximos entre un mensaje del cliente y una respuesta que NO puede
 * haber escrito una persona. El saludo automático de WhatsApp Business (con el
 * número en coexistencia) sale en el MISMO segundo que el "hola" del cliente.
 */
export const SEGUNDOS_RESPUESTA_AUTOMATICA = 4;

/**
 * ¿Este saliente es una respuesta automática del celular (saludo o ausencia de
 * WhatsApp Business) y no una persona escribiendo?
 *
 * Caso real, Epazote 01/10/2026 7:51: el saludo "Epazote cocina de origen…"
 * salió en el mismo segundo que el "Buen día" del cliente. Como no trae
 * marketplace.appId, contaba como persona del equipo y el bot se calló 2 horas;
 * el cliente pidió reserva, nadie le contestó en 8 horas y se fue a otro
 * restaurante. Nadie escribe a mano una respuesta en 4 segundos.
 */
export function esRespuestaAutomatica(salienteMs: number, entrantesMs: number[]): boolean {
  return entrantesMs.some((e) => salienteMs >= e && salienteMs - e <= SEGUNDOS_RESPUESTA_AUTOMATICA * 1000);
}

export interface MensajeDePersona {
  texto: string;
  ts: string;
}

/**
 * Mensajes escritos a mano por el equipo en los últimos VENTANA_HUMANO_MIN
 * minutos, del más viejo al más nuevo. LANZA si GHL no responde: el worker de
 * mensajes falla ABIERTO (contesta) y el de follow-ups falla CERRADO (no manda).
 */
export async function mensajesDePersona(
  contactId: string,
  history: ChatMessage[],
  tz: string
): Promise<MensajeDePersona[]> {
  const desde = Date.now() - VENTANA_HUMANO_MIN * 60 * 1000;
  const delBot = history
    .filter((m) => m.role === 'assistant' && m.origen !== 'humano')
    .map((m) => norm(m.content));

  const msgs = await getConversationMessages(contactId, 30);
  const entrantes = msgs
    .filter((m) => m.direction === 'inbound')
    .map((m) => fechaGhlAMs(m.dateAdded, tz))
    .filter((t) => !isNaN(t));
  return msgs
    .filter((m) => {
      if (m.direction !== 'outbound') return false;
      if (!m.messageType || m.messageType.startsWith('TYPE_ACTIVITY')) return false;
      if (m.meta?.marketplace?.appId) return false;
      const body = (m.body ?? '').trim();
      if (!body) return false;
      const t = fechaGhlAMs(m.dateAdded, tz);
      if (isNaN(t) || t < desde) return false;
      if (esRespuestaAutomatica(t, entrantes)) return false;
      const n = norm(body);
      // El bot parte sus respuestas en burbujas: cada burbuja es un pedazo de
      // un mensaje guardado completo.
      return !delBot.some((b) => b.includes(n));
    })
    .map((m) => ({
      texto: (m.body ?? '').trim(),
      ts: new Date(fechaGhlAMs(m.dateAdded, tz)).toISOString(),
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Los que todavía no están guardados en el historial (para no duplicarlos). */
export function nuevosParaHistorial(
  humanos: MensajeDePersona[],
  history: ChatMessage[]
): ChatMessage[] {
  const yaGuardados = new Set(
    history
      .filter((m) => m.origen === 'humano')
      .map((m) => norm(m.content.replace(PREFIJO_HUMANO, '')))
  );
  return humanos
    .filter((h) => !yaGuardados.has(norm(h.texto)))
    .map((h) => ({
      role: 'assistant' as const,
      content: `${PREFIJO_HUMANO}${h.texto}`,
      ts: h.ts,
      origen: 'humano' as const,
    }));
}
