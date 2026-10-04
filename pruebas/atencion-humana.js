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

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
