/**
 * Horario real de atención del negocio.
 *
 * Vive aparte de messageWorker a propósito: es lógica pura (sin red, sin
 * base de datos) y así se puede probar sola — ver pruebas/horario.js.
 */

import { DIAS_SEMANA, hhmmToMinutes, CalendarsConfig } from '../config';

/**
 * Día de la semana (0 = domingo) y minutos desde medianoche de un slot, en la
 * zona horaria del negocio.
 *
 * Se calcula con Intl y no partiendo el string ISO a mano: los slots de GHL
 * vienen con el offset del calendario ("...T08:00:00-07:00") y ese offset
 * cambia con el horario de verano. Leer el texto directo funciona hasta que
 * deja de funcionar, justo el fin de semana del cambio de hora.
 */
export function slotLocalParts(iso: string, timezone: string): { dia: number; minutos: number } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const h = parseInt(get('hour'), 10);
  const m = parseInt(get('minute'), 10);
  if (dia < 0 || isNaN(h) || isNaN(m)) return null;

  return { dia, minutos: h * 60 + m };
}

/**
 * ¿La cita cabe COMPLETA dentro del horario de atención configurado
 * (`calendars.business_hours`)?
 *
 * Si no hay `business_hours` en el yaml, devuelve true siempre: la
 * disponibilidad de GHL manda y el comportamiento es el de antes.
 *
 * Existe porque los free-slots de GHL son la configuración del calendario,
 * no el horario real del negocio. En el consultorio de la Dra. Mariana el
 * calendario devolvía slots de las 8:00 am, el bot los ofrecía, la paciente
 * los aceptaba y la cita se caía al crearse — o peor, quedaba agendada a una
 * hora en la que no hay nadie. Filtrar aquí lo mata en el origen: ese
 * horario ya ni se le muestra al modelo.
 *
 * `duracionMinutos` importa porque las citas no duran todas lo mismo. Un
 * check up de 45 minutos que empieza a las 12:30 termina 13:15, y el
 * consultorio cierra a las 13:00: la hora de INICIO es válida y la cita de
 * todas formas no cabe. Se valida el bloque completo, no el arranque.
 *
 * La cita tiene que caber dentro de UNA sola ventana. Dos ventanas pegadas
 * no se suman: entre ellas está la comida de la Dra., no más consulta.
 */
export function dentroDeHorario(
  iso: string,
  cal: CalendarsConfig,
  duracionMinutos = 0
): boolean {
  const horarios = cal.business_hours;
  if (!horarios) return true;

  const parts = slotLocalParts(iso, cal.timezone);
  // Si la fecha no se pudo interpretar, mejor descartar el slot que ofrecer
  // un horario que no sabemos leer.
  if (!parts) return false;

  const inicio = parts.minutos;
  const termina = inicio + Math.max(0, duracionMinutos);

  for (const [nombreDia, ventanas] of Object.entries(horarios)) {
    if (DIAS_SEMANA[nombreDia.trim().toLowerCase()] !== parts.dia) continue;
    return ventanas.some((rango) => {
      const [ini, fin] = rango.split('-').map(hhmmToMinutes);
      if (ini === null || fin === null) return false;
      // [inicio, fin): un rango "15:00-17:30" admite empezar a las 17:00,
      // no a las 17:30 — esa es la hora de cierre. Y la cita completa tiene
      // que terminar a las 17:30 a más tardar.
      return inicio >= ini && inicio < fin && termina <= fin;
    });
  }

  // Día que no aparece en business_hours = día sin atención.
  return false;
}

/**
 * La fecha local del slot como "YYYY-MM-DD", en la zona horaria del negocio.
 *
 * Sirve para comparar contra el `desde_fecha` que pide el modelo sin caer en
 * la trampa de `new Date("2026-09-20T00:00:00")`, que se interpreta en la
 * zona del SERVIDOR (en Railway, UTC) y no en la de Ensenada.
 */
export function fechaLocalDelSlot(iso: string, timezone: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // en-CA da directo el formato YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
