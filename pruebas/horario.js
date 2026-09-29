/**
 * Prueba del filtro de horario de atención (calendars.business_hours).
 *
 * No hay framework de tests: esto usa una config propia (no el yaml del
 * cliente, que trae TODO_ sin llenar) y ejercita la lógica pura.
 *
 *   npm run test:horario
 *
 * Lo que cubre: fuera de horario, hueco de comida, hora de cierre, día sin
 * atención, que la cita quepa COMPLETA antes del cierre, y la fecha local
 * del slot en la zona del negocio.
 */
const path = require('path');
const D = (p) => require.resolve(path.join(__dirname, '..', 'dist', p));

// Config propia: la plantilla recién clonada no tiene un yaml válido.
const CAL = {
  timezone: 'America/Mexico_City',
  duration_minutes: 30,
  business_hours: {
    lunes: ['09:00-14:00', '16:00-19:00'],
    martes: ['09:00-14:00', '16:00-19:00'],
    miercoles: ['09:00-14:00', '16:00-19:00'],
    jueves: ['09:00-14:00', '16:00-19:00'],
    viernes: ['09:00-14:00'],
    sabado: [],
    domingo: [],
  },
};
require.cache[D('config.js')] = {
  id: D('config.js'), filename: D('config.js'), loaded: true,
  exports: {
    getConfig: () => ({ calendars: CAL }),
    DIAS_SEMANA: { domingo:0, lunes:1, martes:2, miercoles:3, 'miércoles':3, jueves:4, viernes:5, sabado:6, 'sábado':6 },
    hhmmToMinutes: (hhmm) => {
      const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = parseInt(m[1],10), min = parseInt(m[2],10);
      return h > 23 || min > 59 ? null : h*60 + min;
    },
  },
};

const { dentroDeHorario, fechaLocalDelSlot } = require(D('services/horario.js'));

// Semana del 21 al 27 de septiembre de 2026 (lunes a domingo).
// Offset -06:00 = America/Mexico_City.
const casos = [
  ['2026-09-21T08:00:00-06:00', 0, false, 'lunes 8am, antes de abrir'],
  ['2026-09-21T09:00:00-06:00', 0, true,  'lunes 9am, primer slot'],
  ['2026-09-21T14:00:00-06:00', 0, false, 'lunes 2pm, hora de cierre de la mañana'],
  ['2026-09-21T15:00:00-06:00', 0, false, 'lunes 3pm, hueco de comida'],
  ['2026-09-21T18:30:00-06:00', 0, true,  'lunes 6:30pm'],
  ['2026-09-21T19:00:00-06:00', 0, false, 'lunes 7pm, hora de cierre'],
  ['2026-09-25T16:00:00-06:00', 0, false, 'viernes 4pm, viernes solo abre en la mañana'],
  ['2026-09-26T10:00:00-06:00', 0, false, 'sábado, sin atención'],
  ['2026-09-27T10:00:00-06:00', 0, false, 'domingo, sin atención'],
  ['no-es-una-fecha',           0, false, 'basura, se descarta en vez de ofrecerse'],
  // La cita tiene que caber COMPLETA antes del cierre
  ['2026-09-21T13:30:00-06:00', 30, true,  'lunes 13:30 de 30 min, termina 14:00 justo al cierre'],
  ['2026-09-21T13:30:00-06:00', 60, false, 'lunes 13:30 de 60 min, terminaría 14:30 ya cerrado'],
  ['2026-09-21T13:00:00-06:00', 60, true,  'lunes 13:00 de 60 min, sí cabe'],
  ['2026-09-21T13:30:00-06:00', 90, false, 'no se suma la ventana de la tarde'],
  ['2026-09-21T18:00:00-06:00', 60, true,  'lunes 18:00 de 60 min, termina al cierre'],
  ['2026-09-21T18:30:00-06:00', 60, false, 'lunes 18:30 de 60 min, se pasa del cierre'],
];

let fallos = 0;
const check = (ok, txt, extra) => {
  if (!ok) fallos++;
  console.log(`${ok ? '✅' : '❌'} ${txt}${ok ? '' : ` ${extra}`}`);
};

for (const [iso, mins, esperado, porque] of casos) {
  const real = dentroDeHorario(iso, CAL, mins);
  check(real === esperado, porque + ' → ' + real, `(esperado ${esperado})`);
}

console.log('\n-- fecha local del slot (zona del negocio, no la del servidor) --');
for (const [iso, esperado, porque] of [
  ['2026-09-22T00:00:00Z', '2026-09-21', 'medianoche UTC sigue siendo el 21 en México'],
  ['2026-09-21T09:00:00-06:00', '2026-09-21', 'slot normal del CRM'],
  ['no-es-fecha', null, 'basura da null'],
]) {
  const real = fechaLocalDelSlot(iso, CAL.timezone);
  check(real === esperado, porque + ' → ' + real, `(esperado ${esperado})`);
}

const total = casos.length + 3;
console.log(`\n${total - fallos}/${total} casos correctos`);
process.exit(fallos === 0 ? 0 : 1);
