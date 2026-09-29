/**
 * Lectura de fechas en la zona del NEGOCIO, no en la del servidor.
 *
 * Railway corre en UTC. `new Date("2026-09-28 10:00:00")` o
 * `new Date("2026-09-29T00:00:00")` se interpretan en la zona del proceso, así
 * que en producción se corren 6 horas respecto a Saltillo — y en la Mac de
 * quien programa no, porque está en la zona del negocio. Por eso estos bugs
 * no se reproducen en local: hay que correr las pruebas con `TZ=UTC`.
 *
 * Dos casos reales de este bot:
 *   - El endpoint de citas POR CONTACTO de GHL devuelve `startTime` y
 *     `dateAdded` como fecha "de pared" SIN zona ("2026-09-28 10:00:00"),
 *     mientras que los free-slots sí traen offset. Leídas con `new Date()`,
 *     las citas se adelantaban 6 horas: la de hoy dejaba de contar como futura
 *     desde las 4 de la mañana y se le describía al paciente "a las 4:00 a. m."
 *     (E136/E142 de la skill errores-bot).
 *   - `desde_fecha` ("a partir del martes") se convertía en el LUNES a las 6 pm
 *     (E13).
 */

/** Diferencia (ms) entre la hora de pared de `tz` y UTC en el instante dado. */
function offsetMs(tz: string, atMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value])
  );
  const comoUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return comoUtc - Math.floor(atMs / 1000) * 1000;
}

/** Instante (ms) de una hora de pared en la zona `tz`. */
export function paredAMs(
  y: number,
  mes: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string
): number {
  const aproximado = Date.UTC(y, mes - 1, d, h, mi, s);
  const off = offsetMs(tz, aproximado);
  let t = aproximado - off;
  // Si en medio hay cambio de horario, el offset del resultado es el que manda.
  const off2 = offsetMs(tz, t);
  if (off2 !== off) t = aproximado - off2;
  return t;
}

const CON_ZONA = /\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*([zZ]|[+-]\d{2}:?\d{2})$/;
const PARED = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Convierte una fecha que viene de GHL a ms. Si trae zona (Z u offset) se
 * respeta; si no, se interpreta como hora de pared en la zona del negocio.
 * Devuelve NaN si no se puede leer.
 */
export function fechaGhlAMs(valor: string | null | undefined, tz: string): number {
  const s = (valor ?? '').trim();
  if (!s) return NaN;
  if (CON_ZONA.test(s)) return new Date(s).getTime();
  const m = s.match(PARED);
  if (!m) return NaN;
  return paredAMs(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    tz
  );
}

/** Medianoche de un día YYYY-MM-DD en la zona del negocio. NaN si no es válida. */
export function inicioDelDiaMs(yyyyMmDd: string, tz: string): number {
  const m = yyyyMmDd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return paredAMs(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, tz);
}
