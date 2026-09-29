/**
 * Los mensajes que GHL no avisa por webhook (E144 de errores-bot).
 *
 * Sin red ni base: se prueban las decisiones puras que definen qué se recupera.
 * Portado de Viking Food, donde GHL tiraba 1 de cada 5 webhooks y todos los
 * perdidos llegaban dentro de 6 segundos del mensaje anterior.
 *
 * Protege las dos fallas opuestas:
 *   1. que un mensaje real se quede fuera (lo que originó todo);
 *   2. que se recupere DE MÁS: resucitar la conversación de ayer, meter dos
 *      veces lo mismo, o contestar por un canal que este bot no atiende.
 *
 *   npm run test:inbound
 */

const {
  candidatosParaIncorporar,
  descartarYaConocidos,
  textoDeMensaje,
  marcadorDeMedia,
  VENTANA_INCORPORACION_MS,
} = require('../dist/services/inbound');
const { filtrarPorInboundReciente } = require('../dist/services/ghl');

let fallos = 0;
function check(nombre, real, esperado) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : `\n     esperado ${JSON.stringify(esperado)}\n     salió    ${JSON.stringify(real)}`}`);
}
const msg = (id, body, iso, attachment = null, channel = 'WhatsApp') => ({ id, body, dateAdded: iso, attachment, channel });

const AHORA = Date.parse('2026-10-05T16:25:36.000Z');
// Una ráfaga de 13 segundos: "hola" y enseguida lo que de verdad quiere.
const RAFAGA = [
  msg('m1', 'Hola buen día', '2026-10-05T16:25:14.000Z'),
  msg('m2', 'Quiero una cita para check up', '2026-10-05T16:25:19.000Z'),
  msg('m3', 'De preferencia martes en la mañana', '2026-10-05T16:25:21.000Z'),
  msg('m4', 'Soy paciente nueva', '2026-10-05T16:25:27.000Z'),
];

console.log('\nLa ráfaga que GHL no avisó\n');
const recuperados = candidatosParaIncorporar([...RAFAGA].reverse(), AHORA);
check('se recuperan los CUATRO, no solo el que trajo el webhook', recuperados.length, 4);
check('en el orden en que la paciente escribió', recuperados.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);

console.log('\nLa ventana\n');
const viejos = [msg('v1', 'Gracias', '2026-09-28T17:21:25.000Z')];
check('la conversación de la semana pasada NO se resucita', candidatosParaIncorporar([...viejos, ...RAFAGA], AHORA).length, 4);
check('dentro de la ventana entra', candidatosParaIncorporar([msg('d', 'x', new Date(AHORA - VENTANA_INCORPORACION_MS + 1000).toISOString())], AHORA).length, 1);
check('fuera de la ventana no', candidatosParaIncorporar([msg('f', 'x', new Date(AHORA - VENTANA_INCORPORACION_MS - 1000).toISOString())], AHORA).length, 0);
check('sin fecha se deja pasar (el id evita el duplicado)', candidatosParaIncorporar([msg('x', 'hola', '')], AHORA).length, 1);
check('vacío y sin adjunto se descarta', candidatosParaIncorporar([msg('y', '', '2026-10-05T16:25:20.000Z')], AHORA).length, 0);
check('foto sin pie SÍ entra (el comprobante suele llegar así)',
  candidatosParaIncorporar([msg('z', '', '2026-10-05T16:25:20.000Z', { url: 'https://x/a.jpg', kind: 'image', ext: 'jpg' })], AHORA).length, 1);

console.log('\nSolo los canales que este bot atiende\n');
check('un correo o un mensaje de Facebook NO se incorpora',
  candidatosParaIncorporar([msg('e', 'factura?', '2026-10-05T16:25:20.000Z', null, 'Email'),
                            msg('fb', 'hola', '2026-10-05T16:25:21.000Z', null, 'FB')], AHORA).length, 0);
check('WhatsApp sí', candidatosParaIncorporar([msg('w', 'hola', '2026-10-05T16:25:20.000Z')], AHORA).length, 1);

console.log('\nDuplicados: solo contra lo que entró sin id, y nunca con "contiene" (E161)\n');
const hace = (min) => new Date(AHORA - min * 60_000).toISOString();
const r = descartarYaConocidos(RAFAGA, [{ texto: 'Hola buen día', at: hace(1) }], AHORA);
check('lo que entró sin id se descarta', r.quedan.map((m) => m.id), ['m2', 'm3', 'm4']);
check('la marca usada se consume', r.restantes.length, 0);
check('una marca vencida no descarta nada', descartarYaConocidos(RAFAGA, [{ texto: 'Hola buen día', at: hace(31) }], AHORA).quedan.length, 4);
const repite = [msg('r1', 'Tiene para mañana?', '2026-10-05T16:25:20.000Z'), msg('r2', 'Tiene para mañana?', '2026-10-05T16:25:40.000Z')];
check('la paciente que repite porque no le contestaron: pasan las dos', descartarYaConocidos(repite, [], AHORA).quedan.length, 2);
check('un "sí" suelto no se tira porque la palabra ya salió',
  descartarYaConocidos([msg('s', 'si', '2026-10-05T16:25:30.000Z')], [{ texto: 'si, quiero agendar', at: hace(1) }], AHORA).quedan.length, 1);
check('una marca descarta solo UNA de dos copias', descartarYaConocidos(repite, [{ texto: 'Tiene para mañana?', at: hace(1) }], AHORA).quedan.length, 1);

console.log('\nMarcadores de media (el audio se transcribe por posición)\n');
check('audio', marcadorDeMedia('audio'), '[el contacto envió un audio]');
check('comprobante con pie: marcador primero',
  textoDeMensaje(msg('c', 'ya deposité', '2026-10-05T16:00:00.000Z', { url: 'https://x/c.jpg', kind: 'image', ext: 'jpg' })),
  '[el contacto envió una imagen]\nya deposité');
const audio = (id, iso) => msg(id, '', iso, { url: `https://x/${id}.ogg`, kind: 'audio', ext: 'ogg' });
check('dos audios quedan en orden', candidatosParaIncorporar([audio('b', '2026-10-05T16:25:30.000Z'), audio('a', '2026-10-05T16:25:20.000Z')], AHORA).map((m) => m.id), ['a', 'b']);

console.log('\nEl barrido: a quién le pregunta\n');
const t = (s) => Date.parse(`2026-10-05T${s}.000Z`);
const desde = t('17:50:00');
check('se detecta aunque el último mensaje sea del bot',
  filtrarPorInboundReciente([{ contactId: 'p', lastMessageDate: t('17:55:00'), lastMessageDirection: 'outbound', lastInboundWhatsappMessageDate: t('17:54:00') }], desde).map((c) => c.contactId), ['p']);
check('no se molesta a quien no ha escrito',
  filtrarPorInboundReciente([{ contactId: 'v', lastMessageDate: t('17:56:00'), lastMessageDirection: 'outbound', lastInboundWhatsappMessageDate: t('17:10:00') }], desde).length, 0);
check('se corta en la primera fuera de ventana',
  filtrarPorInboundReciente([
    { contactId: 'a', lastMessageDate: t('17:57:00'), lastMessageDirection: 'inbound' },
    { contactId: 'b', lastMessageDate: t('17:20:00'), lastMessageDirection: 'inbound' },
    { contactId: 'c', lastMessageDate: t('17:58:00'), lastMessageDirection: 'inbound' },
  ], desde).map((c) => c.contactId), ['a']);

console.log(fallos === 0 ? '\nTodo bien.' : `\n${fallos} fallas.`);
process.exit(fallos === 0 ? 0 : 1);
