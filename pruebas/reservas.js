/**
 * Prueba de la validación de solicitudes de reserva (bloque `reservations:`).
 * Lógica pura, sin red ni base de datos.
 *
 *   npm run test:reservas
 *
 * Cubre: horario por día (incluido cierre a medianoche), margen de última
 * reserva, día cerrado, fecha pasada, fecha inexistente, grupo grande, turno
 * inferido por la hora y el formato del resumen de la notificación.
 */
const path = require('path');
const { validarReserva, mensajeDeOrigen, quitarConfirmacionDeMesa, diceQueRegistro } = require(path.join(__dirname, '..', 'dist', 'services', 'reservas.js'));

const CFG = {
  timezone: 'America/Monterrey',
  notify_tag: 'reserva-solicitada',
  grupo_grande_desde: 8,
  ultima_reserva_antes_de_cierre_min: 60,
  horario: {
    lunes: ['08:00-23:00'], martes: ['08:00-23:00'], miercoles: ['08:00-23:00'], jueves: ['08:00-23:00'],
    viernes: ['08:00-24:00'], sabado: ['08:00-24:00'], domingo: ['08:00-20:00'],
  },
  turnos: [
    { nombre: 'desayuno', desde: '08:00', hasta: '14:00' },
    { nombre: 'comida', desde: '14:00', hasta: '18:00' },
    { nombre: 'cena', desde: '18:00', hasta: '24:00' },
  ],
  fields: {},
};

// "Ahora" fijo: viernes 25 sep 2026, 10:00 am en Saltillo (UTC-6).
const AHORA = Date.parse('2026-09-25T16:00:00Z');
const base = { nombre: 'Juan Pérez', personas: 4 };

const casos = [
  // [fecha, hora, extra, esperado (true | código de error), descripción]
  ['2026-09-26', '20:30', { ocasion: 'cumpleaños' }, true, 'sábado 8:30 pm, cena con ocasión'],
  ['2026-09-26', '09:00', {}, true, 'sábado 9 am, desayuno'],
  ['2026-09-26', '23:00', {}, true, 'sábado 11 pm, justo en el margen (cierra 24:00)'],
  ['2026-09-26', '23:30', {}, 'fuera_de_horario', 'sábado 11:30 pm, dentro del margen de cierre'],
  ['2026-09-28', '22:30', {}, 'fuera_de_horario', 'lunes 10:30 pm, cierra 23:00 y margen 60'],
  ['2026-09-27', '19:30', {}, 'fuera_de_horario', 'domingo 7:30 pm, cierra 20:00'],
  ['2026-09-27', '07:30', {}, 'fuera_de_horario', 'domingo 7:30 am, antes de abrir'],
  ['2026-09-25', '09:00', {}, 'fecha_pasada', 'hoy 9 am, ya pasó'],
  ['2026-09-25', '14:00', {}, true, 'hoy 2 pm, comida'],
  ['2026-02-30', '14:00', {}, 'fecha_invalida', 'fecha que no existe'],
  ['2026-09-26', '25:00', {}, 'hora_invalida', 'hora que no existe'],
  ['2026-09-26', '14:00', { personas: 8 }, 'grupo_grande', '8 personas, umbral'],
  ['2026-09-26', '14:00', { personas: 7 }, true, '7 personas, abajo del umbral'],
  ['2026-09-26', '14:00', { personas: 0 }, 'personas_invalidas', '0 personas'],
  ['2026-09-26', '14:00', { nombre: '  ' }, 'falta_nombre', 'sin nombre'],
];

let fallas = 0;
for (const [fecha, hora, extra, esperado, desc] of casos) {
  const r = validarReserva({ ...base, fecha, hora, ...extra }, CFG, AHORA);
  const obtenido = r.ok ? true : r.error;
  const ok = obtenido === esperado;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${desc} → ${obtenido}${r.ok ? ` | ${r.resumen}` : ''}`);
}

// Formato exacto del resumen para el merge field de la notificación.
const r = validarReserva({ ...base, fecha: '2026-09-26', hora: '20:30', ocasion: 'cumpleaños' }, CFG, AHORA);
const esperadoResumen = 'Juan Pérez · 4 personas · sáb 26 sep · 8:30 pm · cena · cumpleaños';
const okRes = r.ok && r.resumen === esperadoResumen;
if (!okRes) fallas++;
console.log(`${okRes ? '✅' : '❌'} resumen exacto → "${r.ok ? r.resumen : r.error}"`);

// Origen de campaña: primer mensaje del contacto en la sesión actual.
const h = (role, content, ts) => ({ role, content, ts });
const origenes = [
  [[h('user', 'Hola, vengo del video del cabrito', '2026-09-25T10:00:00Z'), h('assistant', 'Hola!', '2026-09-25T10:00:30Z'),
    h('user', 'para 4 el sábado', '2026-09-25T15:00:00Z')], 'Hola, vengo del video del cabrito', 'reserva horas después, conserva el precargado'],
  [[h('user', 'hola, info', '2026-09-01T10:00:00Z'), h('assistant', 'Hola!', '2026-09-01T10:00:30Z'),
    h('user', 'Vi lo del machacado', '2026-09-25T10:00:00Z')], 'Vi lo del machacado', 'contacto que regresa semanas después, toma la sesión nueva'],
  [[h('assistant', 'seguimiento', '2026-09-25T09:00:00Z'), h('user', 'si, quiero reservar', '2026-09-25T09:05:00Z')], 'si, quiero reservar', 'sesión abierta por el bot'],
  [[], '', 'sin historial'],
];
for (const [hist, esperado, desc] of origenes) {
  const o = mensajeDeOrigen(hist);
  const ok = o === esperado;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} origen: ${desc} → "${o}"`);
}

// Red contra confirmar la mesa: [texto, texto esperado a la salida]
const R = 'Eso te lo confirma el equipo en un momento por aquí mismo.';
const confirmaciones = [
  // NO tocar: el guion de cierre, preguntas y respuestas honestas
  ['Listo, Juan, ya registré tu solicitud: *mesa para 4 el sábado a las 9:00 pm*. En un momento el equipo te confirma por aquí mismo 🙌', null],
  ['A qué hora los esperamos, temprano tipo 8:30 o más tarde?', null],
  ['Eso te lo confirma el equipo en un momento por aquí, ellos ven la disponibilidad en tiempo real 😊', null],
  ['Puedes llegar sin reserva, con gusto te recibimos. La reserva nada más te asegura la mesa.', null],
  ['Tenemos actividades para niños los fines de semana, pinta caritas y juegos.', null],
  ['Qué gusto, que lo disfruten mucho! 😊', null],
  // SÍ quitar
  ['Listo! Tu mesa está confirmada para el sábado a las 9 ✅ Te esperamos.', `Listo! ${R}`],
  ['Sí hay lugar el sábado a las 9, a nombre de quién la registro?', `${R} A nombre de quién la registro?`],
  ['Perfecto, las 2:00 pm está disponible. Celebran algo?', `${R} Celebran algo?`],
  ['Claro! Tenemos mesa el domingo. Para cuántas personas?', `Claro! ${R} Para cuántas personas?`],
];
for (const [t, esperado] of confirmaciones) {
  const o = quitarConfirmacionDeMesa(t).text;
  const ok = o === (esperado ?? t);
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} confirmación: "${t.slice(0, 45)}…" → "${o}"`);
}
for (const [t, esperado] of [['Listo, ya registré tu solicitud', true], ['Tu solicitud quedó registrada', true], ['Te registro la reserva a nombre de Juan?', false]]) {
  const ok = diceQueRegistro(t) === esperado;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} dice que registró: "${t}" → ${diceQueRegistro(t)}`);
}

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
