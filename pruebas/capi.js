/**
 * Purchase a Meta (Conversions API): lo que se manda, sin red.
 *
 *   npm run test:capi
 *
 * Lo que más cuesta si sale mal: un teléfono mal normalizado no empata con
 * nadie (y no da error: Meta lo acepta y lo tira), y un event_id que cambie
 * entre reintentos cuenta la misma compra dos veces.
 */
const { createHash } = require('crypto');
const { telefonosParaMeta, normalizarNombre, armarEvento } = require('../dist/services/capi');

let fallas = 0;
const check = (n, real, esp) => {
  const ok = JSON.stringify(real) === JSON.stringify(esp);
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ` → ${JSON.stringify(real)} (esperado ${JSON.stringify(esp)})`}`);
};
const sha = (t) => createHash('sha256').update(t).digest('hex');

check('WhatsApp con +52', telefonosParaMeta('+52 844 123 4567'), ['528441234567', '5218441234567']);
check('WhatsApp con 521 (celular viejo)', telefonosParaMeta('+5218441234567'), ['528441234567', '5218441234567']);
check('10 dígitos se asumen de México', telefonosParaMeta('844 123 4567'), ['528441234567', '5218441234567']);
check('sin teléfono, nada', telefonosParaMeta(''), []);
check('basura corta, nada', telefonosParaMeta('123'), []);

check('nombre: minúsculas, conserva acentos (como el SDK de Meta)', normalizarNombre('  José Ángel PÉREZ. '), 'josé ángel pérez');
check('nombre: conserva la ñ', normalizarNombre('Peña'), 'peña');

const base = { consumoId: 7, reservaId: 3, total: 2350.456, telefono: '+52 844 123 4567', nombre: 'Juan Pérez', contactId: 'abc', cerradoMs: Date.parse('2026-10-03T03:00:00Z') };
const e = armarEvento(base);
check('es Purchase en tienda física', [e.event_name, e.action_source], ['Purchase', 'physical_store']);
check('event_id estable por consumo (reintentos no duplican)', e.event_id, 'epazote-consumo-7');
check('event_id igual al reconstruirlo', armarEvento(base).event_id, e.event_id);
check('valor redondeado en MXN', [e.custom_data.value, e.custom_data.currency], [2350.46, 'MXN']);
check('teléfono cifrado en sus dos formas', e.user_data.ph, [sha('528441234567'), sha('5218441234567')]);
check('nunca va el teléfono en claro', JSON.stringify(e).includes('8441234567'), false);
check('nombre y apellido cifrados aparte', [e.user_data.fn, e.user_data.ln], [[sha('juan')], [sha('pérez')]]);
check('external_id cifrado', e.user_data.external_id, [sha('abc')]);
check('event_time en segundos', e.event_time, Date.parse('2026-10-03T03:00:00Z') / 1000);
check('walk-in sin teléfono: no se manda', armarEvento({ ...base, telefono: '' }), null);

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
