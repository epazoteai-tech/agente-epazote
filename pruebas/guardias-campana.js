/**
 * Guardias que salieron de la primera campaña de Epazote (05/10/2026).
 *
 *   npm run test:campana
 *
 * 1. El bot de Mercado Pago repitió su mensaje ~25 veces y el nuestro le
 *    contestó todas: ahora el 4º mensaje idéntico manda al contacto a la lista
 *    negra.
 * 2. El seguimiento de 3 h no le salía a nadie porque "Solicitud recibida"
 *    (marcada AUTO:) contaba como ciclo cerrado.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x@localhost:1/x'; // no se conecta
const { esMensajeRepetidoDeBot } = require('../dist/loop-guard');
const { etapaDeCierrePorId } = require('../dist/workers/followUpWorker');
const { getConfig } = require('../dist/config');

let fallas = 0;
const check = (n, ok, extra = '') => { if (!ok) fallas++; console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ' → ' + extra}`); };

const MP = '¡Hola! ¿En qué puedo ayudarte con tu cuenta de Mercado Pago?';
const ahora = Date.parse('2026-10-05T16:46:00Z');
const h = (role, content, minAtras) => ({ role, content, ts: new Date(ahora - minAtras * 60000).toISOString() });
const hist3 = [h('user', MP, 3), h('assistant', 'Aquí es Epazote', 3), h('user', MP, 2), h('assistant', 'Ya lo tiene el equipo', 2), h('user', MP, 1), h('assistant', '👍', 1)];
check('4º mensaje idéntico de otro bot → lista negra', esMensajeRepetidoDeBot(hist3, MP, ahora) === true);
check('3º mensaje idéntico todavía no', esMensajeRepetidoDeBot(hist3.slice(0, 4), MP, ahora) === false);
const gracias = [h('user', 'gracias', 3), h('user', 'gracias', 2), h('user', 'gracias', 1)];
check('"gracias" repetido (corto) nunca bloquea', esMensajeRepetidoDeBot(gracias, 'gracias', ahora) === false);
const viejos = [h('user', MP, 120), h('user', MP, 90), h('user', MP, 60)];
check('repeticiones de hace más de 30 min no cuentan', esMensajeRepetidoDeBot(viejos, MP, ahora) === false);
const cliente = [h('user', 'Hola, quiero reservar para el sábado', 5), h('user', 'para 4 personas a las 9', 3)];
check('un cliente normal no se bloquea', esMensajeRepetidoDeBot(cliente, 'a nombre de Juan Pérez por favor', ahora) === false);

const etapas = getConfig().pipeline.stages;
const id = (n) => etapas.find((s) => s.name === n).id;
check('"Solicitud recibida" (entrada) NO es cierre → el seguimiento sí sale', etapaDeCierrePorId(id('Solicitud recibida')) === null);
check('"Reserva registrada" sí es cierre', etapaDeCierrePorId(id('Reserva registrada')) === 'Reserva registrada');
check('"Atención humana" sí es cierre', etapaDeCierrePorId(id('Atención humana')) === 'Atención humana');

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
