import { boss, QUEUE_NAME } from '../queue';
import { MessageJobData, ChatMessage, GhlChannel } from '../types';
import type { Opportunity } from '../services/ghl';
import {
  getClaudeResponse,
  splitMessage,
  AttachmentBlock,
  asegurarPresentacion,
  asegurarDatosBancarios,
  pareceHandoff,
} from '../services/claude';
import {
  sendMessage,
  fetchAsBase64,
  findContactOpportunity,
  createOpportunity,
  moveOpportunityToStage,
  updateContactName,
  updateContactCustomField,
  createNote,
  getContact,
  seedCustomFields,
} from '../services/ghl';
import {
  getFreeSlots,
  createAppointment,
  getCalendarAssignedUser,
  getCalendarSlotMinutes,
  getContactAppointments,
  buscarCitasDelContacto,
  cancelarCita,
  reponerTags,
  zonaDelNegocio,
  FreeSlot,
  CitaFutura,
} from '../services/ghl-calendar';
import { fechaGhlAMs, inicioDelDiaMs } from '../fechas';
import { mensajesDePersona, nuevosParaHistorial } from '../services/atencion-humana';
import { transcribirAudio } from '../services/whisper';
import { incorporarInboundNuevos } from '../services/inbound';
import { db } from '../db/client';
import { getConfig } from '../config';
import { dentroDeHorario, fechaLocalDelSlot } from '../services/horario';
import {
  scheduleFollowUps,
  detectAttendanceConfirmation,
  cancelarFollowUpsPendientes,
} from '../services/follow-up';
import { contactoBloqueadoAsync } from '../blocklist';
import { pareceNombreReal } from '../nombres';
import { validarReserva, mensajeDeOrigen, quitarConfirmacionDeMesa, diceQueRegistro } from '../services/reservas';

/**
 * Estado compartido entre las tools de UN mismo turno (un job del worker).
 *
 * Existe por el reagendamiento: `cancelar_cita` no recibe el id de la cita
 * (a propósito — el modelo podría inventarlo), así que necesita saber cuál
 * de las citas futuras del contacto acaba de crear `agendar_cita` en este
 * mismo turno para NO cancelar esa. Deducirlo por fecha de creación sería
 * frágil; el turno lo sabe con certeza.
 */
interface TurnContext {
  /** Cita creada por agendar_cita en este turno (reagendamiento en curso). */
  citaCreada?: { id: string; nombre: string };
  /**
   * Se prende cuando agendar_cita corrió con `es_reagendamiento: true` y se
   * apaga cuando cancelar_cita cancela la anterior. Si al terminar el turno
   * sigue prendida, el modelo prometió cancelar y no lo hizo: el código lo
   * ejecuta por él (ver enforceReagendamiento y la lección 30 de la skill).
   */
  reagendamientoPendiente?: { citaNuevaId: string; nombre: string };
  /**
   * Cómo se llama la tarjeta del pipeline si hay que CREARLA en este turno
   * (ver findOrCreateOpportunity). El nombre real del contacto o, si no se
   * sabe, su teléfono: con un literal tipo "Nuevo lead" el pipeline queda
   * lleno de tarjetas idénticas que hay que abrir una por una para saber
   * quién es quién.
   */
  leadLabel: string;
  /** Se escaló a una persona en este turno (por el modelo o por el código). */
  escalado?: boolean;
  /** registrar_reserva dejó una solicitud registrada en este turno. */
  reservaRegistrada?: boolean;
  /** Veces que agendar_cita rechazó un horario por no estar libre en este turno. */
  rechazosHorario?: number;
}

// ─── Metadata de la conversación ─────────────────────────────────────────────
// Banderas que tienen que sobrevivir al turno (el contexto del turno muere con
// él — E122): cuándo se escaló por última vez, si el contacto declinó.

async function setMeta(contactId: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .query(
      `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE contact_id = $1`,
      [contactId, JSON.stringify(patch)]
    )
    .catch((e) => console.warn(`[meta] no se pudo guardar ${Object.keys(patch).join(',')}: ${e.message}`));
}

async function getMeta(contactId: string): Promise<Record<string, unknown>> {
  try {
    const r = await db.query(`SELECT metadata FROM conversations WHERE contact_id = $1`, [contactId]);
    return (r.rows[0]?.metadata as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/** ¿Se escaló a este contacto hace menos de `minutos`? */
async function escaladoHaceMenosDe(contactId: string, minutos: number): Promise<boolean> {
  const t = Date.parse(String((await getMeta(contactId)).ultima_escalacion_at ?? ''));
  return !isNaN(t) && Date.now() - t < minutos * 60 * 1000;
}

/**
 * Devuelve las opportunities del contacto en el pipeline y, si no tiene
 * ninguna, **crea una** en la etapa destino.
 *
 * GHL no las crea solo porque alguien escriba por WhatsApp (ver
 * createOpportunity): quien le escribe directo al número, en vez de entrar
 * por el Workflow del anuncio, no tiene tarjeta. Antes de esto el bot daba
 * por hecho que existía y todas las tools del pipeline fallaban con
 * `no_opportunity` para esos contactos.
 *
 * Best-effort: si la creación falla, devuelve lista vacía y el llamador
 * sigue su camino — mover de etapa nunca debe romper la conversación.
 */
async function findOrCreateOpportunity(
  contactId: string,
  pipelineId: string,
  targetStageId: string,
  locationId: string,
  leadLabel: string
): Promise<Opportunity[]> {
  const existing = await findContactOpportunity(contactId, pipelineId, locationId);
  if (existing.length > 0) return existing;

  try {
    const created = await createOpportunity({
      contactId,
      pipelineId,
      pipelineStageId: targetStageId,
      locationId,
      name: leadLabel,
    });
    console.log(
      `[pipeline] opportunity creada automáticamente | contact=${contactId} opp=${created.id} stage=${targetStageId}`
    );
    return [created];
  } catch (err) {
    console.warn(`[pipeline] createOpportunity falló | contact=${contactId}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Handler de tools — recibe el nombre de la tool que Claude llamó y el
 * contactId del mensaje en proceso (pasado via closure). Devuelve un string
 * (típicamente JSON) que Claude verá como tool_result.
 *
 * Por contrato: este handler NUNCA debe lanzar. Si algo falla, retorna un
 * JSON con `error` y un `message` legible para que el modelo decida cómo
 * reaccionar (típicamente "continúa la conversación normalmente").
 */
async function handleTool(
  name: string,
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  switch (name) {
    case 'mover_a_etapa':
      return handleMoverAEtapa(input, contactId, turn);
    case 'consultar_disponibilidad':
      return handleConsultarDisponibilidad(input, contactId);
    case 'agendar_cita':
      return handleAgendarCita(input, contactId, turn);
    case 'cliente_frecuente':
      return handleClienteFrecuente(contactId);
    case 'cancelar_cita':
      return handleCancelarCita(input, contactId, turn);
    case 'escalar_a_humano':
      return handleEscalarAHumano(input, contactId, turn);
    case 'actualizar_campo':
      return handleActualizarCampo(input, contactId);
    case 'cerrar_seguimiento':
      return handleCerrarSeguimiento(input, contactId);
    case 'registrar_reserva':
      return handleRegistrarReserva(input, contactId, turn);
  }
  console.warn(`[tool] No implementada: ${name} input=${JSON.stringify(input)}`);
  return JSON.stringify({ error: 'tool_not_implemented', tool: name });
}

/**
 * Mueve automáticamente la opportunity del contacto a la etapa indicada por
 * NOMBRE (buscada en bot.config.yaml). Llamada desde los handlers cuando
 * ocurre un evento que dispara movimiento (cita agendada, escalación, etc).
 *
 * Best-effort: si falla, sólo loguea — no rompe el flujo del bot.
 */
async function autoMoveStage(contactId: string, stageName: string, leadLabel: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.pipeline) return;

  const stage = cfg.pipeline.stages.find((s) => s.name === stageName);
  if (!stage) {
    console.warn(`[pipeline:auto] stage no configurada: "${stageName}"`);
    return;
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return;

  try {
    const opps = await findOrCreateOpportunity(contactId, cfg.pipeline.id, stage.id, locationId, leadLabel);
    if (opps.length === 0) {
      console.warn(`[pipeline:auto] sin opportunity | contact=${contactId} → "${stageName}" (saltado)`);
      return;
    }
    const chosen = opps.length > 1
      ? [...opps].sort((a, b) => {
          const ka = a.updatedAt ?? a.createdAt ?? '';
          const kb = b.updatedAt ?? b.createdAt ?? '';
          return kb.localeCompare(ka);
        })[0]
      : opps[0];

    if (chosen.pipelineStageId === stage.id) {
      console.log(`[pipeline:auto] ya en "${stageName}" | contact=${contactId}`);
      return;
    }
    await moveOpportunityToStage(chosen.id, stage.id);
    console.log(`[pipeline:auto] movido | contact=${contactId} opp=${chosen.id} → "${stageName}"`);
  } catch (err) {
    console.warn(`[pipeline:auto] error | contact=${contactId} → "${stageName}": ${(err as Error).message}`);
  }
}

// ─── Calendar tools ──────────────────────────────────────────────────────────

/**
 * Determina qué agenda(s) consultar según el motivo y la preferencia explícita.
 * - agenda="any" o ausente → aplica routing por palabras clave del motivo,
 *   luego el default del routing.
 * - agenda="<key>" → solo esa.
 */
function resolveAgendas(motivo: string, agendaParam?: string): string[] {
  const cfg = getConfig();
  if (!cfg.calendars) return [];
  const allKeys = Object.keys(cfg.calendars.agendas);
  const validate = (keys: string[]): string[] =>
    keys.filter((k) => cfg.calendars!.agendas[k]);
  const fromRoute = (route: string | string[]): string[] => {
    if (Array.isArray(route)) return validate(route);
    if (route === 'any') return allKeys;
    return validate([route]);
  };

  if (agendaParam && agendaParam !== 'any' && cfg.calendars.agendas[agendaParam]) {
    return [agendaParam];
  }

  const lower = motivo.toLowerCase();
  for (const [keyword, route] of Object.entries(cfg.calendars.routing)) {
    if (keyword === 'default') continue;
    if (lower.includes(keyword)) {
      const resolved = fromRoute(route);
      if (resolved.length > 0) return resolved;
    }
  }

  const defaultRoute = cfg.calendars.routing.default ?? 'any';
  const resolved = fromRoute(defaultRoute);
  return resolved.length > 0 ? resolved : allKeys;
}

function extractHour(iso: string): number {
  const m = iso.match(/T(\d{2}):/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Fecha y hora legibles. Sirve para los free-slots (traen offset) y para las
 * citas del contacto (NO lo traen: "2026-09-28 10:00:00") — por eso pasa por
 * fechaGhlAMs y no por new Date(), que en el servidor (UTC) las imprimía
 * "a las 4:00 a. m." (E136).
 */
function formatSlotHuman(iso: string, timezone: string): { fecha: string; hora: string } {
  const d = new Date(fechaGhlAMs(iso, timezone));
  const fecha = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  const hora = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return { fecha, hora };
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function resolveDuration(motivo: string): number {
  const cfg = getConfig();
  if (!cfg.calendars) return 30;
  const { durations, duration_minutes } = cfg.calendars;
  if (!durations) return duration_minutes;

  const motivoNorm = normalizar(motivo);
  const match = Object.keys(durations)
    .filter((k) => motivoNorm.includes(normalizar(k)))
    .sort((a, b) => b.length - a.length)[0];

  if (!match) return duration_minutes;
  console.log(`[duracion] motivo="${motivo}" → "${match}" = ${durations[match]} min`);
  return durations[match];
}

/**
 * ¿Cabe una cita de `duracionMin` que empieza en `startMs`, según los
 * free-slots de GHL?
 *
 * Un free-slot a las T solo dice que la CASILLA [T, T + casilla) está libre.
 * Para una cita más larga, también tienen que estar libres las casillas
 * siguientes (T + casilla, T + 2·casilla, …). Si no se conoce la casilla o la
 * rejilla de slots es más gruesa que la casilla (no se puede ver la casilla
 * siguiente), solo se exige el inicio: mejor ofrecer de más que rechazar
 * horarios buenos a ciegas.
 */
export function bloqueLibre(
  slotsDelCalendario: FreeSlot[],
  startMs: number,
  duracionMin: number,
  casillaMin: number | null
): boolean {
  const tiempos = new Set(slotsDelCalendario.map((s) => Math.round(new Date(s.iso).getTime() / 60_000)));
  const inicio = Math.round(startMs / 60_000);
  if (!tiempos.has(inicio)) return false;
  if (!casillaMin || casillaMin >= duracionMin) return true;
  const orden = [...tiempos].sort((a, b) => a - b);
  let rejilla = Infinity;
  for (let i = 1; i < orden.length; i++) rejilla = Math.min(rejilla, orden[i] - orden[i - 1]);
  if (rejilla > casillaMin) return true;
  for (let m = casillaMin; m < duracionMin; m += casillaMin) {
    if (!tiempos.has(inicio + m)) return false;
  }
  return true;
}

async function handleConsultarDisponibilidad(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : undefined;
  const desdeFecha = typeof input.desde_fecha === 'string' ? input.desde_fecha : undefined;
  const horario = typeof input.horario_preferido === 'string' ? input.horario_preferido : 'cualquiera';
  const cantidad = typeof input.cantidad === 'number' && input.cantidad > 0
    ? Math.min(input.cantidad, 10)
    : 4;

  const agendaKeys = resolveAgendas(motivo, agenda);
  if (agendaKeys.length === 0) {
    return JSON.stringify({ error: 'no_agendas_resolved', motivo });
  }

  // Quien pide horarios está (otra vez) interesado: si había declinado, el
  // seguimiento se reactiva (decir "hoy no" no es decir "nunca").
  setMeta(contactId, { declino_at: null }).catch(() => {});

  // Inicio de la búsqueda: medianoche de desde_fecha EN LA ZONA DEL NEGOCIO.
  // Con `new Date("YYYY-MM-DDT00:00:00")` el servidor (UTC) lo leía 5-7 horas
  // antes: "a partir del martes" devolvía el lunes en la tarde (E13). Antes
  // se parchaba descartando después los slots del día anterior; ahora el
  // rango nace bien.
  const tz = cfg.calendars.timezone;
  let startMs = Date.now();
  if (desdeFecha) {
    const t = inicioDelDiaMs(desdeFecha, tz);
    if (isNaN(t)) return JSON.stringify({ error: 'invalid_date', desde_fecha: desdeFecha });
    startMs = Math.max(t, Date.now());
  }

  const duracion = resolveDuration(motivo);

  // Semana por semana, hasta 6, parando en cuanto haya opciones. Antes miraba
  // solo 7 días y, con la agenda apretada, devolvía vacío y dejaba al modelo
  // sin material — que es cuando inventa horarios (E119).
  const SEMANA = 7 * 24 * 60 * 60 * 1000;
  const SEMANAS_MAX = 6;
  let unique: (FreeSlot & { agenda: string })[] = [];
  let consultasOk = 0;
  let semanaEncontrada = 0;
  for (let w = 0; w < SEMANAS_MAX && unique.length === 0; w++) {
    const desde = startMs + w * SEMANA;
    const hasta = desde + SEMANA;
    const allSlots: (FreeSlot & { agenda: string })[] = [];
    const casillas: Record<string, number | null> = {};
    await Promise.all(
      agendaKeys.map(async (key) => {
        const ag = cfg.calendars!.agendas[key];
        try {
          const slots = await getFreeSlots(ag.calendar_id, desde, hasta, tz);
          consultasOk++;
          casillas[key] = await getCalendarSlotMinutes(ag.calendar_id);
          for (const s of slots) allSlots.push({ ...s, agenda: key });
        } catch (err) {
          console.warn(`[tool:consultar_disponibilidad] ${key} error: ${(err as Error).message}`);
        }
      })
    );

    // Filtro 1: horario REAL de atención del negocio (calendars.business_hours).
    // Un slot fuera de horario no existe aunque GHL lo devuelva libre, y la
    // cita tiene que caber completa antes del cierre.
    const enHorario = allSlots.filter((s) => dentroDeHorario(s.iso, cfg.calendars!, duracion));
    if (allSlots.length - enHorario.length > 0) {
      console.log(
        `[tool:consultar_disponibilidad] ${allSlots.length - enHorario.length} slot(s) descartados: ` +
          `fuera de business_hours o sin espacio para ${duracion} min`
      );
    }

    // Filtro 2: el BLOQUE completo de la cita libre, no solo su inicio (E115).
    // Una cita de 60 min en un calendario de casillas de 30 necesita libres
    // la casilla de inicio y la siguiente.
    const porAgenda = new Map<string, FreeSlot[]>();
    for (const sl of allSlots) {
      const arr = porAgenda.get(sl.agenda) ?? [];
      arr.push(sl);
      porAgenda.set(sl.agenda, arr);
    }
    const caben = enHorario.filter((sl) =>
      bloqueLibre(porAgenda.get(sl.agenda) ?? [], new Date(sl.iso).getTime(), duracion, casillas[sl.agenda] ?? null)
    );

    // Filtro 3: horario_preferido (mañana < 12, tarde >= 14, cualquiera = todo).
    const filtered = caben.filter((s) => {
      const h = extractHour(s.iso);
      if (horario === 'mañana') return h < 12;
      if (horario === 'tarde') return h >= 14;
      return true;
    });

    // Orden cronológico, sin duplicados, y opciones separadas por la duración
    // REAL de la cita: ofrecer las 10:00 y las 10:30 para una cita de una hora
    // son dos opciones que no pueden coexistir (E115).
    const seen = new Set<string>();
    const elegidos: (FreeSlot & { agenda: string })[] = [];
    for (const sl of filtered.sort((x, y) => x.iso.localeCompare(y.iso))) {
      if (seen.has(sl.iso)) continue;
      seen.add(sl.iso);
      const t = new Date(sl.iso).getTime();
      const previo = elegidos[elegidos.length - 1];
      if (previo && previo.agenda === sl.agenda && t - new Date(previo.iso).getTime() < duracion * 60_000) continue;
      elegidos.push(sl);
      if (elegidos.length >= cantidad) break;
    }
    unique = elegidos;
    semanaEncontrada = w;
  }

  if (unique.length === 0) {
    // "No hay" y "no se pudo leer la agenda" son cosas distintas: decirle a
    // alguien que no hay lugar cuando se cayó una llamada es mentirle.
    if (consultasOk === 0) {
      console.error(`[tool:consultar_disponibilidad] no se pudo leer la agenda | contact=${contactId}`);
      return JSON.stringify({
        ok: false,
        error: 'agenda_no_disponible',
        message:
          'No se pudo leer la agenda en este momento. NO digas que no hay lugar y NO inventes ningún ' +
          'horario. Dile que en un momento una persona del equipo le confirma los horarios y llama ' +
          'escalar_a_humano (motivo: "no se pudo consultar la agenda").',
      });
    }
    return JSON.stringify({
      ok: true,
      slots: [],
      message:
        `No hay NINGÚN horario libre${horario !== 'cualquiera' ? ` por la ${horario}` : ''} en las próximas ` +
        `${SEMANAS_MAX} semanas. NO inventes horarios: cualquier hora que menciones sin que venga en ` +
        'slots es falsa y no se va a poder agendar. ' +
        (horario !== 'cualquiera'
          ? 'Pregúntale si le sirve otro momento del día y vuelve a consultar con horario_preferido="cualquiera". '
          : 'Dile con calidez que la agenda está llena por ahora y llama escalar_a_humano para que el equipo le busque un espacio.'),
    });
  }

  const formatted = unique.map((s) => {
    const human = formatSlotHuman(s.iso, cfg.calendars!.timezone);
    const ag = cfg.calendars!.agendas[s.agenda];
    return {
      slot_iso: s.iso,
      agenda: s.agenda,
      agenda_nombre: ag.name,
      fecha: human.fecha,
      hora: human.hora,
    };
  });

  console.log(
    `[tool:consultar_disponibilidad] motivo="${motivo}" agendas=[${agendaKeys.join(',')}] returned=${formatted.length}` +
      (semanaEncontrada > 0 ? ` (semana ${semanaEncontrada + 1})` : '')
  );
  return JSON.stringify({
    ok: true,
    slots: formatted,
    ...(semanaEncontrada > 0
      ? { nota: 'Las primeras semanas estaban llenas: estos son los espacios más próximos que hay.' }
      : {}),
    ...(await citasPropiasDelContacto(contactId)),
  });
}

/**
 * Las citas REALES del contacto, ya calculadas contra la hora de ahora, para el
 * contexto del turno.
 *
 * Existe por un caso del 18/09/2026: la paciente tenía cita el viernes 18 a
 * las 9:00, llegó tarde y escribió "Estoy afuera". El bot le contestó "tu cita
 * era para mañana sábado, hoy es viernes" — porque lo único que tenía era el
 * historial, donde el día anterior le había dicho "te esperamos MAÑANA
 * viernes", y lo leyó como si fuera de hoy. El dato ya estaba en GHL; nadie se
 * lo entregaba (E87/E123). Best-effort: si GHL falla, el turno sigue sin esto.
 */
export async function contextoDeCitas( // exportada solo para pruebas
contactId: string): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) return '';
  try {
    const tz = cfg.calendars.timezone;
    const calendarIds = new Set(Object.values(cfg.calendars.agendas).map((a) => a.calendar_id));
    const ahora = Date.now();
    const hoy = fechaLocal(new Date(ahora).toISOString(), tz);
    const citas = (await getContactAppointments(contactId))
      .filter((a) => calendarIds.has(a.calendarId))
      .filter((a) => !(a.appointmentStatus ?? '').toLowerCase().includes('cancel'))
      .map((a) => ({ a, t: fechaGhlAMs(a.startTime, tz) }))
      .filter(({ t }) => !isNaN(t) && t > ahora - 24 * 3600 * 1000)
      .sort((x, y) => x.t - y.t);
    if (citas.length === 0) {
      return '- Citas de este contacto en el calendario: ninguna próxima (ni de hoy).';
    }
    const lineas = citas.map(({ a, t }) => {
      const h = formatSlotHuman(a.startTime, tz);
      const esHoy = fechaLocal(a.startTime, tz) === hoy;
      const min = Math.round((t - ahora) / 60000);
      const cuando =
        min < 0
          ? `era HOY hace ${Math.round(-min / 60) >= 1 ? `${Math.round(-min / 60)} h` : `${-min} min`}`
          : esHoy
            ? `es HOY, en ${min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`}`
            : 'próxima';
      return `  - ${h.fecha} a las ${h.hora} (${cuando}), a nombre de ${(a.title ?? '').split(' - ')[0].trim() || 'el contacto'}`;
    });
    return (
      '- Citas REALES de este contacto según el calendario (esto manda sobre lo que diga el historial, ' +
      'donde "mañana" o "el viernes" se escribieron otro día):\n' +
      lineas.join('\n')
    );
  } catch (err) {
    console.warn(`[worker] contexto de citas falló: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Bloque que se anexa a TODA respuesta de consultar_disponibilidad: las citas
 * que este mismo contacto ya tiene apartadas.
 *
 * Es el guard de auto-conflicto. Sin esto, el horario que el bot acaba de
 * apartarle a un contacto deja de aparecer en `slots` (porque está ocupado)
 * y el modelo concluye que "ya no está disponible" — y se lo retracta al
 * contacto que ya lo tenía confirmado. Pasó el 14/09/2026 a las 22:05: la
 * contacto tenía las 10:00am desde las 20:46 y el bot se las quitó porque
 * él mismo las había ocupado.
 *
 * Best-effort: si GHL falla, se devuelve {} y la disponibilidad sale igual.
 */
async function citasPropiasDelContacto(
  contactId: string
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (!cfg.calendars) return {};

  try {
    const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);
    const propias = await buscarCitasDelContacto(contactId, calendarIds);
    if (propias.length === 0) return {};

    return {
      citas_que_este_contacto_YA_tiene: propias.map((c) => {
        const h = formatSlotHuman(c.startTime, cfg.calendars!.timezone);
        return { fecha: h.fecha, hora: h.hora, a_nombre_de: nombreDelTitulo(c.title) };
      }),
      aviso_importante:
        'Estos horarios NO aparecen en `slots` precisamente porque ya están ocupados ' +
        'POR ESTE MISMO CONTACTO — los apartaste tú. Son suyos. NUNCA le digas que su ' +
        'horario "ya no está disponible" ni le ofrezcas moverse de hora: solo cambia su ' +
        'cita si él lo pide explícitamente. Si el horario que ibas a confirmarle es uno ' +
        'de estos, confírmaselo con toda normalidad.',
    };
  } catch (err) {
    console.warn(`[tool:consultar_disponibilidad] citas propias falló: ${(err as Error).message}`);
    return {};
  }
}

/**
 * ¿`startMs` sigue siendo un horario libre del calendario?
 *   true  → sí está en los free-slots de GHL.
 *   false → GHL respondió y ese horario NO está (ocupado o inexistente).
 *   null  → no se pudo consultar; el caller decide (se crea dejando que GHL
 *           valide por su cuenta).
 */
async function horarioSigueLibre(
  calendarId: string,
  startMs: number,
  tz: string,
  duracionMin: number
): Promise<boolean | null> {
  try {
    const DOCE_H = 12 * 60 * 60 * 1000;
    const slots = await getFreeSlots(calendarId, startMs - DOCE_H, startMs + DOCE_H, tz);
    return bloqueLibre(slots, startMs, duracionMin, await getCalendarSlotMinutes(calendarId));
  } catch (err) {
    console.warn(`[tool:agendar_cita] no se pudo comprobar la agenda: ${(err as Error).message}`);
    return null;
  }
}

async function handleAgendarCita(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const slotIso = typeof input.slot_iso === 'string' ? input.slot_iso : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : '';
  const nombreCompleto = typeof input.nombre_completo === 'string' ? input.nombre_completo.trim() : '';
  const motivo = typeof input.motivo === 'string' ? input.motivo : 'Cita';
  const esReagendamiento = input.es_reagendamiento === true;

  if (!slotIso || !agenda || !nombreCompleto) {
    return JSON.stringify({
      error: 'missing_params',
      message: 'Faltan datos obligatorios: slot_iso, agenda o nombre_completo.',
    });
  }

  const ag = cfg.calendars.agendas[agenda];
  if (!ag) {
    return JSON.stringify({ error: 'invalid_agenda', agenda });
  }

  // Límite de negocio OPCIONAL (calendars.max_active_appointments): si está
  // configurado, la 2da+ cita debe ser a nombre de una persona distinta a la
  // anterior (ej. un familiar agendando desde el mismo número).
  const tz = cfg.calendars.timezone;
  // Con offset se respeta; si el modelo lo mandara sin zona, se lee en la del negocio.
  const startMs = fechaGhlAMs(slotIso, tz);
  if (isNaN(startMs)) {
    return JSON.stringify({ error: 'invalid_slot_iso', slot_iso: slotIso });
  }

  // Las fechas de las citas por contacto vienen SIN zona ("2026-09-28 10:00:00"):
  // fechaGhlAMs, nunca new Date() — en el servidor (UTC) la cita de hoy dejaba
  // de contar como futura desde la madrugada (E142).
  const existentes = await getContactAppointments(contactId);
  const now = Date.now();
  const vivas = existentes.filter((a) => {
    const t = fechaGhlAMs(a.startTime, tz);
    const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
    return !isNaN(t) && t > now && !cancelada;
  });

  // Idempotencia: si este contacto YA tiene una cita viva a esa misma hora, no
  // se crea otra. Pasa cuando el mismo turno se procesa dos veces (reintento
  // del job, dos mensajes seguidos) — sin esto quedaban dos citas iguales.
  const mismaHora = vivas.find((a) => Math.abs(fechaGhlAMs(a.startTime, tz) - startMs) < 60_000);
  if (mismaHora) {
    const h = formatSlotHuman(slotIso, tz);
    console.log(`[tool:agendar_cita] ya existía a esa hora — no se duplica | contact=${contactId} appt=${mismaHora.id}`);
    turn.citaCreada ??= { id: mismaHora.id, nombre: nombreCompleto };
    return JSON.stringify({
      ok: true,
      ya_existia: true,
      appointment_id: mismaHora.id,
      agenda: ag.name,
      fecha_humana: h.fecha,
      hora_humana: h.hora,
      message: 'Esta cita ya estaba creada a esa hora; no se duplicó. Confírmasela normalmente.',
    });
  }

  // Límite de negocio OPCIONAL (calendars.max_active_appointments): si está
  // configurado, la 2da+ cita debe ser a nombre de una persona distinta.
  const maxConfigurado = cfg.calendars.max_active_appointments;
  let activas: Awaited<ReturnType<typeof getContactAppointments>> = [];
  if (maxConfigurado) {
    activas = vivas;

    // En un reagendamiento la cita vieja sigue viva unos segundos (se cancela
    // justo después con cancelar_cita), así que se tolera una cita activa de más.
    const maxActivas = esReagendamiento ? maxConfigurado + 1 : maxConfigurado;
    if (activas.length >= maxActivas) {
      return JSON.stringify({
        error: 'limite_de_citas',
        message:
          `Este contacto ya tiene ${maxConfigurado} cita(s) activa(s) agendada(s) — es el máximo permitido por este medio. ` +
          'Explícale con calidez que ya tiene el máximo de citas apartadas, y que si necesita una adicional debe ' +
          'contactar directamente al negocio.',
      });
    }

    // El guard de nombre duplicado existe para que un contacto no agende dos
    // veces a la misma persona sin darse cuenta. En un reagendamiento SÍ queremos
    // la segunda cita con el mismo nombre (es la misma persona moviéndose de día),
    // así que ahí se salta — sin esto el reagendamiento sería imposible.
    if (activas.length >= 1 && !esReagendamiento) {
      const nombreExistente = (activas[activas.length - 1].title ?? '').split(' - ')[0].trim().toLowerCase();
      if (nombreExistente && nombreExistente === nombreCompleto.toLowerCase()) {
        return JSON.stringify({
          error: 'nombre_duplicado',
          message:
            `Este contacto ya tiene una cita agendada a nombre de "${activas[activas.length - 1].title?.split(' - ')[0]}". ` +
            'Si esta nueva cita es para la MISMA persona, dile que ya tiene una cita agendada y pregúntale ' +
            'si prefiere reagendar esa en vez de crear otra. Si es para una persona DISTINTA (ej. un ' +
            'familiar), pídele el nombre completo de esa otra persona y vuelve a llamar agendar_cita con ese nombre.',
        });
      }
    }
  }

  // endTime = startTime + la duración que corresponda al tipo de cita
  const start = new Date(startMs);

  // Última red de seguridad: aunque consultar_disponibilidad ya filtra por
  // business_hours, el modelo podría llegar aquí con un horario viejo o
  // inventado. Una cita fuera del horario de atención no se crea nunca, y
  // tampoco una que empiece dentro pero termine después del cierre.
  const duracionMinutos = resolveDuration(motivo);
  if (!dentroDeHorario(slotIso, cfg.calendars, duracionMinutos)) {
    const humanFuera = formatSlotHuman(slotIso, cfg.calendars.timezone);
    console.warn(
      `[tool:agendar_cita] BLOQUEADA por business_hours | contact=${contactId} slot=${slotIso}`
    );
    return JSON.stringify({
      error: 'fuera_de_horario',
      message:
        `${humanFuera.fecha} a las ${humanFuera.hora} no sirve para una cita de ${duracionMinutos} minutos: ` +
        'o está fuera del horario de atención, o la cita terminaría después del cierre. ' +
        'No le digas al contacto que el horario "ya se ocupó" (nunca existió): llama consultar_disponibilidad y ' +
        'ofrécele dos horarios reales de los que te devuelva.',
    });
  }

  // El bloque completo TIENE que estar libre en la agenda real, comprobado aquí.
  //
  // Las citas se crean con ignoreFreeSlotValidation (vacuna de E121), así que
  // GHL ya no lo revisa: un horario inventado por el modelo, uno viejo del
  // historial o uno que otro contacto tomó mientras tanto se creaba igual, con
  // dos personas a la misma hora.
  const libre = await horarioSigueLibre(ag.calendar_id, startMs, tz, duracionMinutos);
  if (libre === false) {
    turn.rechazosHorario = (turn.rechazosHorario ?? 0) + 1;
    console.warn(
      `[tool:agendar_cita] horario NO libre — no se crea | contact=${contactId} slot=${slotIso} ` +
        `duracion=${duracionMinutos} (rechazo #${turn.rechazosHorario} del turno)`
    );
    // Dos rechazos en el mismo turno huelen a algo sistemático, no a mala
    // suerte: no se deja al modelo dar vueltas (carrusel de E121).
    if (turn.rechazosHorario >= 2) {
      await handleEscalarAHumano(
        {
          motivo_escalacion:
            `${nombreCompleto} quiere agendar (${motivo}) y dos horarios seguidos salieron ocupados al ` +
            'momento de crear la cita. Revisar la agenda y agendarle a mano.',
        },
        contactId,
        turn
      ).catch(() => {});
      return JSON.stringify({
        error: 'no_se_pudo_agendar',
        message:
          'Tampoco este horario está libre y el equipo ya quedó avisado para agendarle a mano. NO ofrezcas ' +
          'más horarios. Dile en UNA frase cálida que una persona del equipo le confirma su cita por ' +
          'aquí en un momento. No menciones problemas técnicos.',
      });
    }
    return JSON.stringify({
      error: 'horario_no_disponible',
      message:
        'Ese horario NO está libre en la agenda (lo tomó otra persona, o la cita no cabe completa). NO lo ' +
        'agendes ni se lo confirmes. Llama consultar_disponibilidad y dile en una sola línea que ese ' +
        'espacio ya no está, con las 2 opciones reales más cercanas.',
    });
  }

  const end = new Date(startMs + duracionMinutos * 60 * 1000);

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  // Actualiza el nombre del contacto si todavía no tiene uno, o si el que
  // tiene no es un nombre de verdad (ver pareceNombreReal: típicamente los
  // emojis que WhatsApp copia del perfil). Cuando YA hay un nombre humano no
  // se toca, para no pisar la identidad original si una 2da cita es de otra
  // persona (ej. un familiar agendado desde el mismo número de WhatsApp).
  //
  // El guard anterior era `if (!contacto?.firstName)` y NUNCA entraba: GHL
  // llena ese campo con el nombre de perfil de WhatsApp para todos los leads
  // que entran por ahí, así que el nombre real que el contacto dio en la
  // conversación no llegaba jamás a la ficha — ni a las plantillas que la
  // leen.
  try {
    const contacto = await getContact(contactId);
    if (!pareceNombreReal(contacto?.firstName)) {
      await updateContactName(contactId, nombreCompleto);
    }
  } catch (err) {
    console.warn(`[tool:agendar_cita] getContact/updateContactName failed: ${(err as Error).message}`);
  }

  try {
    // GHL exige a quién se asigna la cita cuando se crea con
    // ignoreFreeSlotValidation (ver createAppointment). Se toma del yaml si
    // está, y si no se deduce del propio calendario una sola vez.
    const assignedUserId =
      ag.assigned_user_id ?? (await getCalendarAssignedUser(ag.calendar_id)) ?? undefined;

    const created = await createAppointment({
      calendarId: ag.calendar_id,
      locationId,
      contactId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      title: `${nombreCompleto} - ${motivo}`,
      assignedUserId,
      // Si no pudimos comprobar la agenda (GHL no respondió), que la valide GHL.
      validarEnGhl: libre === null,
    });

    const human = formatSlotHuman(slotIso, cfg.calendars.timezone);

    // Nota informativa para el equipo, con los datos completos de la cita.
    await createNote(
      contactId,
      `📅 Nueva cita agendada por ${cfg.bot.name}\n` +
        `Contacto: ${nombreCompleto}\n` +
        `Motivo: ${motivo}\n` +
        `Agenda: ${ag.name}\n` +
        `Fecha: ${human.fecha} ${human.hora}`
    ).catch((err) => console.warn(`[tool:agendar_cita] note failed: ${(err as Error).message}`));

    // Si hay detail_field_id configurado: campo con el detalle completo,
    // listo para insertar como merge field en un Workflow de notificación
    // al equipo (ej. WhatsApp/push al dueño del negocio).
    if (cfg.calendars.detail_field_id) {
      await updateContactCustomField(
        contactId,
        cfg.calendars.detail_field_id,
        `Contacto: ${nombreCompleto} | Motivo: ${motivo} | Agenda: ${ag.name} | Fecha: ${human.fecha} ${human.hora}`
      ).catch((err) => console.warn(`[tool:agendar_cita] detail_field_id failed: ${(err as Error).message}`));
    }

    // Si hay reminder_date_field_id configurado: SOLO la fecha legible
    // ("martes 8 de septiembre a las 4:00 p. m."), para el merge field de la
    // plantilla de recordatorio que le llega al CONTACTO.
    //
    // Existe porque el Workflow de recordatorio suele dispararse por tag, y en
    // ese contexto los tokens {{appointment.*}} de GHL vienen vacíos: a
    // contactos reales les llegó "te recordamos tu cita mañana  a las .". Este
    // campo no depende del trigger, así que la plantilla siempre tiene la fecha.
    if (cfg.calendars.reminder_date_field_id) {
      await updateContactCustomField(
        contactId,
        cfg.calendars.reminder_date_field_id,
        `${human.fecha.replace(/,/g, '')} a las ${human.hora}`
      ).catch((err) =>
        console.warn(`[tool:agendar_cita] reminder_date_field_id failed: ${(err as Error).message}`)
      );
    }

    // Si hay notify_tag configurado: tag para que un Workflow de GHL
    // notifique al equipo (Internal Notification, no SMS).
    if (cfg.calendars.notify_tag) {
      // Se REPONE (quitar + poner): si el contacto ya traía el tag de una cita
      // anterior, agregarlo no dispara el Workflow y el equipo no se enteraba
      // de la 2da cita ni de un reagendamiento (E151).
      await reponerTags(contactId, [cfg.calendars.notify_tag]).catch((err) =>
        console.warn(`[tool:agendar_cita] notify_tag failed: ${(err as Error).message}`)
      );
    }

    setMeta(contactId, { declino_at: null }).catch(() => {});

    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    if (cfg.calendars.booked_stage) {
      autoMoveStage(contactId, cfg.calendars.booked_stage, turn.leadLabel).catch(() => {});
    }

    // Ya tiene cita — cancela cualquier follow-up/marca-perdido que hubiera
    // quedado pendiente de antes de agendar.
    cancelarFollowUpsPendientes(contactId).catch(() => {});

    // Deja rastro para cancelar_cita en este mismo turno: sin esto no sabría
    // cuál de las citas futuras es la recién creada (y podría cancelarla).
    turn.citaCreada = { id: created.id, nombre: nombreCompleto };

    // El modelo pidió saltarse el guard de nombre duplicado prometiendo que
    // iba a cancelar la cita anterior. Queda anotado: si al cerrar el turno
    // no lo hizo, enforceReagendamiento la cancela por él.
    if (esReagendamiento) {
      turn.reagendamientoPendiente = { citaNuevaId: created.id, nombre: nombreCompleto };
    }

    console.log(
      `[tool:agendar_cita] OK | contact=${contactId} appt=${created.id} agenda=${agenda} ` +
        `${slotIso}${esReagendamiento ? ' (reagendamiento)' : ''}`
    );
    return JSON.stringify({
      ok: true,
      appointment_id: created.id,
      agenda: ag.name,
      fecha_humana: human.fecha,
      hora_humana: human.hora,
    });
  } catch (err) {
    // Aquí NO se le ofrece otro horario, y esa es la lección más cara de
    // este bot.
    //
    // Si la creación falla, la causa casi nunca es ese horario en
    // particular: la disponibilidad ya se verificó justo antes de llegar
    // aquí (dentroDeHorario y bloqueLibre contra los free-slots reales). Lo
    // que falla es la creación EN SÍ, y eso va a volver a fallar con el
    // horario siguiente, y con el siguiente.
    //
    // Fue exactamente lo que pasó: GHL rechazaba toda cita de 45 o 60
    // minutos, el bot lo leía como "se ocupó" y ofrecía otro horario. Seis
    // veces seguidas con la misma paciente, que ya había pagado el anticipo.
    // Cero citas creadas en toda la cuenta.
    //
    // Así que un fallo al crear pasa la conversación a una persona, en
    // código y sin depender del criterio del modelo.
    console.error(
      `[tool:agendar_cita] FALLO AL CREAR — se escala | contact=${contactId} slot=${slotIso} ` +
        `duracion=${duracionMinutos} motivo="${motivo}": ${(err as Error).message}`
    );

    await handleEscalarAHumano(
      {
        motivo_escalacion:
          `No se pudo crear la cita de ${nombreCompleto} (${motivo}) para el ` +
          `${formatSlotHuman(slotIso, cfg.calendars.timezone).fecha} a las ` +
          `${formatSlotHuman(slotIso, cfg.calendars.timezone).hora}. Hay que agendarla a mano y ` +
          `confirmarle al contacto.`,
      },
      contactId,
      turn
    ).catch(() => {});

    return JSON.stringify({
      error: 'no_se_pudo_agendar',
      message:
        'No se pudo crear la cita y el equipo ya quedó avisado para agendarla a mano. ' +
        'NO le ofrezcas otro horario, NO vuelvas a llamar consultar_disponibilidad y NO le digas ' +
        'que ese espacio se ocupó: el horario que eligió sigue siendo el suyo. ' +
        'Contéstale UNA sola frase cálida diciéndole que su cita queda apartada para ese día y esa ' +
        'hora, y que en un momento una persona del equipo se la confirma por aquí. ' +
        'Nunca menciones un problema técnico ni que algo falló.',
    });
  }
}

/**
 * Hace cumplir la promesa de `es_reagendamiento: true`.
 *
 * `agendar_cita` deja crear una 2da cita con el mismo nombre SOLO porque el
 * modelo se comprometió a cancelar la anterior de inmediato con cancelar_cita.
 * Si el turno termina y no lo hizo, esa promesa la ejecuta el código: el
 * contacto no puede quedarse con dos citas el mismo día porque el modelo se
 * distrajo (bug del 14/09/2026).
 *
 * Solo cancela cuando NO hay ambigüedad (una sola cita anterior candidata).
 * Si hay varias, no adivina: deja nota en GHL para que el equipo lo resuelva.
 */
async function enforceReagendamiento(contactId: string, turn: TurnContext): Promise<void> {
  const pendiente = turn.reagendamientoPendiente;
  if (!pendiente) return;

  const cfg = getConfig();
  if (!cfg.calendars) return;

  try {
    const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);
    const futuras = await buscarCitasDelContacto(contactId, calendarIds);
    const anteriores = futuras.filter((c) => c.id !== pendiente.citaNuevaId);

    if (anteriores.length === 0) {
      console.log(`[reagendamiento] nada que cancelar | contact=${contactId}`);
      return;
    }

    // Misma preferencia que handleCancelarCita: las del mismo nombre primero.
    const mismoNombre = anteriores.filter(
      (c) => nombreDelTitulo(c.title) === pendiente.nombre.toLowerCase()
    );
    const candidatas = mismoNombre.length > 0 ? mismoNombre : anteriores;

    if (candidatas.length > 1) {
      console.error(
        `[reagendamiento] INCUMPLIDO y ambiguo (${candidatas.length} citas) | contact=${contactId} — no se cancela nada`
      );
      await createNote(
        contactId,
        `⚠️ Reagendamiento sin cerrar\n` +
          `${cfg.bot.name} agendó una cita nueva como reagendamiento pero no canceló la anterior, ` +
          `y hay ${candidatas.length} citas candidatas. Revisen cuál sobra:\n` +
          candidatas
            .map((c) => {
              const h = formatSlotHuman(c.startTime, cfg.calendars!.timezone);
              return `- ${h.fecha} ${h.hora} (${c.title ?? 'sin título'})`;
            })
            .join('\n')
      ).catch(() => {});
      return;
    }

    const target = candidatas[0];
    await cancelarCita(target.id);
    const h = formatSlotHuman(target.startTime, cfg.calendars.timezone);
    console.warn(
      `[reagendamiento] el modelo no llamó cancelar_cita — cancelada por código | ` +
        `contact=${contactId} appt=${target.id} ${target.startTime}`
    );
    await createNote(
      contactId,
      `❌ Cita anterior cancelada automáticamente\n` +
        `Cita: ${h.fecha} ${h.hora}\n` +
        `Motivo: reagendamiento — ${cfg.bot.name} creó la cita nueva y no cerró la anterior.`
    ).catch(() => {});
  } catch (err) {
    console.error(`[reagendamiento] enforce falló | contact=${contactId}: ${(err as Error).message}`);
  } finally {
    turn.reagendamientoPendiente = undefined;
  }
}

async function handleClienteFrecuente(contactId: string): Promise<string> {
  const appts = await getContactAppointments(contactId);

  // Solo cuentan appointments pasadas (no futuras ni slots bloqueados).
  const now = Date.now();
  const tz = zonaDelNegocio();
  const past = appts.filter((a) => {
    const t = fechaGhlAMs(a.startTime, tz);
    return !isNaN(t) && t < now;
  });

  const lastDate = past
    .map((a) => a.startTime)
    .sort()
    .reverse()[0];

  return JSON.stringify({
    ok: true,
    es_recurrente: past.length > 0,
    total_citas_pasadas: past.length,
    ultima_cita: lastDate ?? null,
  });
}

/** Fecha local (YYYY-MM-DD) de un instante ISO en la timezone del negocio. */
function fechaLocal(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(fechaGhlAMs(iso, timezone)));
}

/** Nombre del contacto tal como lo guarda agendar_cita en el título ("Nombre - motivo"). */
function nombreDelTitulo(title?: string): string {
  return (title ?? '').split(' - ')[0].trim().toLowerCase();
}

function describirCita(c: CitaFutura, timezone: string) {
  const human = formatSlotHuman(c.startTime, timezone);
  return {
    fecha: human.fecha,
    hora: human.hora,
    fecha_cita: fechaLocal(c.startTime, timezone),
    a_nombre_de: c.title?.split(' - ')[0]?.trim() ?? null,
  };
}

/**
 * Cancela una cita futura del contacto — cambio de status a "cancelled" en
 * GHL, nunca borrado del evento (ver `cancelarCita` en ghl-calendar.ts).
 *
 * El modelo NO elige el appointment_id (podría inventarlo). El handler lo
 * resuelve así:
 *
 *   - Sin citas futuras → no_upcoming_appointment.
 *   - REAGENDAMIENTO (agendar_cita corrió en este mismo turno): se excluye la
 *     cita recién creada y se cancela la anterior. Si hay más de una anterior,
 *     se prefiere la que está a nombre de la misma persona que la nueva — el
 *     bot permite 2 citas activas de personas DISTINTAS (ej. un familiar
 *     agendando desde el mismo WhatsApp), y cancelar "la más próxima" a ciegas
 *     le tumbaría la cita al otro contacto.
 *   - CANCELACIÓN SIMPLE con 1 cita futura → esa.
 *   - CANCELACIÓN SIMPLE con 2+ → NO adivina: devuelve la lista con fechas
 *     para que el modelo le pregunte al contacto cuál y vuelva a llamar con
 *     `fecha_cita`.
 *
 * Nunca lanza: todo error sale como JSON con `error` + `message`.
 */
export async function handleCancelarCita(  // exportada solo para pruebas
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendar_not_configured' });
  }

  const timezone = cfg.calendars.timezone;
  const motivo = typeof input.motivo === 'string' ? input.motivo.trim() : '';
  const fechaCita = typeof input.fecha_cita === 'string' ? input.fecha_cita.trim() : '';

  // Solo los calendarios que este bot administra — nunca tocamos citas de
  // otros calendarios de la location.
  const calendarIds = Object.values(cfg.calendars.agendas).map((a) => a.calendar_id);

  const futuras = await buscarCitasDelContacto(contactId, calendarIds);

  if (futuras.length === 0) {
    console.log(`[tool:cancelar_cita] sin citas futuras | contact=${contactId}`);
    return JSON.stringify({
      error: 'no_upcoming_appointment',
      message:
        'El contacto no tiene citas próximas. Díselo con calidez y ofrece agendarle una.',
    });
  }

  let candidatas = futuras;
  let creada: CitaFutura | undefined;

  if (turn.citaCreada) {
    // Reagendamiento: la cita nueva de este turno es intocable.
    creada = futuras.find((c) => c.id === turn.citaCreada!.id);
    const anteriores = futuras.filter((c) => c.id !== turn.citaCreada!.id);

    if (anteriores.length === 0) {
      console.log(`[tool:cancelar_cita] solo existe la cita nueva | contact=${contactId}`);
      return JSON.stringify({
        error: 'no_previous_appointment',
        message:
          'El contacto no tenía otra cita futura además de la que acabas de agendarle, ' +
          'así que no hay nada que cancelar. Confírmale su nueva cita normalmente.',
      });
    }

    const mismoNombre = anteriores.filter(
      (c) => nombreDelTitulo(c.title) === turn.citaCreada!.nombre.toLowerCase()
    );
    candidatas = mismoNombre.length > 0 ? mismoNombre : anteriores;
  } else {
    // Sin contexto del turno, NO se toca ninguna cita creada hace menos de 10
    // minutos. El contexto muere con el turno: si un reagendamiento se procesa
    // dos veces (reintento, dos mensajes seguidos), el segundo turno veía la
    // cita NUEVA como una cualquiera y la cancelaba — el paciente se quedaba
    // con cero citas creyendo que tenía una (E122). Con contexto (arriba) sí se
    // sabe cuál es la nueva y la vieja se cancela aunque también sea reciente.
    const DIEZ_MIN = 10 * 60 * 1000;
    const recientes = candidatas.filter((c) => !isNaN(c.dateAddedMs) && Date.now() - c.dateAddedMs < DIEZ_MIN);
    if (recientes.length > 0) {
      candidatas = candidatas.filter((c) => !recientes.includes(c));
      if (candidatas.length === 0) {
        console.warn(`[tool:cancelar_cita] solo hay citas recién creadas — no se cancela | contact=${contactId}`);
        await handleEscalarAHumano(
          {
            motivo_escalacion:
              'El contacto pidió cancelar una cita que se creó hace unos minutos. Por seguridad el bot no la ' +
              'canceló: confirmar con el contacto y cancelarla a mano si procede.',
          },
          contactId,
          turn
        ).catch(() => {});
        return JSON.stringify({
          error: 'cita_recien_creada',
          message:
            'Su cita se creó hace unos minutos y por seguridad no se cancela automáticamente. Dile con ' +
            'calidez que una persona del equipo le confirma la cancelación por aquí en un momento. ' +
            'NO le digas que ya quedó cancelada.',
        });
      }
    }
  }

  // Desambiguación explícita del modelo (segunda pasada, después de preguntarle
  // al contacto). Una fecha equivocada no cancela nada — no puede alucinar un id.
  if (fechaCita) {
    const porFecha = candidatas.filter((c) => fechaLocal(c.startTime, timezone) === fechaCita);
    if (porFecha.length === 0) {
      return JSON.stringify({
        error: 'no_match',
        message: `Ninguna cita próxima del contacto cae en ${fechaCita}. Revisa las opciones y vuelve a intentar.`,
        citas: candidatas.map((c) => describirCita(c, timezone)),
      });
    }
    candidatas = porFecha;
  }

  if (candidatas.length > 1) {
    console.log(
      `[tool:cancelar_cita] ambigua (${candidatas.length} citas) | contact=${contactId}`
    );
    return JSON.stringify({
      error: 'multiple_appointments',
      message:
        'El contacto tiene más de una cita próxima y no queda claro cuál cancelar. ' +
        'Pregúntale con calidez cuál de estas quiere cancelar y vuelve a llamar ' +
        'cancelar_cita con el fecha_cita correspondiente. No canceles ninguna por tu cuenta.',
      citas: candidatas.map((c) => describirCita(c, timezone)),
    });
  }

  const target = candidatas[0];
  const desc = describirCita(target, timezone);

  try {
    await cancelarCita(target.id);
    // Promesa cumplida: ya no hace falta que el código cancele nada.
    turn.reagendamientoPendiente = undefined;
  } catch (err) {
    console.error(`[tool:cancelar_cita] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message:
        'No se pudo cancelar. Dile al contacto que el equipo lo hará manualmente y no se preocupe.',
    });
  }

  // Si NO fue reagendamiento, la fecha del recordatorio ya no aplica: se limpia
  // para que ninguna plantilla salga con una cita que ya no existe. En un
  // reagendamiento no se toca — agendar_cita ya escribió la fecha nueva.
  if (!creada && cfg.calendars?.reminder_date_field_id) {
    await updateContactCustomField(contactId, cfg.calendars.reminder_date_field_id, '').catch((err) =>
      console.warn(`[tool:cancelar_cita] reminder_date_field_id failed: ${(err as Error).message}`)
    );
  }

  // Nota para el equipo (best-effort — que falle no invalida la cancelación).
  await createNote(
    contactId,
    `❌ Cita cancelada por ${cfg.bot.name}\n` +
      `Cita: ${desc.fecha} ${desc.hora}${desc.a_nombre_de ? ` (${desc.a_nombre_de})` : ''}\n` +
      `Motivo: ${motivo || 'no especificado'}` +
      (creada
        ? `\nReagendada a: ${formatSlotHuman(creada.startTime, timezone).fecha} ` +
          `${formatSlotHuman(creada.startTime, timezone).hora}`
        : '')
  ).catch((err) => console.warn(`[tool:cancelar_cita] note failed: ${(err as Error).message}`));

  console.log(
    `[tool:cancelar_cita] OK | contact=${contactId} appt=${target.id} ${target.startTime}` +
      (creada ? ` (reagendada a ${creada.startTime})` : '')
  );

  const kept = creada ?? null;
  return JSON.stringify({
    ok: true,
    cancelled_start: target.startTime,
    cancelled_fecha: desc.fecha,
    cancelled_hora: desc.hora,
    ...(kept
      ? {
          kept_start: kept.startTime,
          kept_fecha: formatSlotHuman(kept.startTime, timezone).fecha,
          kept_hora: formatSlotHuman(kept.startTime, timezone).hora,
        }
      : {}),
    message: kept
      ? 'Cita anterior cancelada. Confírmale al contacto en UN solo mensaje la nueva fecha y que la anterior quedó cancelada.'
      : 'Cita cancelada. Confírmaselo con calidez y déjale la puerta abierta para retomarla.',
  });
}

async function handleEscalarAHumano(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.escalation) {
    return JSON.stringify({ error: 'escalation_not_configured' });
  }

  const motivoEscalacion = typeof input.motivo_escalacion === 'string'
    ? input.motivo_escalacion
    : 'sin motivo especificado';

  try {
    // Se REPONE el tag para que el Workflow "Requiere Humano" dispare también
    // la 2da vez (E151): sin esto, el comprobante de pago de alguien que ya
    // había escalado antes no le llegaba a nadie. Pero si ya se escaló hace
    // unos minutos, no se vuelve a notificar: bastan la nota y la etapa.
    const reciente = await escaladoHaceMenosDe(contactId, 10);
    if (!reciente) await reponerTags(contactId, [cfg.escalation.tag]);
    await setMeta(contactId, { ultima_escalacion_at: new Date().toISOString() });
    turn.escalado = true;
    await createNote(
      contactId,
      `[ESCALACIÓN AUTOMÁTICA] El bot identificó que este contacto necesita atención humana. Motivo: ${motivoEscalacion}`
    );
    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    if (cfg.escalation.stage) {
      autoMoveStage(contactId, cfg.escalation.stage, turn.leadLabel).catch(() => {});
    }
    // Ya lo tiene un humano — cancela follow-ups/marca-perdido pendientes.
    cancelarFollowUpsPendientes(contactId).catch(() => {});
    console.log(`[tool:escalar_a_humano] OK | contact=${contactId} motivo="${motivoEscalacion}"`);
    return JSON.stringify({ ok: true });
  } catch (err) {
    console.error(`[tool:escalar_a_humano] error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo notificar al equipo automáticamente. Continúa la conversación con calidez.',
    });
  }
}

/**
 * El contacto dijo que no ("no gracias", "por ahora no"): se apagan los
 * follow-ups pendientes y se deja una bandera para no programar más.
 *
 * Antes la lista de "conversación cerrada" solo tenía finales del NEGOCIO
 * (agendó, escaló, canceló) y responder reseteaba la cadencia: el "No gracias"
 * arrancaba una tanda nueva y a las 3 horas le volvía a escribir (E137). La
 * bandera se borra sola si vuelve a pedir horarios o agenda.
 *
 * Lo decide el modelo y no un regex: "no gracias" es un rechazo, "no gracias,
 * mejor el martes" no lo es.
 */
async function handleCerrarSeguimiento(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  await setMeta(contactId, { declino_at: new Date().toISOString() });
  await cancelarFollowUpsPendientes(contactId);
  console.log(`[tool:cerrar_seguimiento] OK | contact=${contactId} motivo="${motivo}"`);
  return JSON.stringify({
    ok: true,
    message: 'Listo, no se le mandarán más seguimientos. Despídete con calidez, sin insistir.',
  });
}

/**
 * Manda la reserva a la Mesa de Control de Epazote (Supabase). No bloquea ni
 * cambia lo que se le dice al contacto: la fuente de verdad del registro es
 * GHL, y si este POST falla queda en logs con `[mesa-control]`.
 */
async function enviarAMesaDeControl(url: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': process.env.MESA_CONTROL_SECRET ?? '',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`[mesa-control] OK | contact=${payload.contacto_ghl_id}`);
}

/**
 * Registra una SOLICITUD de reserva (bloque `reservations:`): custom fields +
 * tag de notificación + nota. No hay calendario, así que el bot nunca sabe si
 * hay mesa; la confirma una persona del equipo por el mismo chat. Por eso el
 * tool_result le recuerda al modelo, justo al momento de contestar, que no la
 * dé por confirmada.
 */
async function handleRegistrarReserva(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  const res = cfg.reservations;
  if (!res) return JSON.stringify({ error: 'reservations_not_configured' });

  const solicitud = {
    nombre: typeof input.nombre === 'string' ? input.nombre : '',
    fecha: typeof input.fecha === 'string' ? input.fecha.trim() : '',
    hora: typeof input.hora === 'string' ? input.hora.trim() : '',
    personas: typeof input.personas === 'number' ? input.personas : parseInt(String(input.personas ?? ''), 10),
    ocasion: typeof input.ocasion === 'string' ? input.ocasion : '',
  };

  const v = validarReserva(solicitud, res);
  if (!v.ok) {
    console.log(`[tool:registrar_reserva] rechazada | contact=${contactId} error=${v.error} input=${JSON.stringify(solicitud)}`);
    return JSON.stringify({ error: v.error, message: v.message });
  }

  // La misma solicitud dos veces (el modelo repite la tool, el job se
  // reintenta) no vuelve a notificar al equipo: dos avisos de una sola reserva
  // hacen que Mony confirme dos mesas (E60 de errores-bot). Un cambio real trae
  // otro resumen y sí pasa.
  const meta = await getMeta(contactId);
  const previaAt = Date.parse(String(meta.reserva_registrada_at ?? ''));
  if (meta.reserva_resumen === v.resumen && !isNaN(previaAt) && Date.now() - previaAt < 30 * 60 * 1000) {
    turn.reservaRegistrada = true;
    console.log(`[tool:registrar_reserva] ya estaba registrada, no se repite | contact=${contactId}`);
    return JSON.stringify({
      ok: true,
      ya_estaba_registrada: true,
      resumen: v.resumen,
      aviso_importante: 'Esta solicitud YA estaba registrada y el equipo ya tiene el aviso. No la confirmes: el equipo le confirma por aquí.',
    });
  }

  const nombre = solicitud.nombre.trim().replace(/\s+/g, ' ');
  let telefono = '';
  try {
    const contacto = await getContact(contactId);
    telefono = contacto?.phone ?? '';
    if (!pareceNombreReal(contacto?.firstName)) await updateContactName(contactId, nombre);
  } catch (err) {
    console.warn(`[tool:registrar_reserva] getContact/updateContactName failed: ${(err as Error).message}`);
  }

  // Origen de campaña: el mensaje con el que abrió la sesión (texto
  // precargado del wa.link del creativo). Best-effort.
  let origen = '';
  try {
    const r = await db.query(`SELECT messages, phone FROM conversations WHERE contact_id = $1`, [contactId]);
    origen = mensajeDeOrigen((r.rows[0]?.messages as ChatMessage[]) ?? []);
    telefono = telefono || r.rows[0]?.phone || '';
  } catch (err) {
    console.warn(`[tool:registrar_reserva] no se pudo leer el origen: ${(err as Error).message}`);
  }

  try {
    // Todos los campos ANTES del tag: el Workflow dispara con el tag y lee el
    // resumen como merge field; si el tag llega primero, la notificación sale
    // con el resumen de la reserva anterior (o vacío).
    await updateContactCustomField(contactId, res.fields.fecha, v.fechaLarga);
    if (res.fields.fecha_dia) await updateContactCustomField(contactId, res.fields.fecha_dia, solicitud.fecha);
    await updateContactCustomField(contactId, res.fields.hora, v.horaLegible);
    await updateContactCustomField(contactId, res.fields.personas, String(solicitud.personas));
    // Un espacio y no "": GHL no guarda strings vacíos (ver seedCustomFields).
    await updateContactCustomField(contactId, res.fields.ocasion, solicitud.ocasion.trim() || ' ');
    await updateContactCustomField(contactId, res.fields.resumen, v.resumen);
    if (res.fields.origen) await updateContactCustomField(contactId, res.fields.origen, origen || ' ');
    // Se REPONE para que el Workflow dispare también con la 2da reserva.
    await reponerTags(contactId, [res.notify_tag]);
  } catch (err) {
    console.error(`[tool:registrar_reserva] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message:
        'No se pudo registrar la solicitud en el sistema. NO le digas que quedó registrada. ' +
        (cfg.escalation
          ? 'Usa escalar_a_humano con el detalle de la reserva y dile que una persona del equipo le escribe por aquí para tomarla.'
          : 'Dile que una persona del equipo le escribe por aquí para tomarla.'),
    });
  }

  createNote(contactId, `[SOLICITUD DE RESERVA] ${v.resumen}. Pendiente de confirmar con el contacto por WhatsApp.`).catch(
    (err) => console.warn(`[tool:registrar_reserva] nota falló: ${(err as Error).message}`)
  );
  if (res.stage) autoMoveStage(contactId, res.stage, turn.leadLabel).catch(() => {});
  if (res.mesa_control_url) {
    enviarAMesaDeControl(res.mesa_control_url, {
      contacto_ghl_id: contactId,
      nombre,
      telefono,
      fecha: solicitud.fecha,
      hora: solicitud.hora,
      personas: solicitud.personas,
      ocasion: solicitud.ocasion.trim(),
      turno: v.turno,
      origen_mensaje: origen,
      canal: 'bot',
      resumen: v.resumen,
      registrada_at: new Date().toISOString(),
    }).catch((err) => console.error(`[mesa-control] POST falló | contact=${contactId}: ${(err as Error).message}`));
  }
  await setMeta(contactId, { reserva_registrada_at: new Date().toISOString(), reserva_resumen: v.resumen, declino_at: null });
  cancelarFollowUpsPendientes(contactId).catch(() => {});
  turn.reservaRegistrada = true;

  console.log(`[tool:registrar_reserva] OK | contact=${contactId} resumen="${v.resumen}"`);
  return JSON.stringify({
    ok: true,
    resumen: v.resumen,
    aviso_importante:
      'La solicitud quedó REGISTRADA, NO confirmada. Nadie ha revisado todavía si hay lugar. ' +
      'Cierra con el guion de registro de <flujo_de_cierre>: di que ya registraste la solicitud con el resumen ' +
      'y que en un momento el equipo le confirma por aquí mismo. Nunca digas "confirmada", "te esperamos", ' +
      '"tu mesa está lista" ni nada que suene a confirmación.',
  });
}

/**
 * Guarda un valor en un campo personalizado del contacto.
 *
 * Defensas:
 *   - El SDK ya validó que `campo` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si cambió en runtime.
 *   - Best-effort: si la API de GHL falla, el modelo recibe un error string
 *     y sigue conversando sin mencionarlo.
 */
async function handleActualizarCampo(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.custom_fields) {
    // Defensa: la tool no debería estar registrada si no hay custom_fields.
    return JSON.stringify({ error: 'custom_fields_not_configured' });
  }

  const campo = typeof input.campo === 'string' ? input.campo : '';
  const valor = typeof input.valor === 'string' ? input.valor.trim() : '';

  const field = cfg.custom_fields.fields.find((f) => f.name === campo);
  if (!field) {
    console.warn(`[tool:actualizar_campo] campo inválido: "${campo}"`);
    return JSON.stringify({
      error: 'invalid_field',
      message: `Campo "${campo}" no existe. Válidos: ${cfg.custom_fields.fields.map((f) => f.name).join(', ')}`,
    });
  }
  if (!valor) {
    return JSON.stringify({ error: 'empty_value', message: 'El valor no puede estar vacío.' });
  }

  try {
    await updateContactCustomField(contactId, field.id, valor);
    console.log(`[tool:actualizar_campo] OK | contact=${contactId} campo="${campo}" valor="${valor.slice(0, 60)}"`);
    return JSON.stringify({ ok: true, campo, valor });
  } catch (err) {
    console.error(`[tool:actualizar_campo] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo guardar el campo. Continúa la conversación normalmente.',
    });
  }
}

/**
 * Mueve la opportunity activa del contacto a la etapa que pidió el modelo.
 *
 * Defensas:
 *   - El SDK ya validó que `etapa` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si el yaml cambió en runtime.
 *   - Si no hay opportunity en el pipeline, devolvemos un error que le dice
 *     al modelo que siga conversando sin mencionarlo.
 *   - Idempotencia: si la opp ya está en la etapa target, no llamamos PUT.
 *   - Si hay múltiples opportunities en el pipeline (raro), movemos la más
 *     reciente y logueamos warning con todos los IDs.
 */
async function handleMoverAEtapa(
  input: Record<string, unknown>,
  contactId: string,
  turn: TurnContext
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.pipeline) {
    // Defensa: la tool no debería estar registrada si no hay pipeline.
    return JSON.stringify({ error: 'pipeline_not_configured' });
  }

  const etapa = typeof input.etapa === 'string' ? input.etapa : '';
  const target = cfg.pipeline.stages.find((s) => s.name === etapa);
  if (!target) {
    console.warn(`[tool:mover_a_etapa] etapa inválida: "${etapa}"`);
    return JSON.stringify({
      error: 'invalid_stage',
      message: `Etapa "${etapa}" no existe. Válidas: ${cfg.pipeline.stages.map((s) => s.name).join(', ')}`,
    });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    console.error('[tool:mover_a_etapa] falta GHL_LOCATION_ID en env');
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  const opps = await findOrCreateOpportunity(contactId, cfg.pipeline.id, target.id, locationId, turn.leadLabel);

  if (opps.length === 0) {
    console.warn(`[tool:mover_a_etapa] sin opportunity | contact=${contactId} pipeline=${cfg.pipeline.id}`);
    return JSON.stringify({
      error: 'no_opportunity',
      message:
        `El contacto no tiene oportunidad activa en el pipeline "${cfg.pipeline.name}". ` +
        `Continúa la conversación normalmente sin mencionar este error.`,
    });
  }

  let chosen = opps[0];
  if (opps.length > 1) {
    chosen = [...opps].sort((a, b) => {
      const ka = a.updatedAt ?? a.createdAt ?? '';
      const kb = b.updatedAt ?? b.createdAt ?? '';
      return kb.localeCompare(ka);
    })[0];
    console.warn(
      `[tool:mover_a_etapa] múltiples opps (${opps.length}) | contact=${contactId} ` +
        `ids=[${opps.map((o) => o.id).join(',')}] usando más reciente=${chosen.id}`
    );
  }

  if (chosen.pipelineStageId === target.id) {
    console.log(`[tool:mover_a_etapa] ya en "${target.name}" | opp=${chosen.id}`);
    return JSON.stringify({ ok: true, already_in_stage: true, stage: target.name });
  }

  // Nunca mover hacia atrás a una etapa MANUAL (las que el modelo puede
  // elegir libremente) a un contacto que ya está en una etapa AUTO (las que
  // solo mueve el código, ej. al agendar o escalar — `when: "AUTO: ..."` en
  // bot.config.yaml). Evita que el bot "retroceda" el pipeline solo porque
  // el contacto le sigue escribiendo después de haber cerrado el ciclo.
  const etapaActual = cfg.pipeline.stages.find((s) => s.id === chosen.pipelineStageId);
  const esAuto = (s?: { when: string }) => s?.when.trim().toUpperCase().startsWith('AUTO');
  if (esAuto(etapaActual) && !esAuto(target)) {
    console.log(
      `[tool:mover_a_etapa] bloqueado regreso a etapa manual | contact=${contactId} etapa_actual="${etapaActual!.name}" target="${target.name}"`
    );
    return JSON.stringify({
      ok: true,
      blocked: true,
      message: `El contacto ya está en "${etapaActual!.name}" (etapa automática), no se mueve hacia atrás a "${target.name}". Continúa la conversación normalmente sin mencionar esto.`,
    });
  }

  try {
    await moveOpportunityToStage(chosen.id, target.id);
    console.log(
      `[tool:mover_a_etapa] OK | contact=${contactId} opp=${chosen.id} ` +
        `from=${chosen.pipelineStageId} to=${target.id} (${target.name})`
    );
    return JSON.stringify({ ok: true, moved_to: target.name });
  } catch (err) {
    console.error(`[tool:mover_a_etapa] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo mover la oportunidad. Continúa la conversación normalmente.',
    });
  }
}

export async function startMessageWorker(concurrency = 5) {
  await boss.work<MessageJobData>(
    QUEUE_NAME,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      const { contactId, phone, contactName, message, channel } = job.data;

      // Blocklist (ver src/blocklist.ts). El webhook ya filtra el entrante,
      // pero un job pudo quedar encolado antes del bloqueo: se descarta aquí,
      // limpiando el pendiente para que no lo reviva un reintento.
      if (await contactoBloqueadoAsync(contactId, phone)) {
        await db.query(
          `UPDATE conversations
           SET pending_message = NULL, pending_at = NULL, pending_attachments = '[]'::jsonb
           WHERE contact_id = $1`,
          [contactId]
        ).catch(() => {});
        await cancelarFollowUpsPendientes(contactId).catch(() => {});
        console.log(`[worker] Bloqueado — contacto en blocklist | contact=${contactId}`);
        return;
      }

      console.log(`[worker] Processing | contact=${contactId} channel=${channel ?? 'unknown'}`);

      // 0.5. Última pasada por GHL antes de armar el turno (E144).
      //
      // El webhook recupera la ráfaga que GHL no avisó, pero solo lo que
      // existía cuando ESE webhook entró. Si la paciente siguió escribiendo
      // durante el debounce, preguntar aquí es lo que hace que el modelo vea
      // el mensaje COMPLETO en un solo turno, en vez de contestar a medias.
      // Va antes del claim: lo que se incorpore entra al pending y el claim de
      // abajo se lo lleva junto con el resto.
      try {
        const rec = await incorporarInboundNuevos(contactId, { phone, contactName, channel });
        if (rec.incorporados.length > 0) {
          console.warn(
            `[worker] ${rec.incorporados.length} mensaje(s) que el webhook no entregó, ` +
              `recuperados antes del turno | contact=${contactId}`
          );
        }
      } catch (e) {
        // GHL no contesta: se sigue con lo que ya hay. Contestar con parte del
        // mensaje es malo, no contestar es peor; el barrido recupera el resto.
        console.warn(`[worker] no se pudo reconciliar con GHL antes del turno: ${(e as Error).message}`);
      }

      // 1. Claim atómico del mensaje pendiente — previene race condition
      // entre reintentos. Usa CTE para capturar el valor antes de limpiarlo.
      const claimResult = await db.query(
        `WITH claimed AS (
           SELECT id, messages, pending_message, pending_attachments, metadata
           FROM conversations WHERE contact_id = $1
         )
         UPDATE conversations c
         SET pending_message = NULL, pending_at = NULL,
             pending_attachments = '[]'::jsonb
         FROM claimed
         WHERE c.id = claimed.id
         RETURNING claimed.id, claimed.messages, claimed.pending_message,
                   claimed.pending_attachments, claimed.metadata`,
        [contactId]
      );

      let conversation = claimResult.rows[0];

      if (!conversation) {
        const inserted = await db.query(
          `INSERT INTO conversations (contact_id, phone, contact_name, messages)
           VALUES ($1, $2, $3, '[]'::jsonb)
           RETURNING id, messages, pending_message, metadata`,
          [contactId, phone, contactName ?? null]
        );
        conversation = inserted.rows[0];

        // Conversación nueva: se siembran los campos personalizados que el
        // contacto no tenga, para que las notificaciones internas y las
        // plantillas de GHL nunca salgan con el merge field en crudo si el
        // contacto no alcanzó a contestar ese dato (ver seedCustomFields).
        const campos = getConfig().custom_fields?.fields.map((f) => f.id) ?? [];
        await seedCustomFields(contactId, campos);
      }

      const messageToProcess = conversation.pending_message ?? message;
      if (!messageToProcess) {
        console.log(`[worker] Skipped duplicate | contact=${contactId}`);
        return;
      }

      const history: ChatMessage[] = conversation.messages ?? [];

      // 2. Procesar attachments pendientes
      // - Imágenes y PDFs van como bloques a Claude Vision
      // - Audios se transcriben con Whisper y reemplazan el placeholder
      const pendingAttachments = (conversation.pending_attachments ?? []) as Array<{ url: string; kind: string }>;
      const attachmentBlocks: AttachmentBlock[] = [];
      let messageForClaude = messageToProcess;

      for (const att of pendingAttachments) {
        const data = await fetchAsBase64(att.url);
        if (!data) continue;

        if (att.kind === 'image' || att.kind === 'pdf') {
          attachmentBlocks.push({
            kind: att.kind,
            base64: data.base64,
            mimeType: data.mimeType,
          });
        } else if (att.kind === 'audio') {
          const ext = att.url.split('?')[0].split('.').pop()?.toLowerCase() ?? 'ogg';
          const transcripcion = await transcribirAudio({
            base64: data.base64,
            mimeType: data.mimeType,
            ext,
          });
          if (transcripcion) {
            const placeholder = '[el contacto envió un audio]';
            const replacement = `[audio transcrito]: ${transcripcion}`;
            if (messageForClaude.includes(placeholder)) {
              messageForClaude = messageForClaude.replace(placeholder, replacement);
            } else {
              messageForClaude += `\n${replacement}`;
            }
            console.log(`[whisper] transcrito (${transcripcion.length} chars): ${transcripcion.slice(0, 80)}`);
          } else {
            console.warn('[worker] No se pudo transcribir audio');
          }
        }
      }

      // 2.5 ¿Hay una persona del consultorio atendiendo? Entonces el bot NO
      // contesta (E85/E134). El mensaje del contacto no se tira: se guarda, junto
      // con lo que escribió la persona (marcado como suyo), para que el bot
      // tenga el contexto completo cuando vuelva a hablar.
      //
      // Falla ABIERTO: si GHL no responde, el bot contesta. Callar por un
      // timeout deja al paciente hablando solo.
      let humanos: Awaited<ReturnType<typeof mensajesDePersona>> = [];
      try {
        humanos = await mensajesDePersona(contactId, history, zonaDelNegocio());
      } catch (e) {
        console.warn(`[worker] no se pudo revisar si atiende una persona (se contesta): ${(e as Error).message}`);
      }
      if (humanos.length > 0) {
        const ahora = new Date().toISOString();
        const guardados: ChatMessage[] = [
          ...history,
          ...nuevosParaHistorial(humanos, history),
          { role: 'user' as const, content: messageForClaude, ts: ahora },
        ].slice(-100);
        await db.query(
          `UPDATE conversations SET messages = $1::jsonb, last_activity = now() WHERE id = $2`,
          [JSON.stringify(guardados), conversation.id]
        );
        await cancelarFollowUpsPendientes(contactId);
        console.log(
          `[worker] una persona está atendiendo (último mensaje a mano ${humanos[humanos.length - 1].ts}) — el bot no contesta | contact=${contactId}`
        );
        return;
      }

      // 3. Llamar a Claude
      // El contactId se pasa al handler via closure — lo necesitan las tools
      // para saber a qué contacto pertenece la opportunity/cita.
      //
      // El canal del entrante viene del job; si falta (jobs viejos), cae al
      // metadata.channel persistido por el webhook, y por último a WhatsApp.
      //
      // Si Claude falla (ej. error de red), restauramos el pending_message
      // que ya habíamos claimeado y propagamos el error para que pg-boss
      // reintente el job — así el mensaje NO se pierde.
      const metaChannel =
        (conversation.metadata as { channel?: string } | null)?.channel as GhlChannel | undefined;
      const inboundChannel: GhlChannel = channel ?? metaChannel ?? 'WhatsApp';

      let replyText: string;
      let toolCalls: Array<{ toolName: string; output: string }>;
      let cortado = false;
      let abre = false;
      // Estado compartido entre las tools de este turno (ver TurnContext).
      // El label es para la tarjeta del pipeline si hay que crearla: nombre
      // real del contacto, si no el teléfono. Nunca un literal fijo.
      const turn: TurnContext = { leadLabel: contactName || phone || contactId };
      try {
        const result = await getClaudeResponse(
          history,
          messageForClaude,
          async (toolName, input) => handleTool(toolName, input, contactId, turn),
          inboundChannel,
          attachmentBlocks,
          await contextoDeCitas(contactId)
        );
        replyText = result.text;
        toolCalls = result.toolCalls;
        cortado = result.cortado;
        abre = result.abre;

        // E118: los cortes (max_tokens, refusal) ya los maneja getClaudeResponse:
        // reintenta UNA vez y, si vuelve a cortarse, tira el pedazo y marca
        // `cortado`. La línea neutral y la escalación van en el paso 3.6. (Aquí
        // había un manejo propio que escalaba con el parámetro `motivo` en vez
        // de `motivo_escalacion`, así que el aviso llegaba "sin motivo".)
      } catch (err) {
        console.error(`[worker] Claude falló, restaurando pending y reintentando | contact=${contactId}: ${(err as Error).message}`);
        await db.query(
          `UPDATE conversations
           SET pending_message = CASE
                 WHEN pending_message IS NULL OR pending_message = '' THEN $2
                 ELSE $2 || E'\\n' || pending_message
               END,
               pending_at = now()
           WHERE id = $1`,
          [conversation.id, messageToProcess]
        ).catch((e) => console.error(`[worker] restore pending falló: ${e.message}`));
        throw err; // pg-boss reintenta (retryLimit)
      }

      // 3.5 Hacer cumplir la promesa de es_reagendamiento antes de contestar:
      // si el modelo creó la cita nueva y no canceló la anterior, se cancela
      // acá. Va antes del envío para que el contacto nunca vea confirmada una
      // cita que dejó dos horarios ocupados.
      await enforceReagendamiento(contactId, turn);

      // 3.6 Nunca silencio, nunca media frase.
      // Si la respuesta quedó vacía (el filtro se comió todo, el modelo cerró
      // solo con tools) o se cortó, el paciente recibe una línea neutral y la
      // conversación pasa a una persona. Antes: silencio después de prometer
      // algo (E131), o "...un anticipo de $500 por persona, que se le" (E118).
      const neutral = turn.escalado
        ? 'Listo, ya le pasé tu mensaje al equipo y en un momento te escriben por aquí 😊'
        : 'Gracias por tu mensaje 😊 En un momento una persona del equipo te confirma por aquí.';
      if (!replyText.trim() || cortado) {
        console.warn(
          `[worker] respuesta ${cortado ? 'cortada' : 'vacía'} — se manda línea neutral y se escala | contact=${contactId}`
        );
        replyText = replyText.trim() ? `${replyText.trim()}\n\n${neutral}` : neutral;
        if (!turn.escalado) {
          await handleEscalarAHumano(
            {
              motivo_escalacion: cortado
                ? 'La respuesta del bot se cortó y no se pudo completar. Revisar la conversación y contestar a mano.'
                : 'El bot no generó una respuesta que se pudiera mandar. Revisar la conversación y contestar a mano.',
            },
            contactId,
            turn
          ).catch(() => {});
        }
      } else if (!turn.escalado && pareceHandoff(replyText)) {
        // Le dice que ya avisó a una persona y no escaló: si no se escala aquí,
        // espera a alguien que nunca fue notificado (E66). Si ya se escaló hace
        // poco (reconfirmando "ya lo tiene el equipo"), no se repite.
        if (!(await escaladoHaceMenosDe(contactId, 24 * 60))) {
          console.warn(`[worker] dijo "ya le avisé" sin escalar — se escala en código | contact=${contactId}`);
          await handleEscalarAHumano(
            {
              motivo_escalacion:
                'El bot le dijo al contacto que ya avisó al equipo, sin haber escalado. Revisar la conversación.',
            },
            contactId,
            turn
          ).catch(() => {});
        }
      }

      // 3.6 Reservas sin calendario: la regla central ("nunca confirmes una
      // mesa") se cumple en código además del prompt, y un "ya registré tu
      // solicitud" sin registro detrás se escala para que una persona la tome
      // (misma forma que E66/E143 de errores-bot).
      if (getConfig().reservations) {
        const q = quitarConfirmacionDeMesa(replyText);
        if (q.quitadas.length) {
          console.warn(`[reservas] se quitó una confirmación de mesa | contact=${contactId} quitado=${JSON.stringify(q.quitadas)}`);
          replyText = q.text;
        }
        if (!turn.reservaRegistrada && !turn.escalado && diceQueRegistro(replyText)) {
          const at = Date.parse(String((await getMeta(contactId)).reserva_registrada_at ?? ''));
          if (isNaN(at) || Date.now() - at > 30 * 60 * 1000) {
            console.warn(`[reservas] dijo que registró sin registrar — se escala en código | contact=${contactId}`);
            await handleEscalarAHumano(
              {
                motivo_escalacion:
                  'El bot le dijo al contacto que registró su solicitud de reserva, pero no quedó registrada. Tomar los datos de la conversación y confirmarle a mano.',
              },
              contactId,
              turn
            ).catch(() => {});
          }
        }
      }

      // 3.7 Revisiones sobre el texto final. La presentación va al último, para
      // que quede al frente del mensaje (E138).
      replyText = asegurarDatosBancarios(replyText);
      replyText = asegurarPresentacion(replyText, abre);

      // 4. Guardar historial (máx 100 entradas)
      const MAX_STORED_MESSAGES = 100;
      const now = new Date().toISOString();
      const newMessages: ChatMessage[] = [
        ...history,
        { role: 'user' as const, content: messageForClaude, ts: now },
        { role: 'assistant' as const, content: replyText, ts: now },
      ].slice(-MAX_STORED_MESSAGES);

      const hasReply = !!replyText && replyText.trim().length > 0;

      await db.query(
        `UPDATE conversations
         SET messages = $1::jsonb,
             last_activity = now(),
             last_bot_message_at = CASE WHEN $3::boolean THEN now() ELSE last_bot_message_at END,
             follow_ups_sent = CASE WHEN $3::boolean THEN 0 ELSE follow_ups_sent END
         WHERE id = $2`,
        [JSON.stringify(newMessages), conversation.id, hasReply]
      );

      // 5. Enviar respuesta por el mismo canal del entrante
      if (hasReply) {
        const parts = splitMessage(replyText);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 800));
          await sendMessage(contactId, parts[i], inboundChannel);
        }

        // 6. Programar follow-ups (solo si hay bloque follow_ups: en el yaml).
        // Se suprimen cuando la conversación ya "cerró":
        //  - agendó cita en ESTE turno, o ya tiene una cita activa de un turno anterior
        //  - escaló a humano en ESTE turno, o ya está en la etapa de escalation.stage
        //  - confirmó asistencia a una plantilla de recordatorio ("Sí asistiré")
        //
        // Importante: la cita/escalación de turnos ANTERIORES se revisa contra el
        // estado real (GHL), no solo contra las tools usadas en este turno — si no,
        // un simple "gracias" después de agendar reprograma follow-ups innecesarios
        // para alguien que ya tiene su cita apartada.
        if (getConfig().follow_ups) {
          const usedTools = new Set(toolCalls.map((t) => t.toolName));
          // OJO: `mover_a_etapa` NO va en esta lista, aunque parezca que sí.
          // Las etapas de cierre van marcadas `AUTO:` en el yaml y por eso
          // buildTools() (services/claude.ts) las esconde del enum que ve el
          // modelo — o sea que esa tool SOLO puede mover a etapas manuales,
          // que son las de conversación EN CURSO. Meterla aquí invierte su
          // significado: cada turno en que el modelo mueve a la etapa de
          // entrada apagaba el seguimiento completo. Incidente real (bot Dr.
          // Romero): 36 de 36 turnos salieron "no programado", cero
          // follow-ups enviados y cero leads movidos a la etapa de perdido
          // durante semanas, sin un solo error en los logs. El cierre real de
          // turnos anteriores ya se verifica abajo contra el estado vivo de
          // GHL — esa es la comprobación correcta.
          // `cancelar_cita` SIN `agendar_cita` = el contacto canceló y no quiso
          // mover la cita a otro día. Eso también cierra el ciclo: perseguirlo
          // con follow-ups 3h después de que pidió cancelar es justo lo que el
          // prompt le manda NO hacer. Con `agendar_cita` es un reagendamiento y
          // ya lo cubre la primera condición.
          //
          // Se exige que la cancelación haya SALIDO BIEN, no solo que el modelo
          // llamara la tool: `cancelar_cita` devuelve `multiple_appointments`
          // cuando hay varias citas y toca preguntarle al contacto cuál — ahí la
          // conversación está más viva que nunca y apagarle el seguimiento sería
          // exactamente el bug de la lección 13 otra vez.
          const cancelacionExitosa = toolCalls.some(
            (t) => t.toolName === 'cancelar_cita' && t.output.includes('"ok":true')
          );
          // Declinó en este turno o antes, y no ha vuelto a pedir horarios (E137).
          const declino = usedTools.has('cerrar_seguimiento') || !!(await getMeta(contactId)).declino_at;
          // Que la cita se haya CREADO, no que el modelo llamara la tool: un
          // "ese horario ya no está" también es llamar agendar_cita.
          const agendoExitoso = toolCalls.some(
            (t) => t.toolName === 'agendar_cita' && t.output.includes('"ok":true')
          );
          // Solicitud de reserva registrada (en este turno o en las últimas
          // 24h): ya la tiene el equipo, no se le persigue. Solo es verdadera
          // si registrar_reserva SALIÓ bien, nunca en un turno normal (lección 13).
          const reservaAt = Date.parse(String((await getMeta(contactId)).reserva_registrada_at ?? ''));
          const reservaReciente =
            !!turn.reservaRegistrada || (!isNaN(reservaAt) && Date.now() - reservaAt < 24 * 60 * 60 * 1000);
          let yaCerrado =
            reservaReciente ||
            agendoExitoso ||
            !!turn.escalado ||
            cancelacionExitosa ||
            declino;

          if (!yaCerrado && getConfig().calendars) {
            try {
              const citas = await getContactAppointments(contactId);
              const now = Date.now();
              const tz = zonaDelNegocio();
              yaCerrado = citas.some((a) => {
                const t = fechaGhlAMs(a.startTime, tz);
                const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
                return !isNaN(t) && t > now && !cancelada;
              });
            } catch (e) {
              console.warn(`[follow-up] check citas falló: ${(e as Error).message}`);
            }
          }

          const escalationStageName = getConfig().escalation?.stage;
          if (!yaCerrado && getConfig().pipeline && escalationStageName) {
            const locationId = process.env.GHL_LOCATION_ID;
            if (locationId) {
              try {
                const opps = await findContactOpportunity(contactId, getConfig().pipeline!.id, locationId);
                const escaladaStage = getConfig().pipeline!.stages.find((s) => s.name === escalationStageName);
                yaCerrado = !!escaladaStage && opps.some((o) => o.pipelineStageId === escaladaStage.id);
              } catch (e) {
                console.warn(`[follow-up] check escalacion falló: ${(e as Error).message}`);
              }
            }
          }

          const confirmType = detectAttendanceConfirmation(messageToProcess);
          const suppressFollowUp = yaCerrado || confirmType === 'yes';

          if (suppressFollowUp) {
            console.log(
              `[follow-up] no programado (conversación cerrada) | contact=${contactId} ` +
                `tools=[${[...usedTools].join(',')}] confirm=${confirmType ?? '-'}`
            );
          } else {
            scheduleFollowUps(contactId).catch((e) =>
              console.warn(`[follow-up] schedule failed: ${e.message}`)
            );
          }
        }
      } else {
        console.warn(`[worker] Empty reply | contact=${contactId}`);
      }

      console.log(
        `[worker] Done | contact=${contactId} tools=[${toolCalls.map((t) => t.toolName).join(',')}]`
      );
    }
  );

  console.log(`[worker] Started | concurrency=${concurrency}`);
}
