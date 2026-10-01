/**
 * Mesa de Control de Epazote — la parte que vive en la base del bot.
 *
 * Cierra el embudo que hoy se mide solo hasta el clic a WhatsApp: origen de
 * campaña → solicitud (la registra el bot) → confirmada → llegó / no llegó →
 * consumo. Las funciones puras (atribución, embudo, horas) están separadas de
 * las que tocan la base para poder probarlas sin red (pruebas/mesa.js).
 */

import { db } from '../db/client';

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
  const { rows } = await db.query(
    `INSERT INTO reservas (contact_id, nombre, telefono, fecha, hora, personas, ocasion, turno, origen_mensaje, canal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bot')
     RETURNING id`,
    [r.contactId, r.nombre, r.telefono, r.fecha, r.hora, r.personas, ocasion, r.turno, r.origen]
  );
  return { id: Number(rows[0].id), accion: 'nueva' };
}
