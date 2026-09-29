/**
 * Worker que procesa los jobs de follow-up y de marca-lead-perdido.
 *
 * Cada job verifica que sigue siendo válido antes de ejecutar:
 *   - El cliente NO respondió desde que se programó.
 *   - El bot NO escribió un mensaje más nuevo (que disparó nuevos follow-ups).
 *   - Si hay `entry_stage` configurada: la opportunity sigue en esa etapa
 *     (no agendó, no escaló, no avanzó).
 *   - Estamos dentro de la ventana 24h de WhatsApp.
 *   - Estamos dentro del horario de envío (sino, se re-programa).
 *
 * El texto de cada follow-up se GENERA con Claude, dándole la conversación
 * real como contexto — así retoma exactamente lo que quedó pendiente (un
 * dato que faltaba, un horario sin confirmar) en vez de un mensaje genérico.
 * Si esa llamada falla, se usa como respaldo el mensaje PREDEFINIDO de
 * `follow_ups.messages` en bot.config.yaml (uno por intento de la cadencia,
 * soporta `{nombre}`).
 */

import { boss } from '../queue';
import { db } from '../db/client';
import { ChatMessage, GhlChannel } from '../types';
import { findContactOpportunity, moveOpportunityToStage, sendMessage } from '../services/ghl';
import { generateFollowUpMessage, normalizeWhatsAppFormat } from '../services/claude';
import { contactoBloqueadoAsync } from '../blocklist';
import { pareceNombreReal } from '../nombres';
import { mensajesDePersona } from '../services/atencion-humana';
import { zonaDelNegocio } from '../services/ghl-calendar';
import { getConfig } from '../config';
import {
  FOLLOW_UP_QUEUE,
  MARK_LOST_QUEUE,
  HOUR_MS,
  clampToWindow,
  cancelarFollowUpsPendientes,
} from '../services/follow-up';

/** Sentinel que Claude devuelve cuando detecta que el contacto no es un
 * cliente/paciente real (proveedor, spam, número equivocado) — ver el
 * prompt en generateFollowUpMessage (services/claude.ts). Sin esto, el
 * modelo generaba su propio análisis ("esto no es un cliente, no hay
 * seguimiento que hacer") y el código lo mandaba tal cual por WhatsApp. */
const NO_FOLLOW_UP_SENTINEL = 'NO_FOLLOW_UP';

interface FollowUpJobData {
  contactId: string;
  attempt: number;
  scheduledAt: number;
}

interface MarkLostJobData {
  contactId: string;
  scheduledAt: number;
}

/** Devuelve la hora actual en la timezone configurada como número (0-23). */
function nowHourInZone(tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10) % 24;
}

/**
 * Si estamos fuera del horario de envío, re-programa el mismo job al próximo
 * inicio de ventana y devuelve true (caller debería terminar sin enviar).
 */
async function deferIfOutOfWindow(
  queueName: string,
  data: FollowUpJobData | MarkLostJobData,
  contactId: string
): Promise<boolean> {
  const fu = getConfig().follow_ups;
  if (!fu) return false;

  const h = nowHourInZone(fu.timezone);
  if (h >= fu.window_start_hour && h < fu.window_end_hour) return false;

  const nextSlot = clampToWindow(Date.now() + 5 * 60 * 1000);
  await boss.send(queueName, data, {
    singletonKey: `${contactId}:defer:${data.scheduledAt}:${Date.now()}`,
    startAfter: new Date(nextSlot),
  });
  console.log(`[follow-up] fuera de ventana, re-programado a ${new Date(nextSlot).toISOString()} | contact=${contactId} queue=${queueName}`);
  return true;
}

/**
 * Renderiza el texto predefinido del follow-up. Soporta el placeholder
 * `{nombre}`: se reemplaza con el primer nombre del contacto, o se elimina
 * (limpiando espacios dobles) si no lo conocemos.
 */
export function renderFollowUpMessage(template: string, contactName: string | null): string {
  const primero = (contactName ?? '').trim().split(/\s+/)[0] ?? '';
  // `contact_name` viene del perfil de WhatsApp, así que puede ser cualquier
  // cosa (emojis, símbolos). Si no parece un nombre, mejor no saludar por
  // nombre que mandar "Hola 💤💤💤🩵🩵".
  const firstName = pareceNombreReal(primero) ? primero : '';
  let text = template.replace(/\{nombre\}/gi, firstName);
  if (!firstName) {
    // Sin nombre quedan huecos tipo "Hola , ..." — los limpiamos.
    text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
  }
  return text.trim();
}

/**
 * Resuelve el ID de una etapa del pipeline configurado a partir de su nombre.
 * Devuelve null si no hay pipeline o la etapa no está en bot.config.yaml.
 */
function stageIdByName(stageName: string): string | null {
  const cfg = getConfig();
  if (!cfg.pipeline) return null;
  return cfg.pipeline.stages.find((s) => s.name === stageName)?.id ?? null;
}

/**
 * Si hay `entry_stage` configurada, verifica que la opportunity del contacto
 * siga en esa etapa. Devuelve false cuando la opp ya avanzó (se agendó,
 * escaló, etc.) → el follow-up/mark-lost debe saltarse.
 */
async function stillInEntryStage(contactId: string): Promise<boolean> {
  const cfg = getConfig();
  const fu = cfg.follow_ups;
  if (!fu?.entry_stage || !cfg.pipeline) return true;

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return true;

  const entryId = stageIdByName(fu.entry_stage);
  if (!entryId) {
    console.warn(`[follow-up] entry_stage "${fu.entry_stage}" no está en pipeline.stages del yaml`);
    return true;
  }

  const opps = await findContactOpportunity(contactId, cfg.pipeline.id, locationId);
  const opp = opps[0];
  if (!opp) return true; // sin opportunity no hay señal — dejamos pasar

  if (opp.pipelineStageId !== entryId) {
    console.log(`[follow-up] opp ya está en otra etapa | contact=${contactId} stage=${opp.pipelineStageId.slice(0, 8)}`);
    return false;
  }
  return true;
}

/**
 * Las etapas marcadas "AUTO:" en el yaml son las que mueve el CÓDIGO, no el
 * modelo: cita agendada, escalado a humano y "No contestó". Estar en una de
 * ellas significa que el ciclo ya cerró.
 *
 * Se comprueba contra el estado VIVO de GHL y no contra las tools del turno,
 * porque estos jobs nacieron horas antes y el contacto pudo cerrar en medio —
 * o alguien del equipo pudo moverlo a mano en GHL, que es el caso que las
 * tools del turno nunca ven.
 *
 * Vive en un solo lugar a propósito: la usan el follow-up y el marca-perdido,
 * y dos copias de la misma regla siempre terminan divergiendo.
 *
 * Devuelve el NOMBRE de la etapa de cierre, o null si la opp sigue abierta.
 */
function etapaDeCierrePorId(stageId: string): string | null {
  const cfg = getConfig();
  if (!cfg.pipeline) return null;
  const etapa = cfg.pipeline.stages.find((s) => s.id === stageId);
  if (!etapa) return null;
  return (etapa.when ?? '').trim().toUpperCase().startsWith('AUTO:') ? etapa.name : null;
}

/** Igual que la anterior, pero resolviendo la opportunity del contacto. */
async function etapaDeCierre(contactId: string): Promise<string | null> {
  const cfg = getConfig();
  const locationId = process.env.GHL_LOCATION_ID;
  if (!cfg.pipeline || !locationId) return null;
  try {
    const opps = await findContactOpportunity(contactId, cfg.pipeline.id, locationId);
    if (opps.length === 0) return null;
    return etapaDeCierrePorId(opps[0].pipelineStageId);
  } catch (e) {
    // Sin señal de GHL preferimos NO suprimir: dejar de mandar un follow-up
    // legítimo cuesta más que mandar uno de más.
    console.warn(`[follow-up] check de etapa falló: ${(e as Error).message}`);
    return null;
  }
}

async function handleFollowUp(data: FollowUpJobData): Promise<void> {
  const { contactId, attempt, scheduledAt } = data;
  const fu = getConfig().follow_ups;
  if (!fu) return;

  console.log(`[follow-up] fired | contact=${contactId} attempt=${attempt}`);

  // Blocklist: jamás un proactivo a un contacto bloqueado (ver src/blocklist.ts).
  if (await contactoBloqueadoAsync(contactId)) {
    console.log(`[follow-up] bloqueado — contacto en blocklist | contact=${contactId}`);
    await cancelarFollowUpsPendientes(contactId).catch(() => {});
    return;
  }

  // 1. Re-programar si estamos fuera de ventana
  if (await deferIfOutOfWindow(FOLLOW_UP_QUEUE, data, contactId)) return;

  // 2. Cargar conversación
  const r = await db.query(
    `SELECT messages, metadata, contact_name, follow_ups_sent, last_bot_message_at FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  if (r.rows.length === 0) {
    console.log(`[follow-up] sin conversación | contact=${contactId}`);
    return;
  }
  const { messages, metadata, contact_name, follow_ups_sent, last_bot_message_at } = r.rows[0];
  const history: ChatMessage[] = messages || [];

  // 3. Si el bot escribió DESPUÉS de programar este job, esta cadencia está stale
  const lastBotMs = last_bot_message_at ? new Date(last_bot_message_at).getTime() : 0;
  if (lastBotMs > scheduledAt + 60_000) {
    console.log(`[follow-up] stale (bot reescribió) | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 4. Si el cliente respondió desde scheduledAt, no hace falta el follow-up
  const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
  const lastUserMs = lastUserMsg ? new Date(lastUserMsg.ts).getTime() : 0;
  if (lastUserMs > scheduledAt) {
    console.log(`[follow-up] cliente respondió | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 5. Idempotencia: si ya enviamos un follow-up >= attempt, skip
  if ((follow_ups_sent ?? 0) >= attempt) {
    console.log(`[follow-up] ya enviado attempt=${attempt} | contact=${contactId}`);
    return;
  }

  // 6. Ventana WhatsApp 24h desde último mensaje del cliente
  const horasDesdeCliente = (Date.now() - lastUserMs) / HOUR_MS;
  if (horasDesdeCliente >= 23) {
    console.log(`[follow-up] fuera de ventana WhatsApp 24h (${horasDesdeCliente.toFixed(1)}h) | contact=${contactId}`);
    return;
  }

  // 7. Skip si la opportunity ya avanzó de etapa (agendó / escaló / etc.)
  if (!(await stillInEntryStage(contactId))) return;

  // 7b. Y skip si el ciclo ya cerró en GHL. El stale check del paso 3 cubre el
  // caso normal (el contacto cerró conversando, así que el bot volvió a
  // contestar y la cadencia vieja quedó obsoleta), pero NO cubre que alguien
  // del equipo mueva la tarjeta a mano en GHL: ahí no hay mensaje del bot que
  // invalide nada, y el follow-up le llegaría a quien ya tiene su cita.
  const cerradaEn = await etapaDeCierre(contactId);
  if (cerradaEn) {
    console.log(`[follow-up] ciclo ya cerrado en "${cerradaEn}", skip | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 7c. El contacto dijo que no ("no gracias") y no ha vuelto a pedir horarios (E137).
  if ((metadata as { declino_at?: string | null } | null)?.declino_at) {
    console.log(`[follow-up] el contacto declinó, skip | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 7d. Una persona del consultorio está atendiendo: el follow-up no sale
  // encima de ella. El corte de "persona atendiendo" vive en el worker de
  // mensajes, y un follow-up sale SIN que el contacto escriba, así que nunca
  // pasaba por ahí (E89). Falla CERRADO: si no se puede leer GHL, no se manda
  // — perder un recordatorio cuesta menos que escribirle encima a quien lo
  // está atendiendo.
  try {
    const humanos = await mensajesDePersona(contactId, history, zonaDelNegocio());
    if (humanos.length > 0) {
      console.log(`[follow-up] una persona está atendiendo, skip | contact=${contactId} attempt=${attempt}`);
      return;
    }
  } catch (e) {
    console.warn(`[follow-up] no se pudo revisar si atiende una persona — no se manda: ${(e as Error).message}`);
    return;
  }

  // 8. Generar el mensaje CONTEXTUAL con Claude (retoma lo que quedó
  // pendiente en la conversación real) — si falla, usa el predefinido del
  // yaml como respaldo, para nunca dejar de mandar el follow-up.
  const template = fu.messages[attempt - 1];
  if (!template) {
    console.warn(`[follow-up] no hay mensaje definido para attempt=${attempt} | contact=${contactId}`);
    return;
  }

  let text: string;
  try {
    const horasDesdeClienteReal = (Date.now() - lastUserMs) / HOUR_MS;
    text = await generateFollowUpMessage(history, attempt, fu.cadence_hours.length, horasDesdeClienteReal);
    if (!text) throw new Error('respuesta vacía');
    console.log(`[follow-up] generado contextual | contact=${contactId} attempt=${attempt}`);
  } catch (e) {
    console.warn(`[follow-up] generación contextual falló, uso respaldo del yaml: ${(e as Error).message}`);
    text = renderFollowUpMessage(template, contact_name ?? null);
  }

  if (text.trim() === NO_FOLLOW_UP_SENTINEL) {
    console.log(`[follow-up] contacto no parece ser un cliente real, se cancela el seguimiento | contact=${contactId}`);
    await cancelarFollowUpsPendientes(contactId);
    return;
  }

  if (!text) {
    console.log(`[follow-up] mensaje quedó vacío | contact=${contactId}`);
    return;
  }

  const channel: GhlChannel =
    ((metadata as { channel?: string } | null)?.channel as GhlChannel | undefined) ?? 'WhatsApp';

  // normalizeWhatsAppFormat: esta ruta mandaba el texto crudo, así que el
  // markdown del modelo (**negrita**) le llegaba literal al contacto.
  await sendMessage(contactId, normalizeWhatsAppFormat(text), channel);

  // 9. Persistir: append al historial + incrementar contador.
  //
  // OJO: aquí NO se toca `last_bot_message_at`, y es la línea que arregla el
  // bug. Esa columna significa "la última vez que el bot le CONTESTÓ a un
  // mensaje del cliente" — es la señal que usan los stale checks (paso 3 aquí
  // y paso 2 de handleMarkLost) para saber que arrancó una cadencia nueva y
  // que la vieja ya no aplica.
  //
  // Cuando este worker la pisaba al mandar un follow-up, el bot se marcaba a
  // sí mismo como conversación reactivada: los jobs restantes de SU PROPIA
  // tanda (el follow-up 2 y el de marca-perdido, que nacieron con el mismo
  // `scheduledAt`) se encontraban un `lastBotMs` más nuevo y se daban por
  // obsoletos. Efecto real en producción: solo salía el primer follow-up y
  // NADIE llegaba nunca a la etapa "No contestó", sin un solo error en los
  // logs porque el bot hacía bien todo lo demás.
  //
  // El caso legítimo que el stale check sí tiene que atrapar —que el cliente
  // haya vuelto a escribir— ya lo cubre el paso 4 contra el historial real,
  // así que no se pierde nada al dejar de pisarla aquí.
  const now = new Date().toISOString();
  const newMessages = [...history, { role: 'assistant' as const, content: text, ts: now }];
  await db.query(
    `UPDATE conversations
     SET messages = $1::jsonb,
         follow_ups_sent = $2,
         last_activity = now()
     WHERE contact_id = $3`,
    [JSON.stringify(newMessages), attempt, contactId]
  );

  console.log(`[follow-up] enviado | contact=${contactId} attempt=${attempt} channel=${channel} chars=${text.length}`);
}

async function handleMarkLost(data: MarkLostJobData): Promise<void> {
  const { contactId, scheduledAt } = data;
  const cfg = getConfig();
  const fu = cfg.follow_ups;
  if (!fu?.lost_stage || !cfg.pipeline || !process.env.GHL_LOCATION_ID) return;

  console.log(`[mark-lost] fired | contact=${contactId}`);

  if (await contactoBloqueadoAsync(contactId)) {
    console.log(`[mark-lost] bloqueado — contacto en blocklist | contact=${contactId}`);
    return;
  }

  // 1. Cargar conversación
  const r = await db.query(
    `SELECT messages, last_bot_message_at FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  if (r.rows.length === 0) return;
  const { messages, last_bot_message_at } = r.rows[0];
  const history: ChatMessage[] = messages || [];

  // 2. Stale check: si el bot reescribió, el lead sigue activo
  const lastBotMs = last_bot_message_at ? new Date(last_bot_message_at).getTime() : 0;
  if (lastBotMs > scheduledAt + 60_000) {
    console.log(`[mark-lost] stale | contact=${contactId}`);
    return;
  }

  // 3. Si el cliente respondió después, skip
  const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
  const lastUserMs = lastUserMsg ? new Date(lastUserMsg.ts).getTime() : 0;
  if (lastUserMs > scheduledAt) {
    console.log(`[mark-lost] cliente respondió | contact=${contactId}`);
    return;
  }

  // 4. Solo movemos si sigue en la etapa de entrada (no pisamos etapas avanzadas)
  if (!(await stillInEntryStage(contactId))) {
    console.log(`[mark-lost] opp ya en otra etapa, skip | contact=${contactId}`);
    return;
  }

  const stageId = stageIdByName(fu.lost_stage);
  if (!stageId) {
    console.warn(`[mark-lost] lost_stage "${fu.lost_stage}" no está en pipeline.stages del yaml`);
    return;
  }

  const opps = await findContactOpportunity(contactId, cfg.pipeline.id, process.env.GHL_LOCATION_ID);
  if (opps.length === 0) {
    console.log(`[mark-lost] sin opportunity | contact=${contactId}`);
    return;
  }

  // 5. Nunca pisar una etapa que mueve el CÓDIGO — las marcadas "AUTO:" en el
  // yaml: cita agendada, escalado a humano, y este mismo "No contestó". Son
  // cierres reales del ciclo, y marcar perdido a alguien que ya agendó es peor
  // que no marcarlo. Se comprueba contra el estado VIVO de GHL y no contra las
  // tools del turno, porque este job nació horas antes y el contacto pudo
  // haber cerrado en medio.
  //
  // Va como lista de EXCLUSIÓN y no como `entry_stage` (que es de inclusión) a
  // propósito: entry_stage exige saber con certeza en qué etapa nace la
  // opportunity, y si ese dato no coincide con la realidad el job se salta a
  // TODOS en silencio — el mismo modo de falla que este arreglo viene a quitar.
  const cerradaEn = etapaDeCierrePorId(opps[0].pipelineStageId);
  if (cerradaEn) {
    console.log(`[mark-lost] ciclo ya cerrado en "${cerradaEn}", skip | contact=${contactId}`);
    return;
  }

  try {
    await moveOpportunityToStage(opps[0].id, stageId);
    console.log(`[mark-lost] OK | contact=${contactId} opp=${opps[0].id} → "${fu.lost_stage}"`);
  } catch (err) {
    console.warn(`[mark-lost] move failed | contact=${contactId}: ${(err as Error).message}`);
  }
}

export async function startFollowUpWorker(concurrency = 1): Promise<void> {
  await boss.work<FollowUpJobData>(
    FOLLOW_UP_QUEUE,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      try {
        await handleFollowUp(job.data);
      } catch (err) {
        console.error(`[follow-up] handler error: ${(err as Error).message}`);
        throw err;
      }
    }
  );

  await boss.work<MarkLostJobData>(
    MARK_LOST_QUEUE,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      try {
        await handleMarkLost(job.data);
      } catch (err) {
        console.error(`[mark-lost] handler error: ${(err as Error).message}`);
        throw err;
      }
    }
  );

  console.log(`[follow-up] worker started | concurrency=${concurrency}`);
}
