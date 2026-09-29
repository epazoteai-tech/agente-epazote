/**
 * Lista negra de contactos que el bot NUNCA debe atender.
 *
 * Para qué sirve: cortar en seco una conversación que no debe existir — el
 * caso típico es otro bot al otro lado del WhatsApp. Dos bots conversando se
 * responden infinitamente entre sí, queman tokens y ensucian el pipeline de
 * GHL con un lead que no es una persona.
 *
 * El corte es TOTAL y silencioso:
 *   - el webhook descarta el entrante antes de tocar la base o la cola
 *   - el worker de mensajes descarta cualquier job que ya estuviera en cola
 *   - el worker de follow-ups nunca manda un proactivo a estos contactos
 *
 * Silencioso a propósito: cualquier respuesta (aunque sea "adiós") le da al
 * otro bot algo a qué contestar.
 *
 * Hay dos formas de entrar a la lista:
 *
 *   - MANUAL (este archivo / env var) — la pones tú porque ya sabes que ese
 *     número no es una persona.
 *   - AUTOMÁTICA (src/loop-guard.ts) — el bot detecta solo la cadencia de una
 *     máquina o una ráfaga de turnos imposible para un humano, y escribe el
 *     bloqueo en la base (conversations.blocked_at). Esa vía no necesita
 *     deploy y sobrevive reinicios.
 *
 * Cómo agregar más contactos a mano:
 *   - permanente → agrega el número a BLOQUEADOS aquí abajo y haz push
 *   - temporal / sin deploy → env var BLOCKED_NUMBERS en Railway, separada
 *     por comas: "3326305903, 8112345678". Acepta también contactIds de GHL.
 *
 * Para desbloquear a alguien que cayó por error, en la base:
 *   UPDATE conversations SET blocked_at = NULL, blocked_reason = NULL,
 *          turn_count = 0, fast_replies = 0 WHERE contact_id = '...';
 * (y reinicia el servicio en Railway, porque el bloqueo se cachea en memoria)
 */

import { db } from './db/client';

/**
 * Números y contactIds bloqueados de forma permanente (en código).
 *
 * Arranca vacía a propósito: lo normal es que no haya que tocarla nunca,
 * porque el loop-guard detecta solo a los bots. Se llena a mano cuando ya
 * sabes que un número específico no es una persona.
 *
 * Formato: el número tal cual, con o sin lada de país — se normaliza solo.
 *   const BLOQUEADOS: string[] = ['3326305903', '+528112345678'];
 */
const BLOQUEADOS: string[] = [];

/**
 * Normaliza un teléfono a sus últimos 10 dígitos, que es lo único estable
 * entre formatos: GHL manda "+523326305903", el CRM guarda "3326305903" y
 * a veces llega "52 1 33 2630 5903" con el 1 de móvil viejo de México.
 */
function normalizarTelefono(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  return digitos.length > 10 ? digitos.slice(-10) : digitos;
}

function entradasConfiguradas(): string[] {
  const desdeEnv = (process.env.BLOCKED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...BLOQUEADOS, ...desdeEnv];
}

/** Teléfonos bloqueados, normalizados (solo entradas de >= 10 dígitos). */
function telefonosBloqueados(): Set<string> {
  return new Set(
    entradasConfiguradas()
      .map(normalizarTelefono)
      .filter((d) => d.length === 10)
  );
}

/** ContactIds de GHL bloqueados (entradas que no son un teléfono). */
function contactIdsBloqueados(): Set<string> {
  return new Set(entradasConfiguradas().filter((e) => normalizarTelefono(e).length !== 10));
}

/** ¿Este teléfono está bloqueado? Chequeo sincrónico, sin tocar la base. */
export function telefonoBloqueado(phone?: string | null): boolean {
  if (!phone) return false;
  const norm = normalizarTelefono(phone);
  return norm.length === 10 && telefonosBloqueados().has(norm);
}

/**
 * ¿Este contacto está bloqueado? Chequeo sincrónico: sirve donde ya tenemos
 * el teléfono a la mano (webhook, job de la cola).
 */
export function contactoBloqueado(contactId?: string | null, phone?: string | null): boolean {
  if (contactId && contactIdsBloqueados().has(contactId)) return true;
  return telefonoBloqueado(phone);
}

// Cache en memoria de los bloqueos que viven en la base. El bloqueo es
// permanente, así que una vez confirmado no hace falta volver a preguntar:
// los contactos bloqueados dejan de costar hasta una query.
const bloqueadosEnBase = new Set<string>();

/**
 * Resuelve contra la base: el bloqueo automático del loop-guard y, de paso,
 * el teléfono del contacto — el worker de follow-ups solo tiene el contactId,
 * así que sin esto un proactivo hacia un número de la lista estática se
 * escaparía. Una sola query resuelve las dos cosas.
 *
 * Si la base falla, responde que no: el webhook ya filtró por la lista
 * estática y preferimos un turno de más a dejar de atender pacientes.
 */
async function bloqueadoEnBase(contactId: string): Promise<boolean> {
  if (bloqueadosEnBase.has(contactId)) return true;
  try {
    const res = await db.query<{ blocked_at: Date | null; phone: string | null }>(
      `SELECT blocked_at, phone FROM conversations WHERE contact_id = $1`,
      [contactId]
    );
    const fila = res.rows[0];
    if (!fila) return false;

    if (fila.blocked_at || telefonoBloqueado(fila.phone)) {
      bloqueadosEnBase.add(contactId);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[blocklist] no se pudo consultar bloqueo | contact=${contactId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Chequeo completo: lista estática (código/env) + bloqueo automático en base.
 * Es el que usan el webhook, el worker de mensajes y el de follow-ups.
 */
export async function contactoBloqueadoAsync(
  contactId: string,
  phone?: string | null
): Promise<boolean> {
  if (contactoBloqueado(contactId, phone)) return true;
  return bloqueadoEnBase(contactId);
}

/**
 * Manda un contacto a la lista negra permanente. Lo llama el loop-guard
 * cuando detecta que del otro lado hay una máquina.
 *
 * A propósito NO escala, NO pone tag y NO avisa a nadie: es un contacto que
 * no queremos atender, no un lead que requiere un humano. Queda el motivo en
 * blocked_reason y una línea en los logs para poder auditarlo después.
 */
export async function bloquearContacto(contactId: string, motivo: string): Promise<void> {
  bloqueadosEnBase.add(contactId);
  try {
    await db.query(
      `UPDATE conversations
       SET blocked_at = now(), blocked_reason = $2,
           pending_message = NULL, pending_at = NULL,
           pending_attachments = '[]'::jsonb
       WHERE contact_id = $1`,
      [contactId, motivo]
    );
    console.warn(`[blocklist] BLOQUEADO automáticamente | contact=${contactId} motivo="${motivo}"`);
  } catch (err) {
    console.error(`[blocklist] no se pudo persistir el bloqueo | contact=${contactId}: ${(err as Error).message}`);
  }
}
