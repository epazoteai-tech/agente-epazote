/**
 * Evento Purchase a Meta por Conversions API (Mesa de Control, fase 2).
 *
 * Cuando el host cierra una mesa con su total, Meta recibe una compra en tienda
 * (action_source = physical_store) con el valor REAL y el teléfono cifrado del
 * cliente, para empatarlo con quien vio el anuncio. Es lo que convierte el
 * ROAS del panel en un ROAS que Meta también ve.
 *
 * Variables de Railway (si falta alguna, no se manda nada y el panel sigue):
 *   META_DATASET_ID        el Pixel / dataset de Epazote
 *   META_CAPI_TOKEN        token de Conversions API de ese dataset
 *   META_TEST_EVENT_CODE   opcional: SOLO la semana de prueba. Con él, los
 *                          eventos caen en "Probar eventos" y NO cuentan en
 *                          las campañas. Hay que quitarlo al terminar.
 *   META_GRAPH_VERSION     opcional, default v23.0
 *
 * Tres decisiones:
 * - No se manda al cerrar la mesa sino 10 minutos después (`ESPERA_MIN`). Meta
 *   descarta un segundo evento con el mismo event_id, así que si el host
 *   corrige el total en ese rato, sale el bueno y no el primero.
 * - Lo manda un barrido cada minuto, no la petición del host: si Meta o la red
 *   fallan, se reintenta solo (hasta MAX_INTENTOS) y el host nunca espera.
 * - Sin teléfono no hay a quién empatar (walk-ins): no se manda.
 */

import { createHash } from 'crypto';
import { db } from '../db/client';

export const ESPERA_MIN = 10;
export const MAX_INTENTOS = 5;

const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * Teléfonos mexicanos en las DOS formas que circulan: 52 + 10 dígitos (la
 * actual) y 521 + 10 (la vieja de celulares, que todavía trae WhatsApp en
 * muchos contactos). Meta acepta una lista y empata con cualquiera. Un número
 * de 10 dígitos sin lada internacional se asume de México.
 */
export function telefonosParaMeta(telefono: string): string[] {
  const d = (telefono ?? '').replace(/\D/g, '');
  let diez = '';
  if (d.length === 10) diez = d;
  else if (d.length === 12 && d.startsWith('52')) diez = d.slice(2);
  else if (d.length === 13 && d.startsWith('521')) diez = d.slice(3);
  if (diez) return [`52${diez}`, `521${diez}`];
  return d.length >= 8 ? [d] : [];
}

/**
 * Nombre normalizado como lo hace el SDK oficial de Meta: minúsculas, sin
 * signos ni números, CON acentos y ñ (en UTF-8). Quitarlos no es neutral: el
 * hash de "jose" no empata con el "josé" que Meta tiene del perfil.
 */
export function normalizarNombre(t: string): string {
  return (t ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ConsumoParaMeta {
  consumoId: number;
  reservaId: number;
  total: number;
  telefono: string;
  nombre: string;
  contactId: string | null;
  /** Instante del cierre (ms). */
  cerradoMs: number;
}

/** El evento tal cual lo recibe Meta. null si no hay con qué empatarlo. */
export function armarEvento(c: ConsumoParaMeta): Record<string, unknown> | null {
  const telefonos = telefonosParaMeta(c.telefono);
  if (!telefonos.length) return null;
  const [nombre, ...apellidos] = normalizarNombre(c.nombre).split(' ');
  const user_data: Record<string, unknown> = {
    ph: telefonos.map(sha256),
    country: [sha256('mx')],
  };
  if (nombre) user_data.fn = [sha256(nombre)];
  if (apellidos.length) user_data.ln = [sha256(apellidos.join(' '))];
  if (c.contactId) user_data.external_id = [sha256(c.contactId)];
  return {
    event_name: 'Purchase',
    event_time: Math.floor(c.cerradoMs / 1000),
    // Estable por consumo: si el envío se repite, Meta lo cuenta una sola vez.
    event_id: `epazote-consumo-${c.consumoId}`,
    action_source: 'physical_store',
    user_data,
    custom_data: {
      currency: 'MXN',
      value: Math.round(c.total * 100) / 100,
      order_id: `reserva-${c.reservaId}`,
    },
  };
}

export function capiConfigurado(): boolean {
  return !!(process.env.META_DATASET_ID?.trim() && process.env.META_CAPI_TOKEN?.trim());
}

function urlEventos(): string {
  const v = process.env.META_GRAPH_VERSION?.trim() || 'v23.0';
  return `https://graph.facebook.com/${v}/${process.env.META_DATASET_ID!.trim()}/events`;
}

/** Manda un lote de eventos. Lanza con el error de Meta si no los acepta. */
export async function enviarEventos(eventos: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const cuerpo: Record<string, unknown> = { data: eventos };
  const prueba = process.env.META_TEST_EVENT_CODE?.trim();
  if (prueba) cuerpo.test_event_code = prueba;
  const res = await fetch(`${urlEventos()}?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN!.trim())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15_000),
  });
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = (d.error ?? {}) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status}: ${String(e.message ?? JSON.stringify(d)).slice(0, 300)}`);
  }
  return d;
}

/**
 * Barrido: manda los consumos cerrados hace más de ESPERA_MIN que no se han
 * mandado. Cada uno por separado, para que uno malo no tumbe a los demás.
 */
export async function enviarPendientes(): Promise<{ enviados: number; fallidos: number; sinDatos: number }> {
  if (!capiConfigurado()) return { enviados: 0, fallidos: 0, sinDatos: 0 };
  const { rows } = await db.query(
    `SELECT c.id::int AS consumo_id, r.id::int AS reserva_id, c.total::float AS total, r.telefono, r.nombre,
            r.contact_id, c.actualizado_at
       FROM consumos c JOIN reservas r ON r.id = c.reserva_id
      WHERE c.capi_enviado_at IS NULL
        AND c.capi_intentos < $1
        AND c.actualizado_at < now() - make_interval(mins => $2)
        AND r.estado = 'llego'
      ORDER BY c.actualizado_at
      LIMIT 20`,
    [MAX_INTENTOS, ESPERA_MIN]
  );
  let enviados = 0, fallidos = 0, sinDatos = 0;
  for (const f of rows) {
    const evento = armarEvento({
      consumoId: f.consumo_id,
      reservaId: f.reserva_id,
      total: f.total,
      telefono: f.telefono,
      nombre: f.nombre,
      contactId: f.contact_id,
      cerradoMs: new Date(f.actualizado_at).getTime(),
    });
    if (!evento) {
      // Walk-in o reserva sin teléfono: se marca para no revisarla cada minuto.
      await db.query(
        `UPDATE consumos SET capi_intentos = $2, capi_respuesta = $3 WHERE id = $1`,
        [f.consumo_id, MAX_INTENTOS, JSON.stringify({ omitido: 'sin teléfono para empatar' })]
      );
      sinDatos++;
      continue;
    }
    try {
      const r = await enviarEventos([evento]);
      await db.query(
        `UPDATE consumos SET capi_enviado_at = now(), capi_intentos = capi_intentos + 1, capi_respuesta = $2 WHERE id = $1`,
        [f.consumo_id, JSON.stringify({ ...r, prueba: !!process.env.META_TEST_EVENT_CODE?.trim() })]
      );
      enviados++;
      console.log(`[capi] Purchase enviado | consumo=${f.consumo_id} valor=${f.total} recibidos=${String(r.events_received ?? '?')}`);
    } catch (e) {
      await db.query(
        `UPDATE consumos SET capi_intentos = capi_intentos + 1, capi_respuesta = $2 WHERE id = $1`,
        [f.consumo_id, JSON.stringify({ error: (e as Error).message })]
      );
      fallidos++;
      console.error(`[capi] Purchase NO enviado | consumo=${f.consumo_id}: ${(e as Error).message}`);
    }
  }
  return { enviados, fallidos, sinDatos };
}

/**
 * Para el arranque (verificar-llaves) y GET /api/mesa/meta/estado: ¿este token
 * puede MANDAR eventos a este dataset? null = CAPI no configurado (no es error).
 *
 * Se prueba con un POST a /events con la lista VACÍA. Meta revisa token y
 * permisos antes que el contenido, así que la respuesta lo dice sin registrar
 * ningún evento: error 190 = token inválido; "permission" = el token no tiene
 * acceso a ese dataset; un reclamo por el parámetro `data` = todo bien.
 *
 * No se lee el dataset (GET /{id}?fields=name): el token de Conversions API
 * solo puede mandar eventos, y esa lectura contesta "(#100) Missing
 * Permission" aunque el token funcione — nos dio un falso negativo el
 * 01/10/2026 con el token bueno de Epazote.
 */
export async function verificarMeta(): Promise<{ ok: boolean; detalle: string } | null> {
  if (!process.env.META_DATASET_ID && !process.env.META_CAPI_TOKEN) return null;
  if (!capiConfigurado()) return { ok: false, detalle: 'falta META_DATASET_ID o META_CAPI_TOKEN (o está vacía)' };
  const res = await fetch(`${urlEventos()}?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN!.trim())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: [] }),
    signal: AbortSignal.timeout(8_000),
  });
  const d = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
  const e = d.error ?? {};
  const msg = String(e.message ?? '');
  const prueba = process.env.META_TEST_EVENT_CODE?.trim()
    ? ' ⚠️ CON código de prueba: los eventos NO cuentan en campañas hasta quitar META_TEST_EVENT_CODE'
    : '';
  if (res.ok || (e.code === 100 && /\bdata\b/i.test(msg) && !/permission/i.test(msg))) {
    return { ok: true, detalle: `token y dataset aceptan eventos${prueba}` };
  }
  if (e.code === 190) return { ok: false, detalle: `token inválido o vencido: ${msg.slice(0, 200)}` };
  if (/permission|permiso/i.test(msg) || e.code === 10 || e.code === 200) {
    return { ok: false, detalle: `el token no tiene permiso sobre el dataset ${process.env.META_DATASET_ID}: ${msg.slice(0, 200)}` };
  }
  return { ok: false, detalle: `respuesta inesperada de Meta (HTTP ${res.status}): ${msg.slice(0, 200) || JSON.stringify(d).slice(0, 200)}` };
}
