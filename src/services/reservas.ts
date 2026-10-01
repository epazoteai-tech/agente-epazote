/**
 * Solicitudes de reserva SIN calendario (bloque `reservations:` del yaml).
 *
 * Nace con Epazote: el restaurante no tiene agenda en GHL, así que el bot no
 * puede saber si hay mesa. Lo único que hace es juntar los datos, dejarlos en
 * custom fields y poner un tag para que un Workflow avise al equipo, que es
 * quien confirma por el mismo chat. El bot NUNCA confirma la mesa.
 *
 * Lógica pura (sin red ni base de datos) para poder probarla sola — ver
 * pruebas/reservas.js. El handler que toca GHL vive en messageWorker.
 */

import type { ReservationsConfig } from '../config';
import { paredAMs } from '../fechas';

const DIAS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  'miércoles': 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  'sábado': 6,
};

const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "08:30" → 510. Acepta "24:00" como cierre a medianoche. null si no es válida. */
export function minutosDe(hhmm: string): number | null {
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** 1230 → "8:30 pm" (formato de WhatsApp en México). */
export function horaLegible(minutos: number): string {
  const h24 = Math.floor(minutos / 60) % 24;
  const min = minutos % 60;
  const sufijo = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${sufijo}`;
}

/** Día de la semana (0 = domingo) de una fecha YYYY-MM-DD. null si no existe. */
function diaDeLaSemana(fecha: string): number | null {
  const m = fecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Rechaza fechas que no existen ("2026-02-30" se desborda a marzo).
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d.getUTCDay();
}

const DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * "2026-10-10" → "sáb 10 oct". A mano y no con Intl: el formato de Intl cambia
 * entre versiones de Node/ICU ("sáb, 10 oct" / "sáb 10 de oct."), y este texto
 * termina en la notificación del equipo.
 */
export function fechaCorta(fecha: string): string {
  const dia = diaDeLaSemana(fecha);
  if (dia === null) return fecha;
  const [, mes, d] = fecha.split('-').map(Number);
  return `${DIA_CORTO[dia]} ${d} ${MES_CORTO[mes - 1]}`;
}

const MES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * "2026-10-03" → "sábado 3 de octubre". Es lo que lee el CLIENTE en la
 * plantilla de recordatorio ({{contact.reserva_fecha}}), así que va completo y
 * sin la fecha ISO: antes el campo guardaba "sáb 3 oct (2026-10-03)" y el
 * paréntesis le habría llegado tal cual.
 */
export function fechaLarga(fecha: string): string {
  const dia = diaDeLaSemana(fecha);
  if (dia === null) return fecha;
  const [, mes, d] = fecha.split('-').map(Number);
  return `${NOMBRE_DIA[dia]} ${d} de ${MES_LARGO[mes - 1]}`;
}

/** Desayuno / comida / cena según la hora, con los turnos del yaml. */
export function turnoDe(minutos: number, cfg: Pick<ReservationsConfig, 'turnos'>): string {
  return (
    cfg.turnos.find((t) => {
      const a = minutosDe(t.desde);
      const b = minutosDe(t.hasta);
      return a !== null && b !== null && minutos >= a && minutos < b;
    })?.nombre ?? ''
  );
}

export interface SolicitudReserva {
  nombre: string;
  fecha: string; // YYYY-MM-DD
  hora: string; // HH:MM 24h
  personas: number;
  ocasion?: string;
}

export type ResultadoValidacion =
  | {
      ok: true;
      turno: string;
      horaLegible: string;
      fechaLegible: string;
      /** "sábado 3 de octubre", para lo que lee el cliente. */
      fechaLarga: string;
      resumen: string;
    }
  | { ok: false; error: string; message: string };

/**
 * Valida la solicitud contra el horario del restaurante y arma el resumen
 * para la notificación del equipo.
 *
 * Cada error trae un `message` que le dice al modelo qué hacer, porque es
 * justo ahí donde decide (lección 29 de la skill: desambigua en el
 * tool_result, no en el prompt).
 */
export function validarReserva(
  s: SolicitudReserva,
  cfg: ReservationsConfig,
  ahoraMs: number = Date.now()
): ResultadoValidacion {
  const nombre = (s.nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!nombre) {
    return { ok: false, error: 'falta_nombre', message: 'Falta el nombre de quien reserva. Pídeselo antes de registrar.' };
  }

  if (!Number.isInteger(s.personas) || s.personas < 1) {
    return { ok: false, error: 'personas_invalidas', message: 'Falta el número de personas. Pregúntalo antes de registrar.' };
  }
  if (s.personas >= cfg.grupo_grande_desde) {
    return {
      ok: false,
      error: 'grupo_grande',
      message:
        `Grupo de ${s.personas} personas: los grupos de ${cfg.grupo_grande_desde} o más los atiende directo el equipo. ` +
        'NO lo registres como reserva normal. Usa escalar_a_humano y dile que una persona del equipo le escribe por aquí para organizarlo.',
    };
  }

  const dia = diaDeLaSemana(s.fecha);
  if (dia === null) {
    return { ok: false, error: 'fecha_invalida', message: `La fecha "${s.fecha}" no es válida. Confírmala con el contacto.` };
  }

  const minutos = minutosDe(s.hora);
  if (minutos === null || minutos >= 24 * 60) {
    return { ok: false, error: 'hora_invalida', message: `La hora "${s.hora}" no es válida. Confírmala con el contacto.` };
  }

  const [y, mo, d] = s.fecha.split('-').map(Number);
  const instante = paredAMs(y, mo, d, Math.floor(minutos / 60), minutos % 60, 0, cfg.timezone);
  if (instante <= ahoraMs) {
    return {
      ok: false,
      error: 'fecha_pasada',
      message: 'Esa fecha y hora ya pasaron. Revisa con el contacto qué día quiso decir (usa el contexto temporal).',
    };
  }

  const nombreDia = Object.keys(cfg.horario).find((k) => DIAS[k.trim().toLowerCase()] === dia);
  const ventanas = nombreDia ? cfg.horario[nombreDia] : [];
  const describeHorario = ventanas.length
    ? ventanas
        .map((v) => {
          const [a, b] = v.split('-').map((x) => minutosDe(x) ?? 0);
          return `de ${horaLegible(a)} a ${b === 24 * 60 ? '12:00 am (medianoche)' : horaLegible(b)}`;
        })
        .join(' y ')
    : '';

  const dentro = ventanas.some((v) => {
    const [a, b] = v.split('-').map(minutosDe);
    if (a === null || b === null) return false;
    return minutos >= a && minutos <= b - cfg.ultima_reserva_antes_de_cierre_min;
  });
  if (!dentro) {
    return {
      ok: false,
      error: 'fuera_de_horario',
      message: ventanas.length
        ? `El ${NOMBRE_DIA[dia]} el restaurante abre ${describeHorario}` +
          (cfg.ultima_reserva_antes_de_cierre_min > 0
            ? `, y la última reserva se recibe ${cfg.ultima_reserva_antes_de_cierre_min} minutos antes del cierre`
            : '') +
          `. ${horaLegible(minutos)} queda fuera. Díselo con calidez y proponle una hora dentro del horario. No registres nada todavía.`
        : `El ${NOMBRE_DIA[dia]} el restaurante no abre. Díselo con calidez y proponle otro día. No registres nada todavía.`,
    };
  }

  const turno = turnoDe(minutos, cfg);

  const ocasion = (s.ocasion ?? '').trim();
  const fechaLegible = fechaCorta(s.fecha);
  const hl = horaLegible(minutos);
  const resumen = [
    nombre,
    `${s.personas} ${s.personas === 1 ? 'persona' : 'personas'}`,
    fechaLegible,
    hl,
    turno,
    ocasion,
  ]
    .filter(Boolean)
    .join(' · ');

  return { ok: true, turno, horaLegible: hl, fechaLegible, fechaLarga: fechaLarga(s.fecha), resumen };
}

// ─── Redes sobre el texto que sale ────────────────────────────────────────────
// La regla central del bot ("nunca confirmes una mesa") vive en el prompt, en
// rules.do_not y en el tool_result. Aun así es una regla que el modelo puede
// saltarse una de cada tantas veces, y cuando pasa el cliente llega a un
// restaurante lleno creyendo que tiene mesa. Lo que se puede escribir como
// regex no se le deja al modelo (E128/E152 de errores-bot).

// Afirmaciones de disponibilidad: se quitan aunque vayan dentro de una pregunta
// ("Sí hay lugar el sábado, a nombre de quién?" promete igual).
const CONFIRMA_MESA = new RegExp(
  [
    '(tu|su) (mesa|reserva(ci[oó]n)?) (ya )?(est[aá]|qued[oó]|queda) (confirmad|apartad|asegurad|lista|reservad)',
    '(mesa|reserva(ci[oó]n)?) confirmada',
    'ya (tienes|tienen|tiene) (tu |su )?(mesa|lugar)',
    's[ií] hay (lugar|mesa|disponibilidad|espacio)',
    'tenemos (lugar|mesa|disponibilidad|espacio)',
    '(est[aá]|queda) (disponible|libre)',
  ].join('|'),
  'i'
);
// "Te esperamos" suena a confirmación en una afirmación, no en una pregunta
// ("A qué hora los esperamos?" no promete nada).
const TE_ESPERAMOS = /\b(te|los|las|les) esperamos\b/i;

const RESPALDO_CONFIRMACION = 'Eso te lo confirma el equipo en un momento por aquí mismo.';

const EMOJI = '[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]';
const ORACION = new RegExp(`[^.!?\\n]+[.!?]*(\\s*${EMOJI}+)?`, 'gu');
const ES_PREGUNTA = new RegExp(`\\?\\s*${EMOJI}*\\s*$`, 'u');

/**
 * Quita las oraciones que confirman una mesa o dicen que hay lugar, y pone en
 * su lugar la frase que sí es verdad. Trabaja por oración para conservar el
 * resto del mensaje (el resumen de la reserva, la respuesta a lo que preguntó).
 * Si la confirmación va pegada a una pregunta por coma ("Sí hay lugar, a nombre
 * de quién?"), se quita solo la parte que confirma y la pregunta se conserva.
 */
export function quitarConfirmacionDeMesa(text: string): { text: string; quitadas: string[] } {
  const quitadas: string[] = [];
  let puesto = false;
  const respaldo = () => {
    if (puesto) return '';
    puesto = true;
    return RESPALDO_CONFIRMACION;
  };
  const salida = text.replace(ORACION, (oracion) => {
    const limpia = oracion.trim();
    if (!limpia) return oracion;
    const espacio = oracion.match(/^\s*/)?.[0] ?? '';
    const pregunta = ES_PREGUNTA.test(limpia);
    const fuerte = CONFIRMA_MESA.exec(limpia);

    if (!fuerte && !(TE_ESPERAMOS.test(limpia) && !pregunta)) return oracion;
    quitadas.push(limpia);

    if (fuerte && pregunta) {
      const coma = limpia.lastIndexOf(',');
      if (coma > fuerte.index) {
        const resto = limpia.slice(coma + 1).trim();
        const r = respaldo();
        return espacio + (r ? `${r} ` : '') + resto.charAt(0).toUpperCase() + resto.slice(1);
      }
    }
    const r = respaldo();
    return r ? espacio + r : '';
  });
  return { text: salida.replace(/[ \t]{2,}/g, ' ').trim(), quitadas };
}

/** El texto dice que la solicitud quedó registrada (para cruzarlo con la tool). */
export function diceQueRegistro(text: string): boolean {
  return /registr[eé] (tu|su) (solicitud|reserva|cambio)|(solicitud|reserva) (ya )?(qued[oó]|est[aá]) registrad/i.test(text);
}

/**
 * Mensaje con el que el contacto ABRIÓ la sesión actual: el primero suyo
 * después de 24h o más sin actividad. Es el que trae el texto precargado del
 * wa.link de cada creativo ("vengo del video del cabrito"), o sea el origen de
 * campaña que necesita la Mesa de Control para calcular ROAS por creativo.
 *
 * Se calcula en código y no se le pide al modelo: es determinista, y un
 * contacto que reserva horas después de su primer mensaje ya no lo tiene
 * "presente" en el turno en que registra.
 */
export function mensajeDeOrigen(
  history: { role: string; content: string; ts: string }[],
  // El mismo hueco que usa sesionActual (services/claude.ts, 48 h) para decidir
  // qué historial ve el modelo: dos definiciones de "sesión" terminan desfasadas.
  gapMs: number = 48 * 60 * 60 * 1000
): string {
  let origen = '';
  let anterior = NaN;
  for (const m of history) {
    const t = Date.parse(m.ts);
    const abreSesion = isNaN(anterior) || (!isNaN(t) && t - anterior >= gapMs);
    if (abreSesion) origen = '';
    if (!origen && m.role === 'user' && m.content.trim()) origen = m.content.trim();
    if (!isNaN(t)) anterior = t;
  }
  return origen.replace(/\s+/g, ' ').slice(0, 300);
}
