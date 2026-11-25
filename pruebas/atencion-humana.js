/**
 * ¿Quién escribió este saliente: una persona del equipo o el celular solo?
 *
 *   npm run test:atencion
 *
 * Caso real (Epazote, 01/10/2026): el saludo automático de WhatsApp Business
 * salió en el mismo segundo que el "Buen día" del cliente, contó como persona
 * y el bot se calló 2 horas. El cliente esperó 8 y se fue a otro restaurante.
 */
const { esRespuestaAutomatica } = require('../dist/services/atencion-humana');

let fallas = 0;
const check = (n, real, esp) => {
  const ok = real === esp;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ` → ${real}`}`);
};
const t = (iso) => Date.parse(iso);
const entrantes = [t('2026-10-01T13:51:59Z'), t('2026-10-01T13:52:14Z')];

check('saludo automático en el mismo segundo → automático', esRespuestaAutomatica(t('2026-10-01T13:51:59Z'), entrantes), true);
check('a 3 segundos → automático', esRespuestaAutomatica(t('2026-10-01T13:52:17Z'), entrantes), true);
check('a 10 segundos → lo escribió una persona', esRespuestaAutomatica(t('2026-10-01T13:52:24Z'), entrantes), false);
check('la respuesta del equipo 8 horas después → persona', esRespuestaAutomatica(t('2026-10-01T22:01:29Z'), entrantes), false);
check('un saliente un minuto antes de cualquier entrante → persona', esRespuestaAutomatica(t('2026-10-01T13:50:00Z'), entrantes), false);
// Casos reales del 04/10/2026: el saludo queda registrado con la hora truncada
// al segundo, ANTES del mensaje del cliente que lo provocó.
check('saludo truncado al segundo, 0.9 s antes del cliente → automático',
  esRespuestaAutomatica(t('2026-10-04T22:14:47.000Z'), [t('2026-10-04T22:14:47.919Z')]), true);
check('saludo 2.5 s antes del cliente → automático',
  esRespuestaAutomatica(t('2026-10-04T16:39:54.000Z'), [t('2026-10-04T16:39:56.525Z')]), true);
check('respuesta del equipo 20 s después → persona',
  esRespuestaAutomatica(t('2026-10-04T16:40:28.000Z'), [t('2026-10-04T16:39:56.525Z'), t('2026-10-04T16:40:08.812Z')]), false);
check('sin entrantes → persona', esRespuestaAutomatica(t('2026-10-01T13:51:59Z'), []), false);

// 24/11/2026: GHL regresó la lista sin `meta` (sin appId) y las fotos de
// posadas con su pie, que no van al historial, contaron como persona.
const { filtrarMensajesDePersona } = require('../dist/services/atencion-humana');
const ahora = t('2026-11-25T00:25:50Z');
const lista = [
  { id: 'in1', direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: 'Tienen paquetes para posadas?', dateAdded: '2026-11-25T00:25:45.875Z' },
  { id: 'pie1', direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: 'Posadas navideñas · Desayunos · Paquete 1', dateAdded: '2026-11-24T23:41:02.107Z' },
];
check('pie de foto sin appId y sin id guardado → cuenta como persona (el caso del bug)',
  filtrarMensajesDePersona(lista, [], 'America/Monterrey', new Set(), ahora).length, 1);
check('el mismo pie con su id guardado al mandarlo → es del bot',
  filtrarMensajesDePersona(lista, [], 'America/Monterrey', new Set(['pie1']), ahora).length, 0);
check('con appId sigue siendo del bot aunque no haya id',
  filtrarMensajesDePersona([{ ...lista[1], meta: { marketplace: { appId: 'x' } } }], [], 'America/Monterrey', new Set(), ahora).length, 0);
check('un mensaje a mano del equipo sigue contando aunque haya ids del bot',
  filtrarMensajesDePersona([{ id: 'mony', direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: 'Hola, soy Mónica', dateAdded: '2026-11-25T00:10:00Z' }], [], 'America/Monterrey', new Set(['pie1']), ahora).length, 1);

// Fotos por WhatsApp: whatsapp.media, no attachments (E158).
const { armarCuerpoDeMensaje } = require('../dist/services/ghl');
const wa = armarCuerpoDeMensaje('c1', 'Posadas · Paquete 1', 'WhatsApp', ['https://x/menu/posadas-desayunos-2.jpg']);
check('WhatsApp: la foto va en whatsapp.media', wa.whatsapp && wa.whatsapp.media.url, 'https://x/menu/posadas-desayunos-2.jpg');
check('WhatsApp: tipo image y el pie como caption', `${wa.whatsapp.media.type}|${wa.whatsapp.media.caption}`, 'image|Posadas · Paquete 1');
check('WhatsApp: sin attachments', wa.attachments, undefined);
const ig = armarCuerpoDeMensaje('c1', 'pie', 'IG', ['https://x/a.jpg']);
check('Instagram sigue con attachments', ig.attachments && ig.attachments[0], 'https://x/a.jpg');
check('texto solo no lleva media', armarCuerpoDeMensaje('c1', 'hola', 'WhatsApp').whatsapp, undefined);

// "foto del menú de las posadas" no pega los PDF del menú de diario.
const { pideMenu } = require('../dist/services/reservas');
check('menú de las posadas no es el menú de diario', pideMenu('Mándame foto del menú de las posadas'), false);
check('menú navideño tampoco', pideMenu('tienen menú navideño?'), false);
check('el menú normal sí', pideMenu('me pasas el menú?'), true);

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
