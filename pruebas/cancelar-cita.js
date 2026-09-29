/**
 * Prueba de `handleCancelarCita` (workers/messageWorker.ts).
 *
 * No hay framework de tests en el proyecto: esto stubea las llamadas a GHL
 * metiendo módulos falsos en require.cache y ejercita a mano los casos que
 * importan. Se corre contra dist/, así que primero `npm run build`.
 *
 *   npm run build && npm run test:cancelar
 *
 * Lo que cubre: 0 citas futuras, 1 cita (cancelación simple), reagendamiento
 * posponiendo, reagendamiento adelantando (la nueva es la más próxima),
 * dos citas de personas distintas (no debe adivinar), desambiguación por
 * fecha, y reagendamiento sin cita previa.
 */
process.env.GHL_API_KEY = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GHL_LOCATION_ID = 'loc';
process.env.DATABASE_URL = 'postgres://x/x';

const path = require('path');
// Resuelve contra dist/ del propio proyecto (correr después de `npm run build`).
const D = (p) => require.resolve(path.join(__dirname, '..', 'dist', p));

const canceladas = [];
const notas = [];
let CITAS = [];

// Stub de ghl-calendar (solo lo que usa el handler)
require.cache[D('services/ghl-calendar.js')] = {
  id: D('services/ghl-calendar.js'), filename: D('services/ghl-calendar.js'), loaded: true,
  exports: {
    buscarCitasDelContacto: async () => CITAS,
    cancelarCita: async (id) => { canceladas.push(id); },
    getFreeSlots: async () => [], createAppointment: async () => ({}),
    getContactAppointments: async () => [], addTagsToContact: async () => {},
  },
};
// Stub de ghl
const realGhl = require(D('services/ghl.js'));
require.cache[D('services/ghl.js')] = {
  id: D('services/ghl.js'), filename: D('services/ghl.js'), loaded: true,
  exports: { ...realGhl, createNote: async (c, n) => { notas.push(n); } },
};
// Stub de config: la plantilla trae bot.config.yaml con placeholders
// (TODO_TIMEZONE, TODO_CALENDAR_ID...), así que la prueba no puede leer el
// archivo real — necesita una config válida propia para correr tal cual en
// una plantilla recién clonada.
const CFG = {
  bot: { name: 'Ana' },
  calendars: {
    timezone: 'America/Mexico_City',
    duration_minutes: 60,
    agendas: { principal: { name: 'Principal', calendar_id: 'CAL_TEST_1' } },
    routing: { default: 'any' },
  },
};
require.cache[D('config.js')] = {
  id: D('config.js'), filename: D('config.js'), loaded: true,
  exports: { getConfig: () => CFG, loadConfig: () => CFG },
};
// Stub de queue y db (los importa messageWorker a nivel de módulo)
for (const m of ['queue.js', 'db/client.js']) {
  require.cache[D(m)] = { id: D(m), filename: D(m), loaded: true,
    exports: { boss: { work: async () => {}, cancel: async () => {}, send: async () => {} },
               QUEUE_NAME: 'q', db: { query: async () => ({ rows: [] }) } } };
}

const { handleCancelarCita } = require(D('workers/messageWorker.js'));

const cita = (id, iso, titulo) => ({ id, title: titulo, startTime: iso, endTime: iso, status: 'confirmed', calendarId: 'CAL_TEST_1' });

(async () => {
  let fallos = 0;
  const check = (nombre, cond, extra) => {
    console.log(`${cond ? '  OK  ' : ' FALLA'} | ${nombre}${extra ? ' → ' + extra : ''}`);
    if (!cond) fallos++;
  };

  // ── Caso 1: 0 citas futuras ────────────────────────────────────────────
  CITAS = []; canceladas.length = 0;
  let r = JSON.parse(await handleCancelarCita({}, 'c1', {}));
  check('0 citas → no_upcoming_appointment', r.error === 'no_upcoming_appointment', JSON.stringify(r.error));
  check('0 citas → no canceló nada', canceladas.length === 0);

  // ── Caso 2: exactamente 1 cita futura → la cancela ─────────────────────
  CITAS = [cita('A', '2026-09-20T16:00:00-06:00', 'Juan Pérez - valoración')];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({ motivo: 'ya no puede' }, 'c1', {}));
  check('1 cita → ok', r.ok === true, JSON.stringify(r));
  check('1 cita → canceló la A', canceladas.join() === 'A', canceladas.join());
  check('1 cita → sin kept_start', r.kept_start === undefined);
  check('1 cita → devuelve cancelled_start', r.cancelled_start === '2026-09-20T16:00:00-06:00');

  // ── Caso 3: reagendamiento (2 citas, una creada en este turno) ──────────
  // La NUEVA (B) es la más lejana; la vieja (A) es la más próxima.
  CITAS = [
    cita('A', '2026-09-20T16:00:00-06:00', 'Juan Pérez - valoración'),
    cita('B', '2026-09-25T16:00:00-06:00', 'Juan Pérez - valoración'),
  ];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({ motivo: 'reagendó' }, 'c1', { citaCreada: { id: 'B', nombre: 'Juan Pérez' } }));
  check('reagenda → ok', r.ok === true, JSON.stringify(r));
  check('reagenda → canceló la vieja (A)', canceladas.join() === 'A', canceladas.join());
  check('reagenda → conserva la nueva (B)', r.kept_start === '2026-09-25T16:00:00-06:00', r.kept_start);

  // ── Caso 3b: reagendamiento donde la NUEVA es la más PRÓXIMA ────────────
  // (el contacto adelantó su cita). Cancelar "la más próxima" a ciegas
  // tumbaría la nueva; con el contexto de turno se cancela la correcta.
  CITAS = [
    cita('B', '2026-09-18T16:00:00-06:00', 'Juan Pérez - valoración'),
    cita('A', '2026-09-20T16:00:00-06:00', 'Juan Pérez - valoración'),
  ];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({}, 'c1', { citaCreada: { id: 'B', nombre: 'Juan Pérez' } }));
  check('reagenda adelantando → cancela la vieja (A), no la nueva', canceladas.join() === 'A', canceladas.join());

  // ── Caso 4: 2 citas de PERSONAS DISTINTAS, cancelación simple ───────────
  CITAS = [
    cita('A', '2026-09-20T16:00:00-06:00', 'Juan Pérez - valoración'),
    cita('C', '2026-09-22T10:00:00-06:00', 'Ana Pérez - valoración'),
  ];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({}, 'c1', {}));
  check('2 personas → pide desambiguar', r.error === 'multiple_appointments', JSON.stringify(r.error));
  check('2 personas → NO canceló nada a ciegas', canceladas.length === 0, canceladas.join());
  check('2 personas → lista las dos con fecha_cita', Array.isArray(r.citas) && r.citas.length === 2, JSON.stringify(r.citas));

  // segunda pasada con fecha_cita
  r = JSON.parse(await handleCancelarCita({ fecha_cita: '2026-09-22' }, 'c1', {}));
  check('desambiguada por fecha → cancela la de Ana (C)', canceladas.join() === 'C', canceladas.join());

  // ── Caso 5: reagendamiento con 2 personas — elige por nombre ────────────
  CITAS = [
    cita('A', '2026-09-20T16:00:00-06:00', 'Juan Pérez - valoración'),
    cita('C', '2026-09-21T10:00:00-06:00', 'Ana Pérez - valoración'),
    cita('B', '2026-09-25T16:00:00-06:00', 'Juan Pérez - valoración'),
  ];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({}, 'c1', { citaCreada: { id: 'B', nombre: 'Juan Pérez' } }));
  check('reagenda con familiar → cancela la de Juan (A), no la de Ana', canceladas.join() === 'A', canceladas.join());

  // ── Caso 6: reagendamiento donde no había cita anterior ────────────────
  CITAS = [cita('B', '2026-09-25T16:00:00-06:00', 'Juan Pérez - valoración')];
  canceladas.length = 0;
  r = JSON.parse(await handleCancelarCita({}, 'c1', { citaCreada: { id: 'B', nombre: 'Juan Pérez' } }));
  check('reagenda sin cita previa → no_previous_appointment', r.error === 'no_previous_appointment', JSON.stringify(r.error));
  check('reagenda sin cita previa → no cancela la nueva', canceladas.length === 0, canceladas.join());

  console.log(`\n${fallos === 0 ? '✅ Todas las pruebas pasaron' : `❌ ${fallos} fallas`}`);
  process.exit(fallos === 0 ? 0 : 1);
})();
