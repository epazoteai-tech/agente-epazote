/**
 * API de la Mesa de Control (todo detrás de requierePin, ver index.ts).
 *
 * Una regla de diseño que manda sobre las demás: el host no debe tener que
 * hacer DOS cosas. Cambiar el estado de una reserva aquí también mueve su
 * tarjeta en el pipeline de GHL, porque el recordatorio por plantilla cuelga de
 * la etapa "Confirmada". Si Mony tuviera que confirmar aquí y además mover la
 * tarjeta allá, una de las dos se olvidaría.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { getConfig } from '../config';
import { minutosDe, turnoDe } from '../services/reservas';
import { campanaDeOrigen, embudo, gastoDelPeriodo, Campana } from '../services/mesa';
import { capiConfigurado, verificarMeta, datasetDeLaWaba } from '../services/capi';
import {
  findContactOpportunity,
  moveOpportunityToStage,
  createOpportunity,
} from '../services/ghl';

export const mesaRouter = Router();

/** Express 4 no captura rechazos async: sin esto, un error de una consulta mata el proceso que atiende WhatsApp (E72). */
function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const ESTADOS = ['solicitada', 'confirmada', 'llego', 'no_llego', 'cancelada'] as const;
type Estado = (typeof ESTADOS)[number];
const COMO_SE_ENTERO = ['redes_anuncio', 'recomendacion', 'ya_conocia', 'pasaba_por_aqui'] as const;

/** Etapa de GHL que corresponde a cada estado (las que existen en el yaml). */
const ETAPA_DE_ESTADO: Partial<Record<Estado, string>> = {
  confirmada: 'Confirmada',
  llego: 'Asistió',
  no_llego: 'No asistió',
};

function zona(): string {
  return getConfig().reservations?.timezone ?? 'America/Monterrey';
}

/** Fecha y hora de pared del restaurante, ahora. */
function ahora(): { fecha: string; hora: string; minutos: number } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zona(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const hora = `${partes.hour}:${partes.minute}`;
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora, minutos: minutosDe(hora) ?? 0 };
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{1,2}:\d{2}$/;

function rango(req: Request): { desde: string; hasta: string } {
  const hoy = ahora().fecha;
  const desde = typeof req.query.desde === 'string' && FECHA.test(req.query.desde) ? req.query.desde : hoy;
  const hasta = typeof req.query.hasta === 'string' && FECHA.test(req.query.hasta) ? req.query.hasta : desde;
  return desde <= hasta ? { desde, hasta } : { desde: hasta, hasta: desde };
}

async function campanas(): Promise<Campana[]> {
  const { rows } = await db.query(
    `SELECT id, nombre, palabra_clave, gasto_mensual::float AS gasto_mensual, activa FROM campanas ORDER BY nombre`
  );
  return rows as Campana[];
}

/** Mueve la tarjeta del contacto a la etapa del estado. Best-effort: nunca bloquea al host. */
async function moverTarjeta(contactId: string | null, estado: Estado, nombre: string): Promise<void> {
  const etapaNombre = ETAPA_DE_ESTADO[estado];
  const pipeline = getConfig().pipeline;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!contactId || !etapaNombre || !pipeline || !locationId) return;
  const etapa = pipeline.stages.find((s) => s.name === etapaNombre);
  if (!etapa) return;
  try {
    const opps = await findContactOpportunity(contactId, pipeline.id, locationId);
    if (opps[0]) {
      if (opps[0].pipelineStageId !== etapa.id) await moveOpportunityToStage(opps[0].id, etapa.id);
    } else {
      await createOpportunity({
        contactId,
        pipelineId: pipeline.id,
        pipelineStageId: etapa.id,
        locationId,
        name: nombre || contactId,
      });
    }
    console.log(`[mesa] tarjeta → "${etapaNombre}" | contact=${contactId}`);
  } catch (e) {
    console.warn(`[mesa] no se pudo mover la tarjeta a "${etapaNombre}" | contact=${contactId}: ${(e as Error).message}`);
  }
}

// `id::int`: BIGSERIAL llega como TEXTO en node-pg ("1"), y el panel compara
// ids con ===. Sin el cast, ningún botón encontraba su reserva.
const SELECT_RESERVAS = `
  SELECT r.id::int AS id, r.contact_id, r.nombre, r.telefono, to_char(r.fecha, 'YYYY-MM-DD') AS fecha, r.hora,
         r.personas, r.ocasion, r.turno, r.origen_mensaje, r.canal, r.como_se_entero, r.estado,
         r.created_at, r.confirmada_at, r.llegada_at, r.ad_id, r.ad_name, r.escalada, r.motivo_escalacion,
         c.total::float AS total,
         (c.capi_enviado_at IS NOT NULL) AS en_meta
    FROM reservas r
    LEFT JOIN consumos c ON c.reserva_id = r.id`;

function conCampana<T extends { origen_mensaje: string }>(filas: T[], camps: Campana[]) {
  return filas.map((f) => ({ ...f, campana: campanaDeOrigen(f.origen_mensaje, camps)?.nombre ?? null }));
}

// ─── Reservas ────────────────────────────────────────────────────────────────

mesaRouter.get('/ping', (_req, res) => {
  res.json({ ok: true, hoy: ahora().fecha });
});

mesaRouter.get(
  '/reservas',
  ah(async (req, res) => {
    const { desde, hasta } = rango(req);
    const { rows } = await db.query(
      `${SELECT_RESERVAS} WHERE r.fecha BETWEEN $1 AND $2 ORDER BY r.fecha, r.hora, r.id`,
      [desde, hasta]
    );
    res.json({ desde, hasta, hoy: ahora().fecha, reservas: conCampana(rows, await campanas()) });
  })
);

/**
 * Mesas que el bot pasó a una persona sin día definido todavía (ej. "somos 15,
 * queremos ir un día de estos"). No caen en ningún día, así que Próximas las
 * pide aparte y las pone arriba.
 */
mesaRouter.get(
  '/reservas/sin-fecha',
  ah(async (_req, res) => {
    const { rows } = await db.query(
      `${SELECT_RESERVAS} WHERE r.fecha IS NULL AND r.estado = 'solicitada' ORDER BY r.created_at DESC`
    );
    res.json({ reservas: conCampana(rows, await campanas()) });
  })
);

mesaRouter.post(
  '/reservas/:id/estado',
  ah(async (req, res) => {
    const estado = req.body?.estado as Estado;
    if (!ESTADOS.includes(estado)) {
      res.status(400).json({ error: 'estado_invalido' });
      return;
    }
    // Una escalada puede venir sin día, hora o personas: no se confirma una
    // mesa que no se sabe cuándo es. El host la completa primero.
    if (['confirmada', 'llego', 'no_llego'].includes(estado)) {
      const { rows: faltan } = await db.query(
        `SELECT 1 FROM reservas WHERE id = $1 AND (fecha IS NULL OR hora IS NULL OR personas IS NULL)`,
        [Number(req.params.id)]
      );
      if (faltan[0]) {
        res.status(400).json({ error: 'faltan_datos', message: 'Pon día, hora y personas antes de confirmar.' });
        return;
      }
    }
    const { rows } = await db.query(
      `UPDATE reservas
          SET estado = $2,
              confirmada_at = CASE WHEN $2 IN ('confirmada', 'llego', 'no_llego') THEN COALESCE(confirmada_at, now()) ELSE confirmada_at END,
              llegada_at = CASE WHEN $2 = 'llego' THEN COALESCE(llegada_at, now()) WHEN $2 IN ('solicitada', 'confirmada', 'no_llego', 'cancelada') THEN NULL ELSE llegada_at END,
              actualizado_at = now()
        WHERE id = $1
        RETURNING id::int AS id, contact_id, nombre, estado`,
      [Number(req.params.id), estado]
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'no_existe' });
      return;
    }
    void moverTarjeta(rows[0].contact_id, estado, rows[0].nombre);
    res.json({ ok: true, reserva: rows[0] });
  })
);

/** Corrección rápida del host: cambió la hora, llegaron más personas, o completa una escalada. */
mesaRouter.post(
  '/reservas/:id',
  ah(async (req, res) => {
    const { hora, personas, fecha, nombre } = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [Number(req.params.id)];
    if (typeof nombre === 'string' && nombre.trim()) {
      vals.push(nombre.trim().replace(/\s+/g, ' ').slice(0, 120));
      sets.push(`nombre = $${vals.length}`);
    }
    if (typeof hora === 'string' && HORA.test(hora)) {
      vals.push(hora.padStart(5, '0'));
      sets.push(`hora = $${vals.length}`);
      const cfg = getConfig().reservations;
      if (cfg) {
        vals.push(turnoDe(minutosDe(hora) ?? 0, cfg));
        sets.push(`turno = $${vals.length}`);
      }
    }
    if (Number.isInteger(personas) && personas > 0) {
      vals.push(personas);
      sets.push(`personas = $${vals.length}`);
    }
    if (typeof fecha === 'string' && FECHA.test(fecha)) {
      vals.push(fecha);
      sets.push(`fecha = $${vals.length}`);
    }
    if (!sets.length) {
      res.status(400).json({ error: 'nada_que_cambiar' });
      return;
    }
    const { rowCount } = await db.query(
      `UPDATE reservas SET ${sets.join(', ')}, actualizado_at = now() WHERE id = $1`,
      vals
    );
    res.status(rowCount ? 200 : 404).json({ ok: !!rowCount });
  })
);

/** Reserva que entró por teléfono: quien contesta la confirma en el momento. */
mesaRouter.post(
  '/reservas',
  ah(async (req, res) => {
    const { nombre, telefono, fecha, hora, personas, ocasion } = req.body ?? {};
    if (!FECHA.test(String(fecha)) || !HORA.test(String(hora)) || !(Number.isInteger(personas) && personas > 0)) {
      res.status(400).json({ error: 'datos_incompletos', message: 'Fecha, hora y personas son obligatorios.' });
      return;
    }
    const cfg = getConfig().reservations;
    const turno = cfg ? turnoDe(minutosDe(hora) ?? 0, cfg) : '';
    const { rows } = await db.query(
      `INSERT INTO reservas (nombre, telefono, fecha, hora, personas, ocasion, turno, canal, estado, confirmada_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'telefono', 'confirmada', now())
       RETURNING id`,
      [String(nombre ?? '').trim(), String(telefono ?? '').trim(), fecha, String(hora).padStart(5, '0'), personas, String(ocasion ?? '').trim(), turno]
    );
    res.json({ ok: true, id: Number(rows[0].id) });
  })
);

/** Walk-in en 5 segundos: personas + cómo se enteró. Entra directo como "llegó". */
mesaRouter.post(
  '/walkin',
  ah(async (req, res) => {
    const personas = Number(req.body?.personas);
    const como = req.body?.como_se_entero;
    if (!(Number.isInteger(personas) && personas > 0) || !COMO_SE_ENTERO.includes(como)) {
      res.status(400).json({ error: 'datos_incompletos' });
      return;
    }
    const a = ahora();
    const cfg = getConfig().reservations;
    const { rows } = await db.query(
      `INSERT INTO reservas (fecha, hora, personas, turno, canal, como_se_entero, estado, llegada_at)
       VALUES ($1, $2, $3, $4, 'walk-in', $5, 'llego', now())
       RETURNING id`,
      [a.fecha, a.hora, personas, cfg ? turnoDe(a.minutos, cfg) : '', como]
    );
    res.json({ ok: true, id: Number(rows[0].id) });
  })
);

/** Cerrar mesa (fase 1): total capturado a mano. Cerrarla otra vez lo corrige. */
mesaRouter.post(
  '/reservas/:id/consumo',
  ah(async (req, res) => {
    const total = Number(req.body?.total);
    if (!Number.isFinite(total) || total < 0 || total > 1_000_000) {
      res.status(400).json({ error: 'total_invalido' });
      return;
    }
    const { rows } = await db.query(
      `INSERT INTO consumos (reserva_id, total, turno, metodo)
       SELECT id, $2, turno, 'manual' FROM reservas WHERE id = $1
       ON CONFLICT (reserva_id) WHERE reserva_id IS NOT NULL
       DO UPDATE SET total = EXCLUDED.total, actualizado_at = now()
       RETURNING id`,
      [Number(req.params.id), Math.round(total * 100) / 100]
    );
    res.status(rows[0] ? 200 : 404).json({ ok: !!rows[0] });
  })
);

/** ¿El token y el dataset de Meta funcionan? Lee el dataset, no manda eventos. */
mesaRouter.get(
  '/meta/estado',
  ah(async (_req, res) => {
    const r = await verificarMeta().catch((e: Error) => ({ ok: false, detalle: e.message }));
    const waba = await datasetDeLaWaba().catch((e: Error) => ({ ok: false, detalle: e.message }));
    res.json({ ...(r ?? { ok: false, detalle: 'Conversions API sin configurar (faltan META_DATASET_ID y META_CAPI_TOKEN)' }), waba });
  })
);

// ─── Campañas ────────────────────────────────────────────────────────────────

mesaRouter.get(
  '/campanas',
  ah(async (_req, res) => {
    res.json({ campanas: await campanas() });
  })
);

mesaRouter.post(
  '/campanas',
  ah(async (req, res) => {
    const nombre = String(req.body?.nombre ?? '').trim();
    const clave = String(req.body?.palabra_clave ?? '').trim();
    const gasto = Number(req.body?.gasto_mensual ?? 0);
    if (!nombre || !clave || !Number.isFinite(gasto) || gasto < 0) {
      res.status(400).json({ error: 'datos_incompletos', message: 'Nombre, palabra clave y gasto (0 o más).' });
      return;
    }
    const id = Number(req.body?.id);
    const activa = req.body?.activa !== false;
    if (Number.isInteger(id) && id > 0) {
      await db.query(
        `UPDATE campanas SET nombre = $2, palabra_clave = $3, gasto_mensual = $4, activa = $5 WHERE id = $1`,
        [id, nombre, clave, gasto, activa]
      );
    } else {
      await db.query(
        `INSERT INTO campanas (nombre, palabra_clave, gasto_mensual, activa) VALUES ($1, $2, $3, $4)
         ON CONFLICT (nombre) DO UPDATE SET palabra_clave = EXCLUDED.palabra_clave, gasto_mensual = EXCLUDED.gasto_mensual, activa = EXCLUDED.activa`,
        [nombre, clave, gasto, activa]
      );
    }
    res.json({ ok: true, campanas: await campanas() });
  })
);

// ─── Dashboard ───────────────────────────────────────────────────────────────

function promedio(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
}

mesaRouter.get(
  '/resumen',
  ah(async (req, res) => {
    const { desde, hasta } = rango(req);
    // El periodo se cuenta por el día en que ENTRÓ la solicitud, no por el día
    // de la mesa. Las reservas por anuncio casi siempre son para días después
    // ("el domingo"): contadas por `fecha`, la del video de machacado pedida el
    // 05/10 para el 11/10 no aparecía en "7 días" ni en Campañas (06/10/2026).
    // Así cada periodo muestra lo que la pauta de ese periodo generó, y su
    // llegada e ingreso se le suman cuando ocurren.
    const { rows } = await db.query(
      `${SELECT_RESERVAS} WHERE (r.created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2`,
      [desde, hasta, zona()]
    );
    const camps = await campanas();
    const filas = conCampana(rows, camps);
    const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000) + 1;

    const conConsumo = filas.filter((f) => f.estado === 'llego' && f.total !== null);
    const porTurno: Record<string, number[]> = {};
    const porOrigen: Record<string, number[]> = {};
    for (const f of conConsumo) {
      (porTurno[f.turno || 'sin turno'] ??= []).push(f.total as number);
      const origen = f.canal === 'walk-in' ? 'Walk-in' : f.canal === 'telefono' ? 'Teléfono' : f.campana ?? 'Bot, sin campaña';
      (porOrigen[origen] ??= []).push(f.total as number);
    }

    const roas = camps.map((c) => {
      const suyas = filas.filter((f) => f.campana === c.nombre && f.canal === 'bot');
      const ingreso = suyas.reduce((a, f) => a + (f.estado === 'llego' && f.total !== null ? (f.total as number) : 0), 0);
      const gasto = gastoDelPeriodo(c.gasto_mensual, dias);
      return {
        campana: c.nombre,
        solicitudes: suyas.length,
        llegaron: suyas.filter((f) => f.estado === 'llego').length,
        ingreso: Math.round(ingreso * 100) / 100,
        gasto,
        roas: gasto > 0 ? Math.round((ingreso / gasto) * 100) / 100 : null,
      };
    });

    const walkins: Record<string, number> = {};
    for (const f of filas.filter((x) => x.canal === 'walk-in')) {
      walkins[f.como_se_entero ?? 'sin dato'] = (walkins[f.como_se_entero ?? 'sin dato'] ?? 0) + 1;
    }

    // Estado del Purchase a Meta en el periodo (fase 2). "prueba" = mandados con
    // META_TEST_EVENT_CODE: llegan a "Probar eventos" pero no cuentan en campañas.
    const { rows: capi } = await db.query(
      `SELECT count(*) FILTER (WHERE c.capi_enviado_at IS NOT NULL AND NOT COALESCE((c.capi_respuesta->>'prueba')::boolean, false))::int AS enviados,
              count(*) FILTER (WHERE c.capi_enviado_at IS NOT NULL AND COALESCE((c.capi_respuesta->>'prueba')::boolean, false))::int AS prueba,
              count(*) FILTER (WHERE c.capi_enviado_at IS NULL AND c.capi_respuesta ? 'omitido')::int AS sin_telefono,
              count(*) FILTER (WHERE c.capi_enviado_at IS NULL AND c.capi_respuesta ? 'error')::int AS con_error,
              count(*) FILTER (WHERE c.capi_enviado_at IS NULL AND c.capi_respuesta IS NULL)::int AS pendientes,
              count(*) FILTER (WHERE c.capi_enviado_at IS NOT NULL AND r.ctwa_clid IS NOT NULL
                                 AND NOT COALESCE((c.capi_respuesta->>'respaldo_tienda')::boolean, false))::int AS por_clic
         FROM consumos c JOIN reservas r ON r.id = c.reserva_id
        WHERE (r.created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2`,
      [desde, hasta, zona()]
    );

    res.json({
      desde,
      hasta,
      dias,
      meta: capiConfigurado() ? capi[0] : null,
      embudo: embudo(filas),
      ticketPorTurno: Object.entries(porTurno).map(([turno, xs]) => ({ turno, mesas: xs.length, promedio: promedio(xs) })),
      ticketPorOrigen: Object.entries(porOrigen).map(([origen, xs]) => ({ origen, mesas: xs.length, promedio: promedio(xs) })),
      roas,
      walkins,
    });
  })
);

function csv(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

mesaRouter.get(
  '/export.csv',
  ah(async (req, res) => {
    const { desde, hasta } = rango(req);
    const { rows } = await db.query(`${SELECT_RESERVAS} WHERE r.fecha BETWEEN $1 AND $2 ORDER BY r.fecha, r.hora`, [desde, hasta]);
    const filas = conCampana(rows, await campanas());
    const cols = ['id', 'fecha', 'hora', 'turno', 'nombre', 'telefono', 'personas', 'canal', 'campana', 'ad_name', 'ad_id', 'origen_mensaje', 'como_se_entero', 'estado', 'ocasion', 'total'];
    const cuerpo = [cols.join(','), ...filas.map((f) => cols.map((c) => csv((f as Record<string, unknown>)[c])).join(','))].join('\n');
    res
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="epazote-reservas-${desde}_${hasta}.csv"`);
    res.send('﻿' + cuerpo);
  })
);
