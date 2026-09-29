/**
 * Pruebas de las revisiones en código que se agregaron en la auditoría del
 * 23/09/2026. Sin framework, contra dist/, y SIEMPRE con TZ=UTC: así corre
 * Railway, y los bugs de zona horaria no se reproducen en una Mac que ya está
 * en la zona del negocio (E142).
 *
 *   npm run build && npm run test:guards
 */
process.env.GHL_API_KEY = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GHL_LOCATION_ID = 'loc';
process.env.DATABASE_URL = 'postgres://x/x';

const path = require('path');
const fs = require('fs');
const D = (p) => require(path.join(__dirname, '..', 'dist', p));
const { fechaGhlAMs, inicioDelDiaMs } = D('fechas.js');
const claude = D('services/claude.js');

let fallos = 0;
function ok(nombre, cond, detalle) {
  if (!cond) fallos++;
  console.log(`${cond ? '✅' : '❌'} ${nombre}`);
  if (!cond && detalle !== undefined) console.log('   obtenido:', JSON.stringify(detalle));
}

if (new Date().getTimezoneOffset() !== 0) {
  console.log('⚠️  Corre esto con TZ=UTC (npm run test:guards ya lo hace) o no reproduce el servidor.');
}

const TZ = 'America/Mexico_City';

// ── Fechas (E13 / E136 / E142) ──────────────────────────────────────────────
ok('cita de GHL sin zona se lee en la zona del negocio',
  fechaGhlAMs('2026-09-28 10:00:00', TZ) === Date.parse('2026-09-28T10:00:00-06:00'),
  new Date(fechaGhlAMs('2026-09-28 10:00:00', TZ)).toISOString());
ok('slot con offset se respeta',
  fechaGhlAMs('2026-09-28T10:00:00-06:00', TZ) === Date.parse('2026-09-28T16:00:00Z'));
ok('fecha con Z se respeta',
  fechaGhlAMs('2026-09-23T17:36:01.289Z', TZ) === Date.parse('2026-09-23T17:36:01.289Z'));
ok('"a partir del martes 29" empieza el martes a medianoche de Saltillo, no el lunes 6 pm',
  inicioDelDiaMs('2026-09-29', TZ) === Date.parse('2026-09-29T00:00:00-06:00'));
ok('fecha inválida → NaN', isNaN(inicioDelDiaMs('martes', TZ)));

// ── Sesión (E83 / E82) ──────────────────────────────────────────────────────
const H = 3600 * 1000;
const now = Date.parse('2026-09-23T18:00:00Z');
const m = (role, content, msAntes) => ({ role, content, ts: new Date(now - msAntes).toISOString() });
{
  const r = claude.sesionActual([], now);
  ok('sin historial → abre', r.abre && r.mensajes.length === 0);
}
{
  const hist = [m('user', 'viejo', 10 * 24 * H), m('assistant', 'resp vieja', 10 * 24 * H - 60000), m('user', 'hola', 2 * H), m('assistant', 'qué tal', 2 * H - 1000)];
  const r = claude.sesionActual(hist, now);
  ok('recorta lo de hace 10 días y NO abre (hubo mensajes hace 2 h)', !r.abre && r.mensajes.length === 2, r);
}
{
  const hist = [m('user', 'hola', 5 * 24 * H), m('assistant', 'qué tal', 5 * 24 * H - 1000)];
  const r = claude.sesionActual(hist, now);
  ok('paciente que vuelve después de 5 días → abre (se presenta otra vez)', r.abre && r.mensajes.length === 0);
}
{
  const hist = [m('user', 'hola', 30 * H), m('assistant', 'qué tal', 30 * H - 1000), m('user', 'el martes', 1 * H)];
  ok('negociación de ayer sigue viva (hueco < 48 h)', claude.sesionActual(hist, now).mensajes.length === 3);
}

// ── Mensajes para la API: vacíos fuera, roles juntos ────────────────────────
{
  const out = claude.toApiMessages([
    { role: 'user', content: 'hola', ts: '' },
    { role: 'assistant', content: '', ts: '' },
    { role: 'user', content: 'sigues?', ts: '' },
    { role: 'assistant', content: 'sí', ts: '' },
    { role: 'assistant', content: '[Escrito a mano]: yo le ayudo', ts: '' },
  ]);
  ok('mensaje vacío del bot no llega a la API (bloqueaba al contacto)', out.every((x) => x.content.trim()));
  ok('turnos consecutivos del mismo rol se juntan', out.length === 2 && out[0].content === 'hola\n\nsigues?', out);
}

// ── Presentación (E141) ─────────────────────────────────────────────────────
{
  const t = 'Estamos en Plaza La Purísima. Te comparto horarios?';
  ok('a media conversación no se toca', claude.asegurarPresentacion(t, false) === t);
  const r = claude.asegurarPresentacion(t, true);
  const pres = claude.presentacionDelBot();
  ok('abre sin presentarse → se antepone', r.startsWith(`Hola! ${pres}`) && r.endsWith(t), r);
  const r2 = claude.asegurarPresentacion('Hola! Claro, con gusto. Estamos en Plaza La Purísima.', true);
  ok('si ya saluda, va después del saludo (sin saludo doble)', r2.startsWith(`Hola! ${pres}`) && (r2.match(/hola/gi) || []).length === 1, r2);
  const ya = 'Hola! Soy Sofía, asistente digital del negocio. Qué te gustaría resolver?';
  ok('si ya se presentó, no se toca', claude.asegurarPresentacion(ya, true) === ya);
}

// ── Datos bancarios (E63 / E96) — solo si el yaml trae el bloque anticipo ────
const { getConfig } = D('config.js');
if (!getConfig().anticipo) {
  console.log('⏭️  sin bloque anticipo en el yaml: se salta la prueba de datos bancarios');
} else {
  const bloque = 'Banco: Banorte\nTarjeta: 4189 2810 1104 2521\nCLABE: 072078012869432838\nNombre: Miguel Ángel Sánchez Cota';
  const bien = `Perfecto, te separo el lunes a las 12:00pm 😊\n\nPara asegurar tu espacio...\n\n${bloque}\n\nEn cuanto me mandes el comprobante te confirmo tu lugar ✨`;
  ok('bloque correcto no se toca', claude.asegurarDatosBancarios(bien) === bien);
  const malo = bien.replace('072078012869432838', '072078012869432883');
  const arreglado = claude.asegurarDatosBancarios(malo);
  ok('CLABE con dígitos cambiados → se pone la correcta', arreglado.includes('072078012869432838') && !arreglado.includes('432883'), arreglado);
  const plano = 'Para asegurar tu espacio: Banco: Banorte. Tarjeta: 4189 2810 1104 2521. CLABE: 072078012869432838. Nombre: Miguel Ángel Sánchez Cota.';
  const r = claude.asegurarDatosBancarios(plano);
  ok('bloque aplanado en un párrafo → renglones separados', r.includes('\nCLABE: 072078012869432838\n'), r);
  const sinDatos = 'Puedes hacer la transferencia a la cuenta que te pasé, y me mandas la captura?';
  ok('mencionar la transferencia sin datos no reenvía el bloque', claude.asegurarDatosBancarios(sinDatos) === sinDatos);
}

// ── Bloque completo libre (E115 / E119) ─────────────────────────────────────
{
  const { bloqueLibre } = D('workers/messageWorker.js');
  const T = (h) => Date.parse(`2026-09-28T${h}:00-06:00`);
  const slots = (...hs) => hs.map((h) => ({ iso: `2026-09-28T${h}:00-06:00`, calendarId: 'c' }));
  ok('casilla 30, cita 60: libres 9:00 y 9:30 → cabe', bloqueLibre(slots('09:00', '09:30', '10:30'), T('09:00'), 60, 30));
  ok('casilla 30, cita 60: 9:30 ocupada → NO cabe', !bloqueLibre(slots('09:00', '10:00', '10:30'), T('09:00'), 60, 30));
  ok('casilla 60 (intervalo 30), cita 60: basta el inicio', bloqueLibre(slots('09:00', '11:00', '11:30'), T('09:00'), 60, 60));
  ok('horario que no está en los free-slots → NO', !bloqueLibre(slots('09:00', '09:30'), T('15:00'), 30, 30));
  ok('casilla desconocida → solo exige el inicio', bloqueLibre(slots('09:00'), T('09:00'), 60, null));
}

// ── "Ya le avisé" sin escalar (E66) ─────────────────────────────────────────
for (const t of ['Ya le avisé al equipo y en breve te contactan 😊', 'Listo, en un momento te escribe una persona del consultorio', 'Ya le pasé tu comprobante al doctor']) {
  ok(`handoff detectado: "${t}"`, claude.pareceHandoff(t));
}
for (const t of ['En cuanto me mandes el comprobante te confirmo tu lugar ✨', 'El doctor revisa contigo las opciones de pago en tu valoración', 'Te agendo el martes a las 5?']) {
  ok(`NO es handoff: "${t}"`, !claude.pareceHandoff(t));
}

// ── Partidor de mensajes (E110) ─────────────────────────────────────────────
{
  const largo = ('palabra ').repeat(250).trim();
  const partes = claude.splitMessage(largo);
  ok('ningún corte a media palabra', partes.every((p) => /(^|\s)palabra$/.test(p) && /^palabra/.test(p)), partes.map((p) => p.slice(-12)));
}

// ── Narración nueva (E39) ───────────────────────────────────────────────────
{
  const { text } = claude.stripReasoning('Claro! Déjame notificarle al equipo para que te den seguimiento 😊\n\nYa le avisé al equipo y en breve te contactan.');
  ok('"Déjame notificarle al equipo" se quita', text === 'Ya le avisé al equipo y en breve te contactan.', text);
}

// ── Toda tool que ve el modelo tiene handler (E149) ─────────────────────────
{
  const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'messageWorker.ts'), 'utf8');
  const casos = new Set([...w.matchAll(/case\s+'([a-z_]+)':/g)].map((x) => x[1]));
  const sinHandler = claude.TOOLS.map((t) => t.name).filter((n) => !casos.has(n));
  ok('todas las tools registradas tienen su case en el dispatch', sinHandler.length === 0, sinHandler);
}

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo bien.');
process.exit(fallos ? 1 : 0);
