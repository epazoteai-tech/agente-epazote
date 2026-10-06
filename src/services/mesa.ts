/**
 * Mesa de Control de Epazote — la parte que vive en la base del bot.
 *
 * Cierra el embudo que hoy se mide solo hasta el clic a WhatsApp: origen de
 * campaña → solicitud (la registra el bot) → confirmada → llegó / no llegó →
 * consumo. Las funciones puras (atribución, embudo, horas) están separadas de
 * las que tocan la base para poder probarlas sin red (pruebas/mesa.js).
 */

import { db } from '../db/client';
import { getConfig } from '../config';
import { getContact, updateContactName } from './ghl';
import { pareceNombreReal } from '../nombres';
import { mensajeDeOrigen, minutosDe, turnoDe } from './reservas';
import { ChatMessage } from '../types';

// ─── Puras ───────────────────────────────────────────────────────────────────

export interface Campana {
  id: number;
  nombre: string;
  palabra_clave: string;
  gasto_mensual: number;
  activa: boolean;
}

const sinAcentos = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * A qué campaña se atribuye una reserva, por el texto con el que abrió la
 * conversación (el precargado del wa.link de cada creativo). Gana la palabra
 * clave MÁS LARGA que aparezca: "cabrito con mole" es más específico que
 * "cabrito", y con dos creativos parecidos el corto se comería al largo.
 * Sin coincidencia → null ("directo / sin campaña").
 */
export function campanaDeOrigen(origen: string, campanas: Campana[]): Campana | null {
  const texto = sinAcentos(origen ?? '');
  if (!texto.trim()) return null;
  let mejor: Campana | null = null;
  for (const c of campanas) {
    const clave = sinAcentos(c.palabra_clave ?? '').trim();
    if (!clave || !texto.includes(clave)) continue;
    if (!mejor || clave.length > sinAcentos(mejor.palabra_clave).trim().length) mejor = c;
  }
  return mejor;
}

/** Es un cambio de una solicitud anterior (así lo marca el bot en `ocasion`). */
export function esCambio(ocasion: string): boolean {
  return /^\s*cambio de la solicitud anterior/i.test(ocasion ?? '');
}

/** Quita la marca de cambio para que no quede en la ocasión que ve el host. */
export function ocasionLimpia(ocasion: string): string {
  return (ocasion ?? '').replace(/^\s*cambio de la solicitud anterior[\s:.,-]*/i, '').trim();
}

export interface FilaEmbudo {
  estado: string;
  canal: string;
  total: number | null;
}

/**
 * El embudo de un periodo. Solo cuentan para el show rate las reservas cuya
 * suerte ya se sabe (llegó / no llegó): una confirmada para mañana todavía no
 * es ni una cosa ni la otra, y contarla como no-show hundiría el número.
 * Los walk-ins se reportan aparte: no pasaron por la solicitud.
 */
export function embudo(filas: FilaEmbudo[]) {
  const reservas = filas.filter((f) => f.canal !== 'walk-in');
  const solicitudes = reservas.length;
  const canceladas = reservas.filter((f) => f.estado === 'cancelada').length;
  const confirmadas = reservas.filter((f) => ['confirmada', 'llego', 'no_llego'].includes(f.estado)).length;
  const llegaron = reservas.filter((f) => f.estado === 'llego').length;
  const noLlegaron = reservas.filter((f) => f.estado === 'no_llego').length;
  const conConsumo = reservas.filter((f) => f.estado === 'llego' && f.total !== null).length;
  const decididas = llegaron + noLlegaron;
  return {
    solicitudes,
    canceladas,
    confirmadas,
    llegaron,
    noLlegaron,
    conConsumo,
    showRate: decididas > 0 ? llegaron / decididas : null,
    walkins: filas.length - reservas.length,
  };
}

/** Gasto de una campaña prorrateado a los días del periodo (el gasto se captura mensual). */
export function gastoDelPeriodo(gastoMensual: number, dias: number): number {
  return Math.round(((gastoMensual * Math.max(dias, 0)) / 30) * 100) / 100;
}

// ─── Base de datos ───────────────────────────────────────────────────────────

export interface ReservaDelBot {
  contactId: string;
  nombre: string;
  telefono: string;
  fecha: string; // YYYY-MM-DD
  hora: string; // HH:MM
  personas: number;
  ocasion: string;
  turno: string;
  origen: string;
  /** Del anuncio Click-to-WhatsApp, si el contacto llegó por uno (GHL lastAttributionSource). */
  anuncio?: { ctwaClid?: string; adId?: string; adName?: string } | null;
}

/**
 * Deja la solicitud del bot en la Mesa de Control. Un cambio ("CAMBIO de la
 * solicitud anterior") corrige la reserva VIVA más próxima de ese contacto en
 * vez de crear otra: si no, Mony vería dos reservas de la misma familia y el
 * show rate contaría un no-show que nunca existió. Si no hay ninguna viva, se
 * registra como nueva.
 */
export async function guardarReservaDelBot(
  r: ReservaDelBot,
  tz: string
): Promise<{ id: number; accion: 'nueva' | 'cambio' }> {
  const ocasion = ocasionLimpia(r.ocasion);
  if (esCambio(r.ocasion)) {
    const { rows } = await db.query(
      `UPDATE reservas
          SET nombre = $2, fecha = $3, hora = $4, personas = $5, ocasion = $6, turno = $7,
              estado = 'solicitada', confirmada_at = NULL, actualizado_at = now()
        WHERE id = (
          SELECT id FROM reservas
           WHERE contact_id = $1 AND estado IN ('solicitada', 'confirmada')
             AND fecha >= (now() AT TIME ZONE $8)::date
           ORDER BY fecha, hora LIMIT 1)
        RETURNING id`,
      [r.contactId, r.nombre, r.fecha, r.hora, r.personas, ocasion, r.turno, tz]
    );
    if (rows[0]) return { id: Number(rows[0].id), accion: 'cambio' };
  }
  // Si este contacto ya estaba en la Mesa como escalado sin fecha (pidió mesa,
  // lo atendió una persona y después el bot la registró completa), se completa
  // esa fila en vez de dejar dos tarjetas de la misma familia.
  const { rows: incompleta } = await db.query(
    `UPDATE reservas
        SET nombre = $2, fecha = $3, hora = $4, personas = $5, ocasion = $6, turno = $7, actualizado_at = now()
      WHERE id = (
        SELECT id FROM reservas
         WHERE contact_id = $1 AND estado = 'solicitada' AND escalada AND fecha IS NULL
         ORDER BY created_at DESC LIMIT 1)
      RETURNING id`,
    [r.contactId, r.nombre, r.fecha, r.hora, r.personas, ocasion, r.turno]
  );
  if (incompleta[0]) return { id: Number(incompleta[0].id), accion: 'cambio' };
  const { rows } = await db.query(
    `INSERT INTO reservas (contact_id, nombre, telefono, fecha, hora, personas, ocasion, turno, origen_mensaje, canal, ctwa_clid, ad_id, ad_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bot', $10, $11, $12)
     RETURNING id`,
    [r.contactId, r.nombre, r.telefono, r.fecha, r.hora, r.personas, ocasion, r.turno, r.origen,
     r.anuncio?.ctwaClid || null, r.anuncio?.adId || null, r.anuncio?.adName || null]
  );
  return { id: Number(rows[0].id), accion: 'nueva' };
}


export interface ReservaEscalada {
  contactId: string;
  nombre: string;
  telefono: string;
  fecha: string | null; // YYYY-MM-DD
  hora: string | null; // HH:MM
  personas: number | null;
  ocasion: string;
  turno: string;
  origen: string;
  motivo: string;
  anuncio?: { ctwaClid?: string; adId?: string; adName?: string } | null;
}

/**
 * Deja en la Mesa la mesa que el bot NO pudo registrar y pasó a una persona
 * (grupo grande, evento, falla al registrar). Va como "solicitada" con la
 * marca de escalada para que el host la vea en Próximas y la confirme ahí.
 *
 * Si el contacto ya tiene una solicitud viva (la registró el bot y luego pidió
 * a una persona, o se escaló dos veces), se marca y se completa esa misma con
 * lo nuevo, sin borrar lo que ya tenía: una sola tarjeta por familia.
 */
export async function guardarReservaEscalada(r: ReservaEscalada, tz: string): Promise<{ id: number; accion: 'nueva' | 'marcada' }> {
  const ocasion = ocasionLimpia(r.ocasion);
  const { rows: viva } = await db.query(
    `UPDATE reservas
        SET escalada = true, motivo_escalacion = $2,
            nombre = COALESCE(NULLIF($3, ''), nombre), fecha = COALESCE($4::date, fecha),
            hora = COALESCE($5, hora), personas = COALESCE($6, personas),
            ocasion = COALESCE(NULLIF($7, ''), ocasion), turno = COALESCE(NULLIF($8, ''), turno),
            actualizado_at = now()
      WHERE id = (
        SELECT id FROM reservas
         WHERE contact_id = $1 AND estado = 'solicitada'
           AND (fecha IS NULL OR fecha >= (now() AT TIME ZONE $9)::date)
         ORDER BY created_at DESC LIMIT 1)
      RETURNING id`,
    [r.contactId, r.motivo, r.nombre, r.fecha, r.hora, r.personas, ocasion, r.turno, tz]
  );
  if (viva[0]) return { id: Number(viva[0].id), accion: 'marcada' };
  const { rows } = await db.query(
    `INSERT INTO reservas (contact_id, nombre, telefono, fecha, hora, personas, ocasion, turno, origen_mensaje, canal,
                           ctwa_clid, ad_id, ad_name, escalada, motivo_escalacion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bot', $10, $11, $12, true, $13)
     RETURNING id`,
    [r.contactId, r.nombre, r.telefono, r.fecha, r.hora, r.personas, ocasion, r.turno, r.origen,
     r.anuncio?.ctwaClid || null, r.anuncio?.adId || null, r.anuncio?.adName || null, r.motivo]
  );
  return { id: Number(rows[0].id), accion: 'nueva' };
}

/**
 * Lee del contacto de GHL el anuncio que lo trajo. GHL guarda en
 * `lastAttributionSource` el ctwaClid, adId y adName de los anuncios
 * Click-to-WhatsApp (verificado el 05/10/2026 con un contacto real de la
 * campaña). null si no llegó por un anuncio.
 */
export function anuncioDelContacto(contacto: unknown): { ctwaClid?: string; adId?: string; adName?: string } | null {
  const a = (contacto as { lastAttributionSource?: Record<string, unknown> } | null)?.lastAttributionSource;
  if (!a || typeof a !== 'object') return null;
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const r = { ctwaClid: txt(a.ctwaClid), adId: txt(a.adId), adName: txt(a.adName) };
  return r.ctwaClid || r.adId ? r : null;
}

/**
 * Teléfono, anuncio y mensaje de origen del contacto para su fila en la Mesa
 * de Control. Best-effort: lo que no se pueda leer queda vacío. De paso le pone
 * nombre al contacto de GHL si todavía no tiene uno real.
 */
export async function datosParaLaMesa(
  contactId: string,
  nombre: string,
  etiqueta: string
): Promise<{ telefono: string; anuncio: ReturnType<typeof anuncioDelContacto>; origen: string }> {
  let telefono = '';
  let anuncio: ReturnType<typeof anuncioDelContacto> = null;
  try {
    const contacto = await getContact(contactId);
    telefono = contacto?.phone ?? '';
    anuncio = anuncioDelContacto(contacto);
    if (nombre && !pareceNombreReal(contacto?.firstName)) await updateContactName(contactId, nombre);
  } catch (err) {
    console.warn(`[tool:${etiqueta}] getContact/updateContactName failed: ${(err as Error).message}`);
  }

  // Origen de campaña: el mensaje con el que abrió la sesión (texto
  // precargado del wa.link del creativo).
  let origen = '';
  try {
    const r = await db.query(`SELECT messages, phone FROM conversations WHERE contact_id = $1`, [contactId]);
    origen = mensajeDeOrigen((r.rows[0]?.messages as ChatMessage[]) ?? []);
    telefono = telefono || r.rows[0]?.phone || '';
  } catch (err) {
    console.warn(`[tool:${etiqueta}] no se pudo leer el origen: ${(err as Error).message}`);
  }
  return { telefono, anuncio, origen };
}

/**
 * Escalación de una mesa (grupo grande, evento, reserva que no se pudo
 * registrar): queda en la Mesa de Control como solicitud para que el equipo la
 * vea en Próximas y la confirme desde ahí. Se toma solo lo que el modelo pasó
 * y se ve válido; lo demás queda vacío para que el host lo complete.
 */
export async function guardarEscaladaEnMesa(input: Record<string, unknown>, contactId: string, motivo: string): Promise<{ id: number; accion: 'nueva' | 'marcada' } | null> {
  const res = getConfig().reservations;
  if (!res || input.es_reserva !== true) return null;
  const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(txt(input.fecha)) && !isNaN(Date.parse(txt(input.fecha))) ? txt(input.fecha) : null;
  const horaCruda = txt(input.hora);
  const minutos = /^\d{1,2}:\d{2}$/.test(horaCruda) ? minutosDe(horaCruda) : null;
  const hora = minutos !== null ? horaCruda.padStart(5, '0') : null;
  const p = typeof input.personas === 'number' ? input.personas : parseInt(txt(input.personas), 10);
  const personas = Number.isInteger(p) && p > 0 && p < 1000 ? p : null;
  const nombre = txt(input.nombre).replace(/\s+/g, ' ');
  const { telefono, anuncio, origen } = await datosParaLaMesa(contactId, nombre, 'escalar_a_humano');
  const m = await guardarReservaEscalada(
    {
      contactId,
      nombre,
      telefono,
      fecha,
      hora,
      personas,
      ocasion: txt(input.ocasion),
      turno: minutos !== null ? turnoDe(minutos, res) : '',
      origen,
      motivo,
      anuncio,
    },
    res.timezone
  );
  console.log(`[mesa] escalada ${m.accion} id=${m.id} | contact=${contactId} fecha=${fecha ?? '-'} personas=${personas ?? '-'}`);
  return m;
}
